import type {
  Account,
  BlameLine,
  ConflictSide,
  ConflictFile,
  PullRequest,
  RebaseStep,
  SearchField,
  UndoInfo,
  UpdateStatus,
  ActivityCommit,
  ActivityPayload,
  AppState,
  AvatarMap,
  CloneProgress,
  Commit,
  CommitDetails,
  DiffTarget,
  FileChange,
  PullMode,
  RefsInfo,
  RepoSummary,
  ResetMode,
  Settings,
  Stash,
  DeviceCode,
  GitHubRepo,
  SyncResult,
  WorkingStatus
} from './types'
import { AI_EVENTS, AI_METHODS, type AiApi, type AiEvents } from './features/ai'
import {
  GIT_EXTRAS_EVENTS,
  GIT_EXTRAS_METHODS,
  type GitExtrasApi,
  type GitExtrasEvents
} from './features/gitextras'
import {
  HOSTING_EVENTS,
  HOSTING_METHODS,
  type HostingApi,
  type HostingEvents
} from './features/hosting'
import {
  TERMINAL_EVENTS,
  TERMINAL_METHODS,
  type TerminalApi,
  type TerminalEvents
} from './features/terminal'
import { TRUST_EVENTS, TRUST_METHODS, type TrustApi, type TrustEvents } from './features/trust'

/** Keys of a snapshot the repository view already has ('' = none). */
export interface KnownSnapshot {
  refsKey: string
  logKey: string
  stashKey: string
}

export interface RepoSnapshot extends KnownSnapshot {
  status: WorkingStatus
  /** null: unchanged since `known` (no ref, HEAD, remote or upstream moved). */
  refs: RefsInfo | null
  /** null: unchanged since `known` (same refs and the same number of commits). */
  log: Commit[] | null
  stashes: Stash[] | null
}

/** What a bug report needs to know about this copy of GitDesk (Settings → Updates). */
export interface AppInfo {
  /** GitDesk's version ("1.0.0"). */
  version: string
  electron: string
  chromium: string
  node: string
  /** "Windows", "macOS" or "Linux" (another platform: its Node name). */
  os: string
  /** The operating system's version ("10.0.26100", "15.1.0", a Linux kernel release). */
  osVersion: string
  /** "x64", "arm64"… */
  arch: string
  /** `git --version` of the git GitDesk runs ("2.47.1"); null when git was not found. */
  git: string | null
}

/**
 * The facts of AppInfo as plain text for a bug report: versions only, never a path, a
 * repository or an account name.
 */
export function diagnosticsText(info: AppInfo): string {
  return [
    `GitDesk v${info.version}`,
    `OS: ${info.os} ${info.osVersion} (${info.arch})`,
    `Git: ${info.git ?? 'not found'}`,
    `Electron: ${info.electron}`,
    `Chromium: ${info.chromium}`,
    `Node: ${info.node}`
  ].join('\n')
}

export interface LogPage {
  commits: Commit[]
  /** The view's log key once the page is added. */
  logKey: string
}

/**
 * Everything the renderer can ask the main process to do.
 * Each method becomes an `ipcMain.handle('api:<name>')` channel; the preload
 * bridge exposes the same names on `window.api`, returning promises.
 */
export interface CoreApi {
  // App state & repository list
  getState(): AppState
  setTabs(openTabs: string[], activeTab: string | null): void
  /** Shows a folder picker; returns the updated state (unchanged if cancelled). */
  addRepo(): AppState
  /** Shows a folder picker and adds every repository found below it. */
  scanFolder(): AppState
  removeRepo(repo: string): AppState
  summary(repo: string): RepoSummary
  setSettings(patch: Partial<Settings>): AppState
  /** Folder picker for the clone folder. */
  pickCloneRoot(): AppState

