// Contract: Compare, line history, Gitflow, conflict prevention and patches.
// Add methods to GitExtrasApi and list them in GIT_EXTRAS_METHODS; the main process
// implements them in src/main/gitextras/handlers.ts. Events the main process
// pushes to the UI go in GitExtrasEvents (channel -> payload) and GIT_EXTRAS_EVENTS.

import type { Commit, FileChange } from '../types'

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export interface CompareResult {
  from: string
  to: string
  /** Commits the two refs resolve to (use these in a 'compare' DiffTarget). */
  fromSha: string
  toSha: string
  mergeBase: string | null
  /** Commits in `to` that are not in `from`, newest first. */
  ahead: Commit[]
  /** Commits in `from` that are not in `to`, newest first. */
  behind: Commit[]
  /** Total counts (the lists are capped at COMPARE_MAX_COMMITS). */
  aheadCount: number
  behindCount: number
  /** Files changed: from...to (since the merge base) when threeDot, else from..to directly. */
  files: FileChange[]
  threeDot: boolean
}

export const COMPARE_MAX_COMMITS = 500

// ---------------------------------------------------------------------------
// Line history
// ---------------------------------------------------------------------------

export interface LineHistoryEntry {
  commit: Commit
  /** The commit's diff restricted to the line range (unified diff of one file). */
  patch: string
}

// ---------------------------------------------------------------------------
// Gitflow (git-flow AVH config keys, no extension needed)
// ---------------------------------------------------------------------------

export type GitflowKind = 'feature' | 'bugfix' | 'release' | 'hotfix'

export interface GitflowConfig {
  /** Production branch (gitflow.branch.master / gitflow.branch.main). */
  main: string
  /** Integration branch (gitflow.branch.develop). */
  develop: string
  prefixes: {
    feature: string
    bugfix: string
    release: string
    hotfix: string
    support: string
    /** Prefix of release / hotfix tags, e.g. "v" ('' = none). */
    versiontag: string
  }
}

export interface GitflowFinishOptions {
  /** Message of the annotated tag (release / hotfix); empty = "Release <name>" / "Hotfix <name>". */
  tagMessage?: string
  /** Skip the tag (release / hotfix). */
  noTag?: boolean
  deleteBranch: boolean
}

export interface GitflowFinishResult {
  /** All steps done. False when a merge stopped on conflicts (resolve, Continue, then Finish again). */
  done: boolean
  /** What was done (or found already done), in order. */
  steps: string[]
  /** Summary for a toast. */
  message: string
}

// ---------------------------------------------------------------------------
// Conflict prevention
// ---------------------------------------------------------------------------

export interface ConflictWarning {
  /** e.g. "origin/feature/x" or "feature/y". */
  branch: string
  remote: boolean
  sha: string
  /** Files both you and this branch changed. */
  files: string[]
  /**
   * 'conflict': merging it into HEAD would conflict (git merge-tree);
   * 'overlap': same files, merges cleanly with your commits (uncommitted changes may still clash);
   * 'unknown': same files, git too old (< 2.38) to test the merge.
   */
  status: 'conflict' | 'overlap' | 'unknown'
  /** Files merge-tree reports as conflicted (status 'conflict'). */
  conflictFiles: string[]
  /** Last commit of the branch. */
  author: string
  date: number
  subject: string
}

export interface ConflictReport {
  branch: string | null
  /** What "your work" is measured from, e.g. "origin/main". */
  base: string | null
  /** Branches looked at. */
  checked: number
  /** Your changed files (commits since base + uncommitted). */
  myFiles: number
  warnings: ConflictWarning[]
  mergeTree: boolean
  /** A merge-tree check failed: some statuses are 'unknown', ask again after CONFLICT_RETRY_MS. */
  incomplete?: boolean
}

/** A failed merge-tree check is tried again after this long, not on every refresh. */
export const CONFLICT_RETRY_MS = 60_000

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

export type PatchSource = { kind: 'commit'; sha: string } | { kind: 'working'; staged: boolean }

export interface ApplyPatchResult {
  applied: boolean
  /** For a toast; '' when the dialog was cancelled. */
  message: string
  cancelled?: boolean
}

export interface GitExtrasApi {
  /** Compares two refs (branches, tags, commits); threeDot defaults to true. */
  compare(repo: string, from: string, to: string, threeDot?: boolean): CompareResult
  /** `git log -L start,end:path` from HEAD, newest first. */
  lineHistory(
    repo: string,
    path: string,
    start: number,
    end: number,
    limit: number
  ): LineHistoryEntry[]

  /** The repository's Gitflow configuration, or null when not initialized. */
  gitflowConfig(repo: string): GitflowConfig | null
  /** Suggested configuration for the Initialize dialog (existing main branch, AVH defaults). */
  gitflowDefaults(repo: string): GitflowConfig
  /** Writes the gitflow.* config and creates the develop branch from main when missing. */
  gitflowInit(repo: string, config: GitflowConfig): void
  /** Creates and checks out <prefix><name> from base (default develop, main for hotfix). Returns the branch. */
  gitflowStart(repo: string, kind: GitflowKind, name: string, base?: string | null): string
  /** git-flow finish; can be run again after resolving conflicts (finished steps are skipped). */
  gitflowFinish(
    repo: string,
    kind: GitflowKind,
    name: string,
    opts: GitflowFinishOptions
  ): GitflowFinishResult

  /** Other branches that change the same files as your work. Cached per HEAD/refs/status. */
  conflictWarnings(repo: string): ConflictReport

  /** Save dialog, then writes the patch; returns the saved path or null when cancelled. */
  exportPatch(repo: string, target: PatchSource): string | null
  /** Open dialog, then `git am --3way` (mbox) or `git apply --3way` (plain diff). */
  applyPatchFile(repo: string): ApplyPatchResult
}

export const GIT_EXTRAS_METHODS = [
  'compare',
  'lineHistory',
  'gitflowConfig',
  'gitflowDefaults',
  'gitflowInit',
  'gitflowStart',
  'gitflowFinish',
  'conflictWarnings',
  'exportPatch',
  'applyPatchFile'
] as const satisfies readonly (keyof GitExtrasApi)[]

export interface GitExtrasEvents {}

export const GIT_EXTRAS_EVENTS = [] as const satisfies readonly (keyof GitExtrasEvents)[]
