// Types shared by the main process, the preload bridge and the renderer.

import type { BranchColors } from './branchColors'
import type { HostingProvider } from './features/hosting'

export interface Commit {
  sha: string
  parents: string[]
  author: string
  email: string
  /** Unix seconds (author date). */
  date: number
  subject: string
}

export interface CommitDetails extends Commit {
  body: string
  committer: string
  committerDate: number
  files: FileChange[]
}

/** A, M, D, R (renamed), C (copied), T (type change), U (conflict), ? (untracked). */
export type ChangeKind = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export interface FileChange {
  path: string
  /** Previous path for renames and copies. */
  origPath?: string
  kind: ChangeKind
}

export interface Branch {
  name: string
  sha: string
  isHead: boolean
  upstream: string | null
  ahead: number
  behind: number
  /** The upstream branch was deleted on the remote. */
  upstreamGone: boolean
}

export interface RemoteBranch {
  remote: string
  /** Branch name without the remote prefix, e.g. "main". */
  name: string
  /** e.g. "origin/main". */
  fullName: string
  sha: string
}

export interface Tag {
  name: string
  /** The commit the tag points at (annotated tags are peeled). */
  sha: string
}

export interface Stash {
  index: number
  /** e.g. "stash@{0}". */
  ref: string
  sha: string
  message: string
  date: number
}

export interface RefsInfo {
  headSha: string | null
  /** Current branch name, or null when HEAD is detached / repo is empty. */
  headBranch: string | null
  branches: Branch[]
  remoteBranches: RemoteBranch[]
  tags: Tag[]
  remotes: string[]
}

/** 'am' = applying mailbox patches (`git am`) stopped on conflicts. */
export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am' | null

export interface WorkingStatus {
  branch: string | null
  headSha: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  conflicted: FileChange[]
  /** A multi-step operation that is waiting for the user (e.g. merge with conflicts). */
  operation: RepoOperation
}

export interface RepoSummary {
  path: string
  name: string
  ok: boolean
  error?: string
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  changes: number
  conflicts: number
  /** Most recent commit on any branch (local or remote). */
  lastCommit: Pick<Commit, 'sha' | 'subject' | 'author' | 'email' | 'date'> | null
  /** Commits per day across all branches, oldest first; the last entry is today. */
  activity: number[]
  branchCount: number
  /** "owner/repo" when origin is on GitHub. */
  github: string | null
  /** GitHub account used for this repository (repositories cloned through GitDesk). */
  account: string | null
  /** Unix seconds of the last fetch, if any. */
  lastFetch: number | null
  /** Error from the last automatic fetch. */
  fetchError: string | null
}

export type DiffTarget =
  | { kind: 'commit'; sha: string; parent: string | null; file: FileChange }
  | { kind: 'unstaged'; file: FileChange }
  | { kind: 'staged'; file: FileChange }
  /** A file of a comparison: from...to (merge base to `to`) when threeDot, else from..to. Read-only. */
  | { kind: 'compare'; from: string; to: string; file: FileChange; threeDot: boolean }

export type PullMode = 'ff-only' | 'merge' | 'rebase'
export type ResetMode = 'soft' | 'mixed' | 'hard'

export interface Settings {
  /** Client ID of the user's own GitHub OAuth App (public, not a secret). */
  githubClientId: string
  /** Where repositories cloned from GitHub go. */
  cloneRoot: string
  /** Background fetch of followed repositories; 0 disables it. */
  fetchIntervalMinutes: number
  showAvatars: boolean
  /** Look up authors without a GitHub avatar on Gravatar (sends a hash of their email). */
  useGravatar: boolean
  theme: Theme
  editor: EditorChoice
  /** Check GitHub Releases for a new version at startup (packaged builds only). */
  autoUpdate: boolean
  /** AI features (bring your own key; keys are stored encrypted, not here). */
  aiProvider: AiProvider
  /** Model id for the provider; '' = the provider's recommended default. */
  aiModel: string
  /** Base URL for 'ollama' or an OpenAI-compatible server; '' = provider default. */
  aiBaseUrl: string
  /** Command line used to launch each coding agent in a terminal; missing = built-in default. */
  agentCommands: Partial<Record<AgentKind, string>>
  /** Folder for new worktrees; '' = next to the repository (<repo>.worktrees/<name>). */
  worktreeRoot: string
  /** Shell for the built-in terminal; '' = the system default (PowerShell, $SHELL…). */
  terminalShell: string
  /** Commit graph lane palettes per theme and branch name rules (empty = defaults). */
  branchColors: BranchColors
}

export type AiProvider = 'none' | 'anthropic' | 'openai' | 'ollama'

/** Coding agents GitDesk can launch in a terminal. */
export type AgentKind = 'claude' | 'codex' | 'gemini' | 'copilot' | 'opencode' | 'custom'

/** A coding agent working in its own worktree. Survives restarts (its terminal does not). */
export interface AgentSession {
  id: string
  /** Main repository the worktree belongs to. */
  repo: string
  /** Worktree folder the agent works in. */
  worktree: string
  branch: string
  agent: AgentKind
  /** What the agent was asked to do. */
  task: string
  /** Unix seconds. */
  createdAt: number
}

/** A named group of repositories on the dashboard. */
export interface Workspace {
  id: string
  name: string
  repos: string[]
}

