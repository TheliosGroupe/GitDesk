// Pure helpers for launching terminals and coding agents (no Electron, no I/O):
// command-line tokenizing, Windows argument quoting, npm .cmd shim unwrapping,
// agent argv building and `git worktree list --porcelain` parsing.

import type { AgentKind } from '../../shared/types'

/**
 * Splits a configured command line ("claude --model opus", `"C:\Program Files\x\x.exe" -i`)
 * into argv. Quotes group words; nothing is expanded (no variables, globs or operators):
 * the result is passed to the program as is, never to a shell. On Windows backslashes are
 * literal (paths); elsewhere a backslash escapes the next character outside single quotes.
 */
export function tokenizeCommand(line: string, windows: boolean): string[] {
  const out: string[] = []
  let current = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && !windows && quote === '"' && i + 1 < line.length) {
        const next = line[i + 1]
        if (next === '"' || next === '\\') {
          current += next
          i++
        } else current += c
      } else current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (c === '\\' && !windows && i + 1 < line.length) {
      current += line[++i]
      inWord = true
    } else if (/\s/.test(c)) {
      if (inWord) out.push(current)
      current = ''
      inWord = false
    } else {
      current += c
      inWord = true
    }
  }
  if (quote) throw new Error(`Unclosed ${quote} in command: ${line}`)
  if (inWord) out.push(current)
  return out
}

/**
 * Quotes one argument for a Windows command line, so that the program's C runtime
 * (CommandLineToArgvW rules) reads it back exactly: quotes are escaped, backslashes
 * before a quote are doubled. node-pty's own quoting guesses from enclosing quotes,
 * which splits an argument like `"a b"`, so GitDesk builds the command line itself.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const c of arg) {
    if (c === '\\') {
      slashes++
      continue
    }
    if (c === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"'
    } else {
      out += '\\'.repeat(slashes) + c
    }
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}

export function windowsCommandLine(args: string[]): string {
  return args.map(quoteWindowsArg).join(' ')
}

/** What an npm/cmd-shim `.cmd` file runs: a native program, or a script run by node. */
export type CmdShim = { kind: 'exe'; target: string } | { kind: 'node'; script: string }

/**
 * Reads the program behind an npm `.cmd` shim (cmd-shim), e.g.
 * `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*` or
 * `"%_prog%"  "%dp0%\node_modules\x\cli.js" %*`. Paths are relative to the shim's folder.
 * Returns null for anything else: such a batch file cannot be given arbitrary arguments
 * safely (cmd.exe re-parses them).
 */
export function parseCmdShim(content: string): CmdShim | null {
  const lines = content.split(/\r?\n/).filter((l) => /%\*\s*$/.test(l))
  const line = lines[lines.length - 1]
  if (!line) return null
  const m = /"%dp0%\\([^"%]+)"\s+%\*\s*$/.exec(line)
  if (!m) return null
  const target = m[1]
  if (/(^|\\)\.\.(\\|$)/.test(target)) return null
  if (/"%_prog%"\s+"%dp0%\\/.test(line)) return { kind: 'node', script: target }
  if (/\.(exe|com)$/i.test(target)) return { kind: 'exe', target }
  return null
}

/**
 * Arguments that survive `cmd.exe /c` unchanged when quoted: no quotes, %, !, ^, &, |, <, >,
 * newlines. Anything else is never passed to a batch file (see "BatBadBut").
 */