  // Hosting accounts: GitHub, GitLab, Bitbucket, Azure DevOps (tokens never leave the main process)
  accounts(): Account[]
  /** Starts the device flow; GitDesk then polls GitHub until you approve. */
  githubStartSignIn(): DeviceCode
  /** Resolves once the code was approved on github.com. */
  githubFinishSignIn(): Account
  githubCancelSignIn(): void
  /** Signs out of any provider's account (`Account.id`; a github.com account's id is its login). */
  githubSignOut(accountId: string): Account[]
  /** GitHub repositories you can access; null = every signed-in GitHub account. */
  githubRepos(login: string | null): GitHubRepo[]
  /**
   * Clones into <clone folder>/<owner>/<repo> and follows the repository. `account` is an
   * `Account.id` (null = the first account of that host that can see it).
   */
  cloneRepo(url: string, account: string | null): { state: AppState; path: string }
  /** Stops the clones running now (what was written is removed); how many were stopped. */
  cancelClone(): number
  /** Fetches every repository that has a remote now, or only `repos` (a workspace). */
  syncNow(repos?: string[]): SyncResult
  /** Profile pictures for commit authors (sample commit per email). */
  avatars(repo: string, authors: { email: string; sha: string }[]): AvatarMap
  /** Opens a github.com page in the browser. */
  openGitHub(path: string): void

  // Activity dashboard
  /** Commits and GitHub pushes of every repository over the last `days` days. */
  activity(days: number): ActivityPayload
  /** Commits a push brought (`before..after`), read from the local clone. */
  pushCommits(repo: string, before: string, after: string): ActivityCommit[]

  // Reading
  log(repo: string, limit: number): Commit[]
  /**
   * What the repository view shows, in one call. `known`: the keys of the snapshot the
   * view already has; the parts that did not change since come back null.
   */
  snapshot(repo: string, limit: number, known: KnownSnapshot | null): RepoSnapshot
  /** "Load more": `count` commits after the first `skip`; null if a ref moved since `refsKey`. */
  logPage(repo: string, skip: number, count: number, refsKey: string): LogPage | null
  refs(repo: string): RefsInfo
  status(repo: string): WorkingStatus
  stashes(repo: string): Stash[]
  commitDetails(repo: string, sha: string): CommitDetails
  diff(repo: string, target: DiffTarget): string

  // Working copy
  stage(repo: string, paths: string[]): void
  unstage(repo: string, paths: string[]): void
  discard(repo: string, files: FileChange[]): void
  /** Applies a patch to the index (cached) or the working tree. */
  applyPatch(repo: string, patch: string, opts: { cached: boolean; reverse: boolean }): void
  commit(repo: string, message: string, amend: boolean): void
  lastCommitMessage(repo: string): string

  // Branches & history
  checkout(repo: string, ref: string): void
  checkoutRemote(repo: string, remoteBranch: string): void
  createBranch(repo: string, name: string, startPoint: string | null, checkout: boolean): void
  deleteBranch(repo: string, name: string, force: boolean): void
  renameBranch(repo: string, from: string, to: string): void
  merge(repo: string, ref: string): void
  abortOperation(repo: string): void
  continueOperation(repo: string): void
  cherryPick(repo: string, sha: string): void
  revert(repo: string, sha: string): void
  reset(repo: string, sha: string, mode: ResetMode): void
  createTag(repo: string, name: string, sha: string): void
  deleteTag(repo: string, name: string): void

  // Remotes
  fetch(repo: string): void
  pull(repo: string, mode: PullMode): void
  /**
   * Pushes the current branch where `git push` would (its push remote and ref), or sets an
   * upstream up. `seen` (force only): the remote branches the user saw, fullName -> sha;
   * the force push is refused if the target holds anything else (or exists unseen).
   * Without it, refused if the remote has commits the branch never had.
   */
  push(repo: string, force: boolean, seen?: Record<string, string>): void
  /** Stops the fetch, pull or push running in the repository; how many were stopped. */
  cancelNetwork(repo: string): number

