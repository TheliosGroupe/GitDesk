// Contract: Built-in terminal, worktrees and coding-agent sessions.
// Methods are implemented in src/main/terminal/handlers.ts; events are pushed with
// emit() from src/main/events.ts and received with window.api.on(channel, listener).

import type { AgentKind, AgentSession, AppState } from '../types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TerminalInfo {
  id: string
  /** Folder the terminal runs in (a registered repository or worktree). */
  cwd: string
  /** Tab title, e.g. "PowerShell 1" or "Claude Code". */
  title: string
  kind: 'shell' | 'agent'
  /** Agent session this terminal belongs to, if any. */
  sessionId: string | null
  running: boolean
  /** Exit code once the process ended (null while running). */
  exitCode: number | null
  /** Unix milliseconds. */
  createdAt: number
}

export interface TerminalSnapshot {
  info: TerminalInfo
  /** The last ~200 KB of output, to repaint a re-mounted view. */
  data: string
  /** Output position at the end of `data` (see TerminalDataEvent.seq). */
  seq: number
}

export interface TerminalDataEvent {
  id: string
  data: string
  /**
   * Output position (characters since the terminal started) at the end of this chunk.
   * A view restored from a snapshot skips what it already got: chunks with seq <= snapshot.seq.
   */
  seq: number
}

export interface Worktree {
  path: string
  /** Commit checked out (empty for a bare entry). */
  head: string
  /** Short branch name, or null when detached. */
  branch: string | null
  detached: boolean
  locked: boolean
  lockReason: string | null
  /** The folder is gone; `git worktree prune` would forget it. */
  prunable: boolean
  /** The repository's main working tree (cannot be removed). */
  isMain: boolean
  /** The worktree the request was made from. */
  isCurrent: boolean
  /** Uncommitted changes (lines of `git status --porcelain`); null when unknown. */
  changes: number | null
}

export interface AddWorktreeOptions {
  /** Branch to check out (existing) or to create (createBranch). */
  branch: string
  createBranch: boolean
  /** Start point of a new branch; null = the current HEAD. */
  startPoint: string | null
  /** Absolute folder; null = the default location (see Settings.worktreeRoot). */
  path: string | null
}

export interface AgentInfo {
  kind: AgentKind
  /** Display name, e.g. "Claude Code". */
  label: string
  /** Command line used to launch it (configured, else built-in default; '' = none). */
  command: string
  /** Built-in default command ('' for custom). */
  defaultCommand: string
  /** Absolute path of the program found on PATH, or null. */
  resolved: string | null
  /** How to install it, shown when it is missing. */
  installHint: string
}

export interface StartAgentOptions {
  repo: string
  task: string
  agent: AgentKind
  /** Branch to create; omitted = agent/<slug of the task>, made unique. */
  branch?: string
  /** Where the branch starts; omitted = the repository's current branch (or HEAD). */
  baseRef?: string
}

export interface AgentSessionInfo extends AgentSession {
  /** Base the branch started from (stored in git config branch.<name>.gitdeskBase). */
  base: string | null
  /** Live terminal of the session, if one exists in this run of GitDesk. */
  terminalId: string | null
  running: boolean
  worktreeExists: boolean
  branchExists: boolean
  /** Commits on the branch not in base / in base not on the branch. */
  ahead: number
  behind: number
  /** Uncommitted changes in the worktree; null when unknown. */
  changes: number | null
  lastCommit: string | null
}

export interface EndAgentSessionOptions {
  removeWorktree: boolean
  deleteBranch: boolean
  /** Remove the worktree even with uncommitted changes. */
  discardChanges?: boolean
  /** Delete the branch even with commits that are not in its base, HEAD or upstream. */
  discardUnmerged?: boolean
}

