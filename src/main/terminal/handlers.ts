import { BrowserWindow, dialog, shell } from 'electron'
import { existsSync } from 'fs'
import type { HandlersOf } from '../../shared/api'
import type { TerminalApi, TerminalInfo } from '../../shared/features/terminal'
import { systemOpenAction } from '../paths'
import { loadState, requireRepo, updateSettings } from '../store'
import {
  agentBranchName,
  agentSessions,
  detectAgents,
  endAgentSession,
  resumeAgentSession,
  startAgentSession
} from './agents'
import { tokenizeCommand } from './argv'
import {
  killTerminal,
  listTerminals,
  nextTitle,
  requireTerminal,
  resizeTerminal,
  snapshot,
  spawnTerminal,
  writeTerminal
} from './pty'
import { defaultShell, findExecutable, launchPlan, shellTitle, userPath } from './resolve'
import {
  addWorktree,
  listWorktrees,
  openWorktree,
  pruneWorktrees,
  removeWorktree,
  requireWorktree
} from './worktrees'

const WINDOWS = process.platform === 'win32'

function size(value: unknown, max: number, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback
}

function requireSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = Number(cols)
  const r = Number(rows)
  if (!Number.isInteger(c) || !Number.isInteger(r) || c < 2 || r < 1 || c > 2000 || r > 1000)
    throw new Error('Invalid terminal size')
  return { cols: c, rows: r }
}

/** The configured shell (Settings.terminalShell), else PowerShell / $SHELL. */
async function shellCommand(): Promise<{ argv: string[]; messages: string[] }> {
  const path = await userPath()
  const configured = loadState().settings.terminalShell
  if (configured) {
    try {
      const argv = tokenizeCommand(configured, WINDOWS)
      const program = argv[0] ? findExecutable(argv[0], path) : null
      if (program) return { argv: [program, ...argv.slice(1)], messages: [] }
      return {
        argv: defaultShell(path),
        messages: [`"${argv[0] ?? configured}" was not found: using the default shell instead.`]
      }
    } catch (e) {
      return { argv: defaultShell(path), messages: [(e as Error).message] }
    }
  }
  return { argv: defaultShell(path), messages: [] }
}

async function createShellTerminal(
  cwdArg: unknown,
  cols: unknown,
  rows: unknown
): Promise<TerminalInfo> {
  const cwd = requireRepo(cwdArg)
  if (!existsSync(cwd)) throw new Error(`${cwd} does not exist`)
  const { argv, messages } = await shellCommand()
  const path = await userPath()
  const plan = launchPlan(argv[0], argv.slice(1), path)
  if (!plan) throw new Error(`${argv[0]} cannot be started with these arguments`)
  return spawnTerminal({
    cwd,
    cols: size(cols, 2000, 80),
    rows: size(rows, 1000, 24),
    title: nextTitle(cwd, shellTitle(argv[0])),
    kind: 'shell',
    sessionId: null,
    file: plan.file,
    args: plan.args,
    env: {},
    messages
  })
}

async function pickFolder(title: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = { title, properties: ['openDirectory' as const, 'createDirectory' as const] }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
}

/** IPC handlers for built-in terminal, worktrees and coding-agent sessions. */
export const terminalHandlers: HandlersOf<TerminalApi> = {
  terminalCreate: (cwd, cols, rows) => createShellTerminal(cwd, cols, rows),
  terminalWrite: (id, data) => {
    if (typeof data !== 'string') throw new Error('Invalid input')
    writeTerminal(requireTerminal(id).info.id, data)
  },
  terminalResize: (id, cols, rows) => {
    const s = requireSize(cols, rows)
    resizeTerminal(requireTerminal(id).info.id, s.cols, s.rows)
  },
  terminalKill: (id) => killTerminal(requireTerminal(id).info.id),
  terminalList: (cwd) => {
    if (cwd !== null && typeof cwd !== 'string') throw new Error('Invalid folder')
    return listTerminals(cwd)
  },
  terminalSnapshot: (id) => snapshot(requireTerminal(id).info.id),

  worktrees: (repo) => listWorktrees(requireRepo(repo)),
  addWorktree: (repo, options) => addWorktree(repo, options),
  removeWorktree: (repo, path, force) => removeWorktree(repo, path, force === true),
  pruneWorktrees: (repo) => pruneWorktrees(repo),
  openWorktree: (repo, path) => openWorktree(repo, path),
  showWorktreeFolder: async (repo, path) => {
    const wt = await requireWorktree(requireRepo(repo), path)
    if (!existsSync(wt.path)) throw new Error(`${wt.path} no longer exists`)
    // A folder that could launch (a macOS app bundle, a name like a program) is only shown.
    if (systemOpenAction(wt.path) === 'reveal') {
      shell.showItemInFolder(wt.path)
      return
    }
    const error = await shell.openPath(wt.path)
    if (error) throw new Error(error)
  },
  pickWorktreeRoot: async () => {
    const folder = await pickFolder('Folder for new worktrees')
    return folder ? updateSettings({ worktreeRoot: folder }) : loadState()
  },

  detectAgents: () => detectAgents(),
  agentBranchName: (repo, task) => agentBranchName(repo, task),
  startAgentSession: (options) => startAgentSession(options),
  agentSessions: () => agentSessions(),
  resumeAgentSession: (id) => resumeAgentSession(id),
  endAgentSession: (id, options) => endAgentSession(id, options)
}
