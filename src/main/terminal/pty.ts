// Terminals: node-pty processes in the main process, streamed to the UI in batches.

import { app } from 'electron'
import { randomUUID } from 'crypto'
import type { IPty } from 'node-pty'
import { isAbsolute } from 'path'
import type { TerminalInfo, TerminalSnapshot } from '../../shared/features/terminal'
import { emit } from '../events'
import { pathKey } from '../paths'

/** Output kept per terminal so a re-mounted view can repaint (TerminalSnapshot). */
const SCROLLBACK_CHARS = 200_000
/** Output is sent to the UI at most this often, so a busy program does not flood IPC. */
const FLUSH_MS = 16
const FLUSH_CHARS = 64_000

interface Term {
  info: TerminalInfo
  /** pathKey of info.cwd, worked out once (lookups by folder need no file system call each). */
  cwdKey: string
  proc: IPty | null
  /** Settles once the process has exited (at once when there is none). */
  ended: Promise<void>
  markEnded: () => void
  buffer: string
  /** Characters produced so far (TerminalDataEvent.seq). */
  seq: number
  pending: string
  timer: NodeJS.Timeout | null
}

const terms = new Map<string, Term>()
let quitHooked = false

type PtyModule = typeof import('node-pty')
let ptyModule: Promise<PtyModule> | null = null

function loadPty(): Promise<PtyModule> {
  // Loaded on first use: a broken native module only disables the terminal, not the app.
  ptyModule ??= import('node-pty')
  return ptyModule
}

function hookQuit(): void {
  if (quitHooked) return
  quitHooked = true
  app.on('before-quit', killAllTerminals)
}

function flush(t: Term): void {
  if (t.timer) clearTimeout(t.timer)
  t.timer = null
  if (!t.pending) return
  const data = t.pending
  t.pending = ''
  emit('terminal:data', { id: t.info.id, data, seq: t.seq })
}

function output(t: Term, data: string): void {
  t.seq += data.length
  t.buffer += data
  if (t.buffer.length > SCROLLBACK_CHARS * 1.25) {
    let cut = t.buffer.length - SCROLLBACK_CHARS
    // Start the kept part at a line start when one is close, not mid escape sequence.
    const nl = t.buffer.indexOf('\n', cut)
    if (nl !== -1 && nl - cut < 4096) cut = nl + 1
    t.buffer = t.buffer.slice(cut)
  }
  t.pending += data
  if (t.pending.length >= FLUSH_CHARS) flush(t)
  else t.timer ??= setTimeout(() => flush(t), FLUSH_MS)
}

/** Writes a GitDesk message into a terminal (yellow, on its own lines). */
export function notice(id: string, text: string): void {
  const t = terms.get(id)
  if (t) output(t, `\x1b[33m${text.replace(/\r?\n/g, '\r\n')}\x1b[0m\r\n`)
}

function exited(t: Term, exitCode: number): void {
  t.markEnded()
  if (!t.info.running) return
  t.info.running = false
  t.info.exitCode = exitCode
  t.proc = null
  flush(t)
  emit('terminal:exit', { id: t.info.id, exitCode })
  if (t.info.sessionId) emit('agents:changed', null)
}

export interface SpawnOptions {
  cwd: string
  cols: number
  rows: number
  title: string
  kind: TerminalInfo['kind']
  sessionId: string | null
  /** Program to run; null = no process (only `messages` are shown, e.g. program missing). */
  file: string | null
  args: string[] | string
  env: Record<string, string>
  /** Shown before the program's output. */
  messages?: string[]
}

function environment(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  // Electron's own switches must not leak into programs started from the terminal.
  for (const k of Object.keys(env)) {
    if (/^ELECTRON_(RUN_AS_NODE|NO_ATTACH_CONSOLE|ENABLE_LOGGING)$/i.test(k)) delete env[k]
  }
  if (process.platform !== 'win32') env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'GitDesk'
  return { ...env, ...extra }
}

