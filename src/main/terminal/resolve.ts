// Finding programs on PATH and deciding how node-pty starts them.

import { execFile } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, delimiter, dirname, extname, isAbsolute, join } from 'path'
import {
  cmdCommandLine,
  isCmdSafeArg,
  parseCmdShim,
  windowsCommandLine,
  type CmdShim
} from './argv'

const WINDOWS = process.platform === 'win32'

let pathPromise: Promise<string> | null = null

/**
 * PATH as the user's shell sees it. Apps started from the Dock / a desktop launcher on
 * macOS and Linux get a minimal PATH, without ~/.local/bin, Homebrew or npm's global
 * folder, so it is read once from a login shell.
 */
export function userPath(): Promise<string> {
  const fallback = process.env.PATH ?? ''
  if (WINDOWS) return Promise.resolve(fallback)
  pathPromise ??= new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/bash'
    const marker = '__GITDESK_PATH__'
    execFile(
      shell,
      ['-ilc', `printf '${marker}%s${marker}' "$PATH"`],
      { timeout: 4000, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' } },
      (_error, stdout) => {
        const m = new RegExp(`${marker}(.*)${marker}`, 's').exec(stdout ?? '')
        const found = m?.[1]?.trim()
        if (!found) return resolve(fallback)
        // Keep entries only the app's PATH had (e.g. set by a launcher).
        const parts = [...found.split(delimiter), ...fallback.split(delimiter)].filter(Boolean)
        resolve([...new Set(parts)].join(delimiter))
      }
    )
  })
  return pathPromise
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function windowsExtensions(): string[] {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^\.[a-z0-9]+$/.test(e))
  // Only what CreateProcess (directly or through cmd.exe) can start.
  return exts.filter((e) => ['.com', '.exe', '.bat', '.cmd'].includes(e))
}

/**
 * Absolute path of a program: an absolute path as is, or a bare name searched on PATH
 * (with PATHEXT on Windows). Relative paths and the current folder are never searched,
 * so a repository cannot plant a `claude.cmd` that GitDesk would run.
 */
export function findExecutable(name: string, pathEnv: string): string | null {
  if (!name) return null
  const candidates = (base: string): string[] => {
    if (!WINDOWS) return [base]
    const ext = extname(base).toLowerCase()
    if (ext && windowsExtensions().includes(ext)) return [base]
    return windowsExtensions().map((e) => base + e)
  }
  if (isAbsolute(name)) return candidates(name).find(isFile) ?? null
  if (/[\\/]/.test(name)) return null
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const found = candidates(join(dir, name)).find((c) => {
      if (!isFile(c)) return false
      if (WINDOWS) return true
      try {
        // Executable by someone: good enough (the spawn reports a permission error).
        return (statSync(c).mode & 0o111) !== 0
      } catch {
        return false
      }
    })
    if (found) return found
  }
  return null
}

function readShim(program: string): CmdShim | null {
  try {
    return parseCmdShim(readFileSync(program, 'utf8'))
  } catch {
    return null
  }
}

export interface LaunchPlan {
  file: string
  /** argv (POSIX) or a ready Windows command line. */
  args: string[] | string
}

/**
 * How node-pty starts `program` (absolute, from findExecutable) with `args`.
 * - POSIX: the program with an argv array (no shell).
 * - Windows .exe: a command line quoted by quoteWindowsArg.
 * - Windows npm `.cmd` shims (how most agent CLIs are installed): the program the shim
 *   would run (its .exe, or node + its script) is started directly, so cmd.exe never
 *   parses the task.
 * - Other batch files: through `cmd.exe /d /s /c` only when every argument is cmd-safe;
 *   otherwise null (the caller drops the unsafe argument and says so).
 */
export function launchPlan(program: string, args: string[], pathEnv: string): LaunchPlan | null {
  if (!WINDOWS) return { file: program, args }
  const ext = extname(program).toLowerCase()
  if (ext !== '.cmd' && ext !== '.bat') return { file: program, args: windowsCommandLine(args) }

  const shim = readShim(program)
  const dir = dirname(program)
  if (shim?.kind === 'exe' && isFile(join(dir, shim.target))) {
    return { file: join(dir, shim.target), args: windowsCommandLine(args) }
  }
  if (shim?.kind === 'node' && isFile(join(dir, shim.script))) {
    const local = join(dir, 'node.exe')
    const node = isFile(local) ? local : findExecutable('node', pathEnv)
    if (node) return { file: node, args: windowsCommandLine([join(dir, shim.script), ...args]) }
  }
  if (!isCmdSafeArg(program) || !args.every(isCmdSafeArg)) return null
  const cmd = process.env.ComSpec && isFile(process.env.ComSpec) ? process.env.ComSpec : 'cmd.exe'
  return { file: cmd, args: cmdCommandLine(program, args) }
}

/** The shell for new terminals: Settings.terminalShell, else the platform default. */
export function defaultShell(pathEnv: string): string[] {
  if (WINDOWS) {
    const pwsh = findExecutable('pwsh', pathEnv)
    if (pwsh) return [pwsh, '-NoLogo']
    const root = process.env.SystemRoot || 'C:\\Windows'
    const ps = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return [existsSync(ps) ? ps : 'powershell.exe', '-NoLogo']
  }
  const shell = process.env.SHELL
  if (shell && isAbsolute(shell) && existsSync(shell)) return [shell, '-l']
  return ['/bin/bash', '-l']
}

/** Display name of a shell program: "PowerShell", "Command Prompt", "bash"… */
export function shellTitle(program: string): string {
  const name = basename(program)
    .replace(/\.(exe|cmd|bat|com)$/i, '')
    .toLowerCase()
  if (name === 'pwsh' || name === 'powershell') return 'PowerShell'
  if (name === 'cmd') return 'Command Prompt'
  if (name === 'wsl') return 'WSL'
  return name || 'Terminal'
}