  // Stashes
  stash(repo: string, message: string): void
  /** `sha` names the stash that was listed: found again if the list moved, refused if gone. */
  stashApply(repo: string, index: number, drop: boolean, sha?: string): void
  stashDrop(repo: string, index: number, sha?: string): void

  // Tags & refs on the remote
  /** Pushes one tag to `origin` (or the only remote). */
  pushTag(repo: string, name: string): void
  /** Deletes a tag on `origin` (or the only remote). */
  deleteRemoteTag(repo: string, name: string): void
  /**
   * Deletes a remote branch, e.g. "origin/feature/x", only while it still holds `expected`
   * (the sha the user saw; defaults to our copy of it as of the last fetch).
   */
  deleteRemoteBranch(repo: string, fullName: string, expected?: string): void

  // Search, history, blame
  /** Commits on any branch matching `query`, newest first. */
  searchCommits(repo: string, query: string, field: SearchField, limit: number): Commit[]
  /** Commits that changed `path` (following renames), newest first. */
  fileHistory(repo: string, path: string, limit: number): Commit[]
  /** Blame of `path` at `sha` (null = working copy). */
  blame(repo: string, path: string, sha: string | null): BlameLine[]

  // Conflicts
  /**
   * A conflicted file of the working copy (with its conflict markers). `content` is null
   * for a binary file or one that is not valid UTF-8.
   */
  readConflict(repo: string, path: string): ConflictFile
  /** Writes the resolved content and stages the file. */
  resolveConflict(repo: string, path: string, content: string): void
  /** Stages a conflicted file as it is in the working copy (its content is not rewritten). */
  markResolved(repo: string, path: string): void
  /** Takes the whole file from one side and stages it. */
  resolveConflictSide(repo: string, path: string, side: ConflictSide): void

  // Rebase & undo
  /** Rebases the current branch onto `onto` (branch name or sha). */
  rebase(repo: string, onto: string): void
  /** Commits between `base` (exclusive) and HEAD, oldest first. */
  rebaseCommits(repo: string, base: string): Commit[]
  /** Runs an interactive rebase of HEAD onto `base` with this plan. */
  rebaseInteractive(repo: string, base: string, steps: RebaseStep[]): void
  /** The last undoable GitDesk action on this repository, or null. */
  undoInfo(repo: string): UndoInfo | null
  undo(repo: string): void

  // Pull / merge requests (GitHub, GitLab, Bitbucket, Azure DevOps, by origin host)
  /** Open pull requests of the repository's origin. */
  pullRequests(repo: string): PullRequest[]
  /** Fetches a pull request into a local branch `pr/<number>` and checks it out. */
  checkoutPullRequest(repo: string, number: number): void

  // Updates
  updateStatus(): UpdateStatus
  checkForUpdates(): UpdateStatus
  /** Quits and installs a downloaded update. */
  installUpdate(): void
  /** Versions of GitDesk, Electron, the OS and git (see diagnosticsText). */
  appInfo(): AppInfo
  /**
   * Opens THIRD_PARTY_NOTICES.txt (the licenses of the bundled open-source code); false
   * when this build has none (development builds before `npm run build`).
   */
  openThirdPartyNotices(): boolean

  // Shell
  openFolder(repo: string): void
  openInEditor(repo: string): void
  /**
   * Opens one file of the repository in the configured editor. Returns a message when
   * the file was shown in its folder instead (a program or script with "system").
   */
  openFile(repo: string, path: string): string | null
  /** Shows one file in Explorer / Finder / the file manager. */
  showFile(repo: string, path: string): void
  /** Appends a pattern to the repository's .gitignore. */
  ignorePath(repo: string, pattern: string): void
  watch(repo: string): void
  unwatch(repo: string): void
}

export interface GitDeskApi
  extends CoreApi, TerminalApi, GitExtrasApi, AiApi, HostingApi, TrustApi {}

/** Main-process implementations of an API section (sync or async). */
export type HandlersOf<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<Awaited<R>>
    : never
}