export interface AppState {
  repos: string[]
  openTabs: string[]
  /** Path of the active tab, or null for the dashboard. */
  activeTab: string | null
  settings: Settings
  /** Repository path -> GitHub login used for it. */
  repoAccounts: Record<string, string>
  /** Named groups of repositories (dashboard filter, bulk sync). */
  workspaces: Workspace[]
  /** Worktree path -> main repository path, for worktrees opened as tabs. */
  worktreeParents: Record<string, string>
  agentSessions: AgentSession[]
}

export interface Account {
  /**
   * Stable id. The login for github.com accounts (so repository links saved before
   * other providers existed keep working), otherwise "<provider>:<host>:<login>".
   */
  id: string
  provider: HostingProvider
  /** Web host: "github.com", "github.example.com", "gitlab.com", "dev.azure.com"… */
  host: string
  /** Azure DevOps organization (dev.azure.com/<organization>); null elsewhere. */
  organization: string | null
  login: string
  name: string | null
  /** data: URL of the profile picture, if downloaded. */
  avatar: string | null
  /** The OAuth App issues 8-hour tokens ("Expire user access tokens" ticked). */
  tokenExpires: boolean
  /** That token has expired: sign in again. */
  expired: boolean
}

export interface DeviceCode {
  userCode: string
  verificationUri: string
  expiresIn: number
}

export interface GitHubRepo {
  fullName: string
  description: string | null
  private: boolean
  fork: boolean
  pushedAt: string | null
  cloneUrl: string
  account: string
}

export interface CloneProgress {
  url: string
  /** e.g. "Receiving objects". */
  phase: string
  percent: number | null
}

/** email (lowercase) -> data: URL, or null when no picture exists. */
export type AvatarMap = Record<string, string | null>

// ---------------------------------------------------------------------------
// Activity dashboard
// ---------------------------------------------------------------------------

export type PushKind =
  'push' | 'force_push' | 'branch_creation' | 'branch_deletion' | 'pr_merge' | 'merge_queue_merge'

export interface ActivityCommit {
  repo: string
  sha: string
  author: string
  email: string
  /** Unix seconds (author date: when the work was done). */
  time: number
  subject: string
  merge: boolean
}

/** A push (or branch event) as recorded by GitHub, with its real time. */
export interface ActivityPush {
  repo: string
  id: string
  actor: string | null
  time: number
  branch: string
  kind: PushKind
  before: string
  after: string
}

export interface ActivityData {
  /** Unix seconds when the data was read; ranges are measured from here. */
  generatedAt: number
  commits: ActivityCommit[]
  pushes: ActivityPush[]
  /** email (lowercase) -> GitHub identity, when GitHub knows it. */
  identities: Record<string, { login: string | null; avatar: string | null }>
  /** GitHub login -> picture. */
  loginAvatars: Record<string, string | null>
  /** Per repository: whether its push history could be read from GitHub. */
  pushSources: { repo: string; github: string | null; ok: boolean; error: string | null }[]
}

/**
 * ActivityData as the main process sends it: each commit names its repository by its index
 * in `repos`, so a long path is sent once rather than in every commit (a year of commits
 * across many repositories is otherwise mostly paths). expandActivity turns it back.
 */
export interface ActivityPayload extends Omit<ActivityData, 'commits'> {
  repos: string[]
  commits: (Omit<ActivityCommit, 'repo'> & { repo: number })[]
}

/** Outcome of "Sync": how many repositories were fetched, and which failed. */
export interface SyncResult {
  fetched: number
  failed: { repo: string; error: string }[]
}

// ---------------------------------------------------------------------------
// Search, history, blame
// ---------------------------------------------------------------------------

/** What a commit search looks at. */
export type SearchField = 'all' | 'message' | 'author' | 'sha'

export interface BlameLine {
  /** 1-based line number in the file at that revision. */
  line: number
  sha: string
  author: string
  email: string
  /** Unix seconds (author date). */
  date: number
  summary: string
  text: string
}

// ---------------------------------------------------------------------------
// Conflicts, rebase, undo
// ---------------------------------------------------------------------------

export type ConflictSide = 'ours' | 'theirs'

/** A conflicted file as the conflict view reads it. */
export interface ConflictFile {
  /** The text with its conflict markers; null when binary, not valid UTF-8 or too large. */
  content: string | null
  binary: boolean
  /** Not valid UTF-8 (another encoding): editing it here could not keep its bytes. */
  encodingProblem: boolean
  /** Larger than GitDesk shows (5 MB): not read, it can only be taken whole from one side. */
  tooLarge?: boolean
}

/** One line of an interactive rebase plan, oldest commit first. */
export interface RebaseStep {
  action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'
  sha: string
  /** New message for 'reword'; for 'squash' the message of the combined commit. */
  message?: string
}

/** The last GitDesk action on a repository that can be undone. */
export interface UndoInfo {
  /** Shown in the UI, e.g. "Undo commit “Fix typo”". */
  label: string
}

// ---------------------------------------------------------------------------
// GitHub pull requests
// ---------------------------------------------------------------------------

export interface PullRequest {
  number: number
  title: string
  author: string | null
  authorAvatar: string | null
  draft: boolean
  /** Branch the PR wants to merge, e.g. "feature/x" (may live on a fork). */
  headRef: string
  /** "owner/repo" of the head branch. */
  headRepo: string | null
  baseRef: string
  url: string
  /** Unix seconds. */
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Appearance, tools, updates
// ---------------------------------------------------------------------------

export type Theme = 'dark' | 'light' | 'system'
/** Editor used by "Open in editor"; 'system' = the OS default app for the file. */
export type EditorChoice = 'vscode' | 'cursor' | 'system'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error' | 'disabled'
  version?: string
  percent?: number
  error?: string
}
