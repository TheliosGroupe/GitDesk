import { app, dialog } from 'electron'
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'fs'
import { homedir } from 'os'
import { basename, isAbsolute, join, resolve } from 'path'
import { readBranchColors } from '../shared/branchColors'
import type { AgentKind, AgentSession, AppState, Settings, Workspace } from '../shared/types'
import { canonicalPath, findStoredPath, samePath, textKey } from './paths'

export { samePath }

export const DEFAULT_SETTINGS: Settings = {
  githubClientId: '',
  cloneRoot: join(homedir(), 'repos'),
  fetchIntervalMinutes: 5,
  showAvatars: true,
  useGravatar: true,
  theme: 'dark',
  editor: 'vscode',
  autoUpdate: true,
  aiProvider: 'none',
  aiModel: '',
  aiBaseUrl: '',
  agentCommands: {},
  worktreeRoot: '',
  terminalShell: '',
  branchColors: { dark: [], light: [], rules: [] }
}

const AGENT_KINDS: AgentKind[] = ['claude', 'codex', 'gemini', 'copilot', 'opencode', 'custom']
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v.trim() : fallback)

let state: AppState | null = null
/** Repository path -> trust record (see trust/policy.ts); kept out of AppState (main only). */
let trust: Record<string, string> = {}

function file(): string {
  return join(app.getPath('userData'), 'gitdesk.json')
}

/** Files that could not be read this session: never replaced until GitDesk restarts. */
const unreadable = new Set<string>()
const storeKey = (path: string): string =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Reads a JSON settings file. A missing file gives `fallback`. One whose content cannot
 * be parsed (a hand edit with a typo, a torn write) is first moved aside to
 * `<name>.corrupt-<time>`, so the next save cannot overwrite it, and the user is told
 * where it went; then `fallback` is used. A file that cannot be read at all (held open
 * by another program, no permission) is tried again briefly; if it still fails, it is
 * left as it is and writeJsonAtomic does not replace it this session. For every store
 * in the user-data folder.
 */