export type EndAgentSessionResult =
  | { ended: true; state: AppState }
  | {
      /** Nothing was changed: confirm again with the matching discard option. */
      ended: false
      /** Uncommitted changes the removal would lose (null = could not be counted). */
      changes: number | null
      /** Commits the branch deletion would lose (null = unknown: the base is missing). */
      unmergedCommits: number | null
      base: string | null
    }

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface TerminalApi {
  // Terminals
  /** Starts the configured shell in a registered repository / worktree folder. */
  terminalCreate(cwd: string, cols: number, rows: number): TerminalInfo
  /** Sends keyboard input to the terminal. */
  terminalWrite(id: string, data: string): void
  terminalResize(id: string, cols: number, rows: number): void
  /** Ends the process (if still running) and forgets the terminal. */
  terminalKill(id: string): void
  /** Terminals of one folder, or every terminal (null), oldest first. */
  terminalList(cwd: string | null): TerminalInfo[]
  /** Recent output of a terminal, to restore a view. */
  terminalSnapshot(id: string): TerminalSnapshot

  // Worktrees
  worktrees(repo: string): Worktree[]
  addWorktree(repo: string, options: AddWorktreeOptions): { state: AppState; path: string }
  /** Refuses the main worktree, and one with changes unless `force`. Also closes its tab. */
  removeWorktree(repo: string, path: string, force: boolean): AppState
  pruneWorktrees(repo: string): void
  /** Registers a worktree of `repo` as a repository (to open it in a tab). */
  openWorktree(repo: string, path: string): AppState
  /** Shows a worktree folder of `repo` in Explorer / Finder. */
  showWorktreeFolder(repo: string, path: string): void
  /** Folder picker for Settings.worktreeRoot. */
  pickWorktreeRoot(): AppState

  // Agent sessions
  /** Which agents are configured and found on PATH. */
  detectAgents(): AgentInfo[]
  /** Branch name a new session would get for this task (unique in the repository). */
  agentBranchName(repo: string, task: string): string
  /** New branch + worktree + agent terminal. */
  startAgentSession(options: StartAgentOptions): {
    session: AgentSession
    state: AppState
    terminalId: string
  }
  agentSessions(): AgentSessionInfo[]
  /** Starts the agent again in the session's worktree (the running terminal if there is one). */
  resumeAgentSession(id: string): { terminalId: string }
  /**
   * Ends the session. Uncommitted changes in the worktree and commits only the branch has are
   * kept unless discardChanges / discardUnmerged say otherwise: the answer then lists them
   * and nothing is changed.
   */
  endAgentSession(id: string, options: EndAgentSessionOptions): EndAgentSessionResult
}

export const TERMINAL_METHODS = [
  'terminalCreate',
  'terminalWrite',
  'terminalResize',
  'terminalKill',
  'terminalList',
  'terminalSnapshot',
  'worktrees',
  'addWorktree',
  'removeWorktree',
  'pruneWorktrees',
  'openWorktree',
  'showWorktreeFolder',
  'pickWorktreeRoot',
  'detectAgents',
  'agentBranchName',
  'startAgentSession',
  'agentSessions',
  'resumeAgentSession',
  'endAgentSession'
] as const satisfies readonly (keyof TerminalApi)[]

export interface TerminalEvents {
  /** Output of a terminal (batched, ~16 ms). */
  'terminal:data': TerminalDataEvent
  'terminal:exit': { id: string; exitCode: number }
  /** A terminal was created or removed in `cwd` (e.g. an agent terminal). */
  'terminal:list': { cwd: string }
  /** Agent sessions were started, resumed, ended, or their terminal exited. */
  'agents:changed': null
}

export const TERMINAL_EVENTS = [
  'terminal:data',
  'terminal:exit',
  'terminal:list',
  'agents:changed'
] as const satisfies readonly (keyof TerminalEvents)[]

// ---------------------------------------------------------------------------
// Pure helpers shared by main and renderer
// ---------------------------------------------------------------------------

export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot CLI',
  opencode: 'opencode',
  custom: 'Custom agent'
}

export const DEFAULT_AGENT_COMMANDS: Record<AgentKind, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  copilot: 'copilot',
  opencode: 'opencode',
  custom: ''
}

/** Folder-safe slug of a branch name: "feature/login" -> "feature-login". */
export function branchSlug(branch: string): string {
  const slug = branch
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .replace(/[-.]+$/, '')
  return slug || 'worktree'
}

/** Short branch-name slug of a task: "Fix the login bug!" -> "fix-the-login-bug". */
export function taskSlug(task: string): string {
  const words = task
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  let slug = ''
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w
    if (next.length > 40) break
    slug = next
    if (slug.split('-').length >= 6) break
  }
  return slug || (words[0] ? words[0].slice(0, 40) : 'task')
}