/** Events pushed from the main process to the UI: channel -> payload. */
export type EventMap = TerminalEvents & GitExtrasEvents & AiEvents & HostingEvents & TrustEvents

export const EVENT_CHANNELS = [
  ...TERMINAL_EVENTS,
  ...GIT_EXTRAS_EVENTS,
  ...AI_EVENTS,
  ...HOSTING_EVENTS,
  ...TRUST_EVENTS
] as readonly (keyof EventMap)[]

export type AsyncApi<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}

export type RendererApi = AsyncApi<GitDeskApi> & {
  /** Called (debounced) when files or refs of a watched repository change. */
  onRepoChanged(listener: (repo: string) => void): () => void
  onCloneProgress(listener: (progress: CloneProgress) => void): () => void
  /** Called after a background fetch of followed repositories. */
  onReposSynced(listener: () => void): () => void
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  /** Subscribes to a feature event (see EventMap); returns the unsubscribe function. */
  on<K extends keyof EventMap>(channel: K, listener: (payload: EventMap[K]) => void): () => void
  /** process.platform of the app ('win32', 'darwin', 'linux'). */
  platform: string
}

const CORE_METHODS = [
  'getState',
  'setTabs',
  'addRepo',
  'scanFolder',
  'removeRepo',
  'summary',
  'setSettings',
  'pickCloneRoot',
  'accounts',
  'githubStartSignIn',
  'githubFinishSignIn',
  'githubCancelSignIn',
  'githubSignOut',
  'githubRepos',
  'cloneRepo',
  'cancelClone',
  'syncNow',
  'avatars',
  'openGitHub',
  'activity',
  'pushCommits',
  'log',
  'snapshot',
  'logPage',
  'refs',
  'status',
  'stashes',
  'commitDetails',
  'diff',
  'stage',
  'unstage',
  'discard',
  'applyPatch',
  'commit',
  'lastCommitMessage',
  'checkout',
  'checkoutRemote',
  'createBranch',
  'deleteBranch',
  'renameBranch',
  'merge',
  'abortOperation',
  'continueOperation',
  'cherryPick',
  'revert',
  'reset',
  'createTag',
  'deleteTag',
  'fetch',
  'pull',
  'push',
  'cancelNetwork',
  'stash',
  'stashApply',
  'stashDrop',
  'pushTag',
  'deleteRemoteTag',
  'deleteRemoteBranch',
  'searchCommits',
  'fileHistory',
  'blame',
  'readConflict',
  'resolveConflict',
  'markResolved',
  'resolveConflictSide',
  'rebase',
  'rebaseCommits',
  'rebaseInteractive',
  'undoInfo',
  'undo',
  'pullRequests',
  'checkoutPullRequest',
  'updateStatus',
  'checkForUpdates',
  'installUpdate',
  'appInfo',
  'openThirdPartyNotices',
  'openFolder',
  'openInEditor',
  'openFile',
  'showFile',
  'ignorePath',
  'watch',
  'unwatch'
] as const satisfies readonly (keyof CoreApi)[]

/** Kept in one place so preload and main register exactly the same channels. */
export const API_METHODS = [
  ...CORE_METHODS,
  ...TERMINAL_METHODS,
  ...GIT_EXTRAS_METHODS,
  ...AI_METHODS,
  ...HOSTING_METHODS,
  ...TRUST_METHODS
] as const

export const REPO_CHANGED_CHANNEL = 'repo:changed'
export const CLONE_PROGRESS_CHANNEL = 'clone:progress'
export const REPOS_SYNCED_CHANNEL = 'repos:synced'
export const UPDATE_STATUS_CHANNEL = 'update:status'

// Compile error here means a GitDeskApi method is missing from API_METHODS.
type MissingMethods = Exclude<keyof GitDeskApi, (typeof API_METHODS)[number]>
export const API_COMPLETE: [MissingMethods] extends [never] ? true : never = true