export function readJsonStore(path: string, fallback: unknown): unknown {
  let text: string | null = null
  for (let attempt = 1; text === null; attempt++) {
    try {
      text = readFileSync(path, 'utf8')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return fallback
      if (attempt >= 3) {
        unreadable.add(storeKey(path))
        console.error(`GitDesk: could not read ${path} (${(e as Error).message}); left as it is`)
        warnUnreadable(path, null)
        return fallback
      }
      pause(100)
    }
  }
  try {
    // Strip a UTF-8 BOM: Windows tools (PowerShell 5, Notepad) add one when editing the file.
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (e) {
    const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    let kept = true
    try {
      renameSync(path, backup)
    } catch {
      try {
        copyFileSync(path, backup)
      } catch {
        kept = false
      }
    }
    // No copy anywhere: the original must not be replaced by the next save.
    if (!kept) unreadable.add(storeKey(path))
    console.error(
      `GitDesk: could not parse ${path} (${(e as Error).message}); ` +
        (kept ? `kept as ${backup}` : 'left as it is')
    )
    warnUnreadable(path, kept ? backup : null)
    return fallback
  }
}

function warnUnreadable(path: string, backup: string | null): void {
  const detail = backup
    ? `The file was damaged, so GitDesk started without what it contained. ` +
      `Nothing was lost: it was kept as ${backup}. Fix it and copy it back while ` +
      `GitDesk is closed to restore it.`
    : `GitDesk started without what it contains, and will not change the file until it ` +
      `is restarted, so nothing in it is lost. Another program may be holding it open: ` +
      `close it, then restart GitDesk.`
  const show = (): void => {
    dialog
      .showMessageBox({
        type: 'warning',
        message: `GitDesk could not read ${basename(path)}.`,
        detail
      })
      .catch(() => undefined)
  }
  try {
    if (app.isReady()) show()
    else app.whenReady().then(show, () => undefined)
  } catch {
    /* no UI (tests) */
  }
}

/**
 * Writes a JSON file atomically: a temporary file, flushed to disk, then renamed over
 * the old one, so a crash or power loss leaves the old or the new file, never half of one.
 * A file readJsonStore could not read (and could not back up) is left alone this session.
 */
export function writeJsonAtomic(path: string, data: unknown, mode?: number): void {
  if (unreadable.has(storeKey(path))) {
    console.error(`GitDesk: not saving ${path}: it could not be read when GitDesk started`)
    return
  }
  const tmp = path + '.tmp'
  // A temporary file left by a crash keeps its old permissions: `mode` only applies to a
  // file being created, so start from a new one ('wx' refuses to reuse one).
  rmSync(tmp, { force: true })
  const fd = openSync(tmp, 'wx', mode)
  try {
    writeSync(fd, JSON.stringify(data, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

function readSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_SETTINGS
  return {
    githubClientId:
      typeof s.githubClientId === 'string' ? s.githubClientId.trim() : d.githubClientId,
    cloneRoot: typeof s.cloneRoot === 'string' && s.cloneRoot ? s.cloneRoot : d.cloneRoot,
    fetchIntervalMinutes:
      typeof s.fetchIntervalMinutes === 'number' && s.fetchIntervalMinutes >= 0
        ? Math.min(s.fetchIntervalMinutes, 24 * 60)
        : d.fetchIntervalMinutes,
    showAvatars: typeof s.showAvatars === 'boolean' ? s.showAvatars : d.showAvatars,
    useGravatar: typeof s.useGravatar === 'boolean' ? s.useGravatar : d.useGravatar,
    theme: s.theme === 'light' || s.theme === 'system' || s.theme === 'dark' ? s.theme : d.theme,
    editor:
      s.editor === 'cursor' || s.editor === 'system' || s.editor === 'vscode' ? s.editor : d.editor,
    autoUpdate: typeof s.autoUpdate === 'boolean' ? s.autoUpdate : d.autoUpdate,
    aiProvider:
      s.aiProvider === 'anthropic' || s.aiProvider === 'openai' || s.aiProvider === 'ollama'
        ? s.aiProvider
        : 'none',
    aiModel: str(s.aiModel, d.aiModel),
    // Anthropic has no base URL setting (the UI never offers one): an old or hand-edited
    // value must not send the key elsewhere.
    aiBaseUrl: s.aiProvider === 'anthropic' ? '' : str(s.aiBaseUrl, d.aiBaseUrl),
    agentCommands: readAgentCommands(s.agentCommands),
    worktreeRoot: str(s.worktreeRoot, d.worktreeRoot),
    terminalShell: str(s.terminalShell, d.terminalShell),
    branchColors: readBranchColors(s.branchColors)
  }
}

function readAgentCommands(raw: unknown): Partial<Record<AgentKind, string>> {
  const out: Partial<Record<AgentKind, string>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const kind of AGENT_KINDS) {
    const v = (raw as Record<string, unknown>)[kind]
    if (typeof v === 'string' && v.trim()) out[kind] = v.trim()
  }
  return out
}

function readWorkspaces(raw: unknown): Workspace[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((w) =>
    w && typeof w === 'object' && typeof w.id === 'string' && typeof w.name === 'string'
      ? [{ id: w.id, name: w.name, repos: strings(w.repos) }]
      : []
  )
}

function readStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  return Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string')
  )
}

function readSessions(raw: unknown): AgentSession[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((s) =>
    s &&
    typeof s === 'object' &&
    ['id', 'repo', 'worktree', 'branch', 'task'].every((k) => typeof s[k] === 'string') &&
    AGENT_KINDS.includes(s.agent) &&
    typeof s.createdAt === 'number'
      ? [
          {
            id: s.id,
            repo: s.repo,
            worktree: s.worktree,
            branch: s.branch,
            agent: s.agent,
            task: s.task,
            createdAt: s.createdAt
          }
        ]
      : []
  )
}

/**
 * Set in the state file once its paths are canonical: an older file (paths as the user
 * picked them) is converted once, when loaded, rather than every path being compared in
 * canonical form on every lookup (see findStoredPath).
 */
const CANONICAL_MARK = 'canonicalPaths'

/** The canonical form of a stored path (see canonicalPath); a relative one stays as it is. */
const canonicalStored = (p: string): string => (isAbsolute(p) ? canonicalPath(p) : p)

/** Canonical paths, each place once (the first of several names of one folder wins). */
function canonicalList(list: string[]): string[] {
  const seen = new Set<string>()
  return list.map(canonicalStored).filter((p) => !seen.has(textKey(p)) && !!seen.add(textKey(p)))
}

/** Canonical keys (and, with `values`, canonical values), each place once. */
function canonicalKeys(map: Record<string, string>, values = false): Record<string, string> {
  const out: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [k, v] of Object.entries(map)) {
    const key = canonicalStored(k)
    if (seen.has(textKey(key))) continue
    seen.add(textKey(key))
    out[key] = values ? canonicalStored(v) : v
  }
  return out
}

/** A state from a file written before paths were stored in canonical form, converted. */
function canonicalState(s: AppState): AppState {
  return {
    ...s,
    repos: canonicalList(s.repos),
    openTabs: canonicalList(s.openTabs),
    activeTab: s.activeTab && canonicalStored(s.activeTab),
    repoAccounts: canonicalKeys(s.repoAccounts),
    workspaces: s.workspaces.map((w) => ({ ...w, repos: canonicalList(w.repos) })),
    worktreeParents: canonicalKeys(s.worktreeParents, true)
  }
}