export function isCmdSafeArg(arg: string): boolean {
  return /^[A-Za-z0-9 _.,:;/\\@#+=~()[\]{}$'-]*$/.test(arg)
}

/** Command line for `cmd.exe /d /s /c` running a batch file with already-checked args. */
export function cmdCommandLine(batch: string, args: string[]): string {
  return `/d /s /c "${[batch, ...args].map((a) => `"${a}"`).join(' ')}"`
}

/** Flag before the task text, per agent CLI (none = a positional prompt). */
export const AGENT_PROMPT_FLAGS: Record<AgentKind, string[]> = {
  claude: [],
  codex: [],
  gemini: ['--prompt-interactive'],
  copilot: ['--interactive'],
  opencode: ['--prompt'],
  custom: []
}

/** Agents whose CLI takes the task as a positional argument and accepts "--" before it. */
const END_OF_OPTIONS = new Set<AgentKind>(['claude', 'codex'])

/** Arguments that continue the previous conversation, for agents that have one. */
export const AGENT_RESUME_ARGS: Record<AgentKind, string[]> = {
  claude: ['--continue'],
  codex: ['resume', '--last'],
  gemini: [],
  copilot: [],
  opencode: ['--continue'],
  custom: []
}

/** Placeholder a configured command can use to put the task somewhere else than last. */
export const TASK_PLACEHOLDER = '{task}'

/**
 * argv of an agent launch. The task is one argument (never parsed by a shell): it replaces
 * a `{task}` token of the command, or is appended after the agent's prompt flag.
 * Resuming runs the command with the agent's "continue" arguments instead of the task.
 */
export function buildAgentArgv(
  kind: AgentKind,
  commandLine: string,
  task: string | null,
  windows: boolean
): string[] {
  const tokens = tokenizeCommand(commandLine, windows)
  if (!tokens.length) throw new Error('No command configured for this agent')
  const hasPlaceholder = tokens.includes(TASK_PLACEHOLDER)
  if (task === null) {
    const rest = tokens.filter((t) => t !== TASK_PLACEHOLDER)
    return hasPlaceholder ? rest : [...rest, ...AGENT_RESUME_ARGS[kind]]
  }
  if (hasPlaceholder) return tokens.map((t) => (t === TASK_PLACEHOLDER ? task : t))
  const flags = AGENT_PROMPT_FLAGS[kind]
  // A task starting with "-" must not read as an option: "--" ends the options of claude
  // (commander) and codex (clap); a flag's value is attached with "=" (yargs, commander).
  if (!flags.length) return END_OF_OPTIONS.has(kind) ? [...tokens, '--', task] : [...tokens, task]
  if (task.startsWith('-'))
    return [...tokens, ...flags.slice(0, -1), `${flags[flags.length - 1]}=${task}`]
  return [...tokens, ...flags, task]
}

// ---------------------------------------------------------------------------
// git worktree list --porcelain
// ---------------------------------------------------------------------------

export interface RawWorktree {
  path: string
  head: string
  branch: string | null
  bare: boolean
  detached: boolean
  locked: boolean
  lockReason: string | null
  prunable: boolean
}

export function parseWorktreePorcelain(out: string): RawWorktree[] {
  const result: RawWorktree[] = []
  for (const block of out.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean)
    if (!lines[0]?.startsWith('worktree ')) continue
    const wt: RawWorktree = {
      path: lines[0].slice('worktree '.length),
      head: '',
      branch: null,
      bare: false,
      detached: false,
      locked: false,
      lockReason: null,
      prunable: false
    }
    for (const line of lines.slice(1)) {
      const [key, ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'HEAD') wt.head = value
      else if (key === 'branch') wt.branch = value.replace(/^refs\/heads\//, '')
      else if (key === 'bare') wt.bare = true
      else if (key === 'detached') wt.detached = true
      else if (key === 'locked') {
        wt.locked = true
        wt.lockReason = value || null
      } else if (key === 'prunable') wt.prunable = true
    }
    result.push(wt)
  }
  return result
}

/** "name", "name-2", "name-3"…: the first one `taken` says is free. */
export function uniqueName(base: string, taken: (candidate: string) => boolean): string {
  if (!taken(base)) return base
  for (let i = 2; i < 1000; i++) {
    if (!taken(`${base}-${i}`)) return `${base}-${i}`
  }
  throw new Error(`No free name for ${base}`)
}