export async function spawnTerminal(o: SpawnOptions): Promise<TerminalInfo> {
  hookQuit()
  const info: TerminalInfo = {
    id: randomUUID(),
    cwd: o.cwd,
    title: o.title,
    kind: o.kind,
    sessionId: o.sessionId,
    running: true,
    exitCode: null,
    createdAt: Date.now()
  }
  const cwdKey = pathKey(o.cwd)
  let markEnded = (): void => {}
  const ended = new Promise<void>((resolve) => (markEnded = resolve))
  const t: Term = {
    info,
    cwdKey,
    proc: null,
    ended,
    markEnded,
    buffer: '',
    seq: 0,
    pending: '',
    timer: null
  }
  terms.set(info.id, t)
  for (const m of o.messages ?? []) notice(info.id, m)

  if (o.file) {
    try {
      const pty = await loadPty()
      const proc = pty.spawn(o.file, o.args, {
        name: 'xterm-256color',
        cols: o.cols,
        rows: o.rows,
        cwd: o.cwd,
        env: environment(o.env),
        ...(process.platform === 'win32' ? {} : { encoding: 'utf8' })
      })
      t.proc = proc
      proc.onData((data) => output(t, data))
      proc.onExit(({ exitCode }) => exited(t, exitCode))
    } catch (e) {
      notice(info.id, `Could not start ${o.file}: ${e instanceof Error ? e.message : String(e)}`)
      exited(t, -1)
    }
  } else {
    exited(t, -1)
  }
  emit('terminal:list', { cwd: o.cwd })
  return { ...info }
}

export function requireTerminal(id: unknown): Term {
  const t = typeof id === 'string' ? terms.get(id) : undefined
  if (!t) throw new Error('This terminal no longer exists')
  return t
}

export function writeTerminal(id: string, data: string): void {
  const t = requireTerminal(id)
  if (typeof data !== 'string' || data.length > 1_000_000) throw new Error('Invalid input')
  t.proc?.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const t = requireTerminal(id)
  try {
    t.proc?.resize(cols, rows)
  } catch {
    // The process just exited.
  }
}

function stop(t: Term): void {
  if (t.timer) clearTimeout(t.timer)
  t.timer = null
  try {
    t.proc?.kill()
  } catch {
    // Already gone.
  }
  t.proc = null
}

export function killTerminal(id: string): void {
  const t = requireTerminal(id)
  stop(t)
  terms.delete(id)
  emit('terminal:list', { cwd: t.info.cwd })
  if (t.info.sessionId) emit('agents:changed', null)
}

/** Ends every terminal (app quit). */
export function killAllTerminals(): void {
  for (const t of terms.values()) stop(t)
  terms.clear()
}

/** Whether a terminal runs in `cwd` (any name of the folder; see samePath). */
function inFolder(cwd: string): (t: Term) => boolean {
  const key = isAbsolute(cwd) ? pathKey(cwd) : null
  return (t) => t.info.cwd === cwd || (key !== null && t.cwdKey === key)
}

/** Longest wait for the terminals of a folder to end (killTerminalsIn). */
const END_WAIT_MS = 5000

/**
 * Ends the terminals running in a folder (before its worktree is removed) and waits until
 * their processes have exited, END_WAIT_MS at most: on Windows a running process keeps its
 * working folder from being deleted, and a shell can take a while to end on a busy machine.
 */
export async function killTerminalsIn(cwd: string): Promise<void> {
  const inCwd = inFolder(cwd)
  const ending: Promise<void>[] = []
  for (const t of [...terms.values()]) {
    if (!inCwd(t)) continue
    ending.push(t.ended)
    killTerminal(t.info.id)
  }
  if (!ending.length) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.all(ending),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, END_WAIT_MS)))
  ])
  clearTimeout(timer)
}

export function killSessionTerminals(sessionId: string): void {
  for (const t of [...terms.values()]) if (t.info.sessionId === sessionId) killTerminal(t.info.id)
}

export function listTerminals(cwd: string | null): TerminalInfo[] {
  return [...terms.values()]
    .filter(cwd === null ? () => true : inFolder(cwd))
    .map((t) => ({ ...t.info }))
}

/** Latest terminal of an agent session. */
export function sessionTerminal(sessionId: string): TerminalInfo | null {
  const list = [...terms.values()].filter((t) => t.info.sessionId === sessionId)
  return list.length ? { ...list[list.length - 1].info } : null
}

export function snapshot(id: string): TerminalSnapshot {
  const t = requireTerminal(id)
  // Whatever is still waiting goes out first; the view skips it by seq.
  flush(t)
  return { info: { ...t.info }, data: t.buffer, seq: t.seq }
}

/** Lowest free number for a title in a folder: "PowerShell 1", "PowerShell 2"… */
export function nextTitle(cwd: string, base: string): string {
  const used = new Set(
    listTerminals(cwd)
      .map((t) =>
        t.title.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`))
      )
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => Number(m[1]))
  )
  let n = 1
  while (used.has(n)) n++
  return `${base} ${n}`
}