export function loadState(): AppState {
  if (state) return state
  const parsed = readJsonStore(file(), {})
  const raw = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  const converted = raw[CANONICAL_MARK] === true
  trust = readStringMap(raw.trustedRepos)
  if (!converted) trust = canonicalKeys(trust)
  const accounts: Record<string, string> = {}
  if (raw.repoAccounts && typeof raw.repoAccounts === 'object') {
    for (const [path, login] of Object.entries(raw.repoAccounts)) {
      if (typeof login === 'string') accounts[path] = login
    }
  }
  const loaded: AppState = {
    repos: strings(raw.repos),
    openTabs: strings(raw.openTabs),
    activeTab: typeof raw.activeTab === 'string' ? raw.activeTab : null,
    settings: readSettings(raw.settings),
    repoAccounts: accounts,
    workspaces: readWorkspaces(raw.workspaces),
    worktreeParents: readStringMap(raw.worktreeParents),
    agentSessions: readSessions(raw.agentSessions)
  }
  state = converted ? loaded : canonicalState(loaded)
  return state
}

export function saveState(next: AppState): AppState {
  // Tabs and account links can only point at known repositories. Repositories are stored
  // in canonical form: a path with the same text needs no file system call (this runs on
  // every tab switch), another name of a folder one (see findStoredPath).
  const keys = new Set(next.repos.map(textKey))
  const known = (p: string): boolean =>
    keys.has(textKey(p)) || (isAbsolute(p) && keys.has(textKey(canonicalPath(p))))
  state = {
    repos: next.repos,
    openTabs: next.openTabs.filter(known),
    activeTab: next.activeTab && known(next.activeTab) ? next.activeTab : null,
    settings: readSettings(next.settings),
    repoAccounts: Object.fromEntries(Object.entries(next.repoAccounts).filter(([p]) => known(p))),
    workspaces: readWorkspaces(next.workspaces).map((w) => ({
      ...w,
      repos: w.repos.filter(known)
    })),
    worktreeParents: Object.fromEntries(
      Object.entries(readStringMap(next.worktreeParents)).filter(([p]) => known(p))
    ),
    agentSessions: readSessions(next.agentSessions)
  }
  writeJsonAtomic(file(), { ...state, trustedRepos: trust, [CANONICAL_MARK]: true })
  return state
}

export function addRepos(paths: string[], account?: string): AppState {
  const current = loadState()
  const repos = [...current.repos]
  const repoAccounts = { ...current.repoAccounts }
  // Stored as the file system names them, like git reports them (see canonicalPath).
  for (const p of paths.map(canonicalPath)) {
    const stored = findStoredPath(repos, p)
    if (!stored) repos.push(p)
    if (account) repoAccounts[stored ?? p] = account
  }
  repos.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return saveState({ ...current, repos, repoAccounts })
}

export function removeRepo(path: string): AppState {
  const current = loadState()
  // Added again later, it is inspected and trusted again from scratch.
  const trusted = findStoredPath(Object.keys(trust), path)
  trust = Object.fromEntries(Object.entries(trust).filter(([p]) => p !== trusted))
  const stored = findStoredPath(current.repos, path)
  return saveState({ ...current, repos: current.repos.filter((r) => r !== stored) })
}

/** The trust record of a repository folder (see trust/policy.ts), or null. */
export function trustRecord(path: string): string | null {
  loadState()
  const key = findStoredPath(Object.keys(trust), path)
  return key ? trust[key] : null
}

/** Saves (or with null, deletes) the trust record of a repository folder. */
export function setTrustRecord(path: string, record: string | null): void {
  const current = loadState()
  const key = findStoredPath(Object.keys(trust), path)
  const rest = Object.entries(trust).filter(([p]) => p !== key)
  trust = Object.fromEntries(record === null ? rest : [...rest, [canonicalPath(path), record]])
  saveState(current)
}

export function updateSettings(patch: Partial<Settings>): AppState {
  const current = loadState()
  return saveState({ ...current, settings: { ...current.settings, ...patch } })
}

/**
 * Hosting account linked to a repository (repositories cloned through GitDesk). A linked
 * worktree (agent worktrees included) uses its main repository's account: it shares
 * the remotes, and a partial clone fetches missing objects from there.
 */
export function accountFor(path: string): string | null {
  const s = loadState()
  const linked = (p: string): string | null => {
    const key = findStoredPath(Object.keys(s.repoAccounts), p)
    return key ? s.repoAccounts[key] : null
  }
  const own = linked(path)
  if (own) return own
  const child = findStoredPath(Object.keys(s.worktreeParents), path)
  return child ? linked(s.worktreeParents[child]) : null
}

/**
 * Every repo-scoped IPC call goes through this: only registered folders are touched.
 * Returns the registered path, whatever name of the folder `path` uses.
 */
export function requireRepo(path: unknown): string {
  if (typeof path !== 'string') throw new Error('Repository path missing')
  const match = findStoredPath(loadState().repos, path)
  if (!match) throw new Error(`Not a registered repository: ${path}`)
  return match
}
