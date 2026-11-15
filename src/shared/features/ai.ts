// Contract: AI features with your own API key.
// Add methods to AiApi and list them in AI_METHODS; the main process
// implements them in src/main/ai/handlers.ts. Events the main process
// pushes to the UI go in AiEvents (channel -> payload) and AI_EVENTS.
//
// API keys never leave the main process: the renderer can only store or remove
// one (aiSetKey) and learn whether one is stored (aiStatus). A key is sent only to the
// base URL it was saved for; another base URL needs the key to be entered again.
//
// Files that look like secrets (.env, private keys, credential files, tokens in the
// content) are never sent: only their path, listed in `withheld` for the user.

import type { AiProvider } from '../types'

/** Providers that can be configured (Settings.aiProvider minus 'none'). */
export type AiProviderId = Exclude<AiProvider, 'none'>

export const AI_PROVIDERS: readonly AiProviderId[] = ['anthropic', 'openai', 'ollama']

export interface AiStatus {
  provider: AiProvider
  /** Model actually used: Settings.aiModel, or the provider's default when that is ''. */
  model: string
  /** The provider's default model ('' for 'none'). */
  defaultModel: string
  /** Base URL requests go to ('' for 'none' or an invalid base URL). */
  endpoint: string
  /** Why the base URL cannot be used (not a URL, http:// to another computer…), or null. */
  endpointError: string | null
  /** True when requests can be made: a key is stored (Anthropic, OpenAI) or an endpoint is set (local). */
  configured: boolean
  /**
   * Whether each provider has a key stored for the base URL it uses now. The keys themselves
   * are never returned.
   */
  keyStored: Record<AiProviderId, boolean>
  /**
   * The base URL the current provider's key was saved for, when it is not `endpoint`: the
   * key is not sent until it is entered again. Null otherwise.
   */
  keySavedFor: string | null
}

export type AiExplainTarget =
  | { kind: 'commit'; sha: string }
  /** base null = the default branch (origin/HEAD, else main/master); compared from the merge-base. */
  | { kind: 'branch'; branch: string; base: string | null }

export interface AiCommitMessage {
  /** First line, at most 72 characters. */
  summary: string
  description: string
  /** 'unstaged' when nothing was staged and the message describes every uncommitted change. */
  source: 'staged' | 'unstaged'
  /** Part of the diff was left out of the prompt (too large, lockfiles…). */
  truncated: boolean
  /** Files that look like secrets: their content was not sent (only their path). */
  withheld: string[]
}

export interface AiPullRequestText {
  title: string
  /** Markdown. */
  body: string
  /** Files that look like secrets: their content was not sent (only their path). */
  withheld: string[]
}

export interface AiExplanation {
  /** Markdown. */
  text: string
  /** Files that look like secrets: their content was not sent (only their path). */
  withheld: string[]
}

/** One proposed resolution, aligned with lib/conflict.ts (`ConflictBlock.index`). */
export interface AiConflictSuggestion {
  index: number
  /** The text that replaces the whole block, markers included ('' = delete the block). */
  resolution: string
  explanation: string
}

export interface AiConflictResult {
  blocks: AiConflictSuggestion[]
  /** Anything the model or GitDesk wants to say about the file as a whole ('' when nothing). */
  note: string
}

/**
 * One piece of the uncommitted changes that a composition can put in a commit: a hunk of a
 * modified text file, or a whole file (new, deleted, binary, renamed, mode change, or too
 * many hunks to split).
 */
export interface AiChangeUnit {
  /** Stable while the working copy does not change: "f3" (file) or "h12" (hunk). */
  id: string
  kind: 'file' | 'hunk'
  path: string
  /** 'M' modified, 'A' added (also untracked), 'D' deleted, 'B' binary, 'T' mode / type change. */
  status: 'M' | 'A' | 'D' | 'B' | 'T'
  /** "@@ -10,4 +10,6 @@ fn()" for a hunk; a short description for a file. */
  header: string
  added: number
  removed: number
  /** First lines of the change, for display (may be cut). */
  preview: string
}

export interface AiPlannedCommit {
  /** Full commit message: summary, blank line, optional body. */
  message: string
  /** Ids of AiChangeUnit, in any order. */
  units: string[]
  /** Paths touched by this commit (derived from units; informative). */
  files: string[]
}

export interface AiComposition {
  /** Identifies the working copy the plan was made for; aiApplyComposition refuses another one. */
  fingerprint: string
  units: AiChangeUnit[]
  commits: AiPlannedCommit[]
  /** Hunk level, or file level only (too many hunks, or nothing could be split). */
  level: 'hunk' | 'file'
  /** Part of the changes were not shown to the model in full. */
  truncated: boolean
  /** Files that look like secrets: their content was not sent (only their path). */
  withheld: string[]
}

export interface AiApi {
  aiStatus(): AiStatus
  /**
   * Stores (encrypted with the OS key store) or removes (null) the key of a provider, for the
   * base URL that provider uses now.
   */
  aiSetKey(provider: AiProviderId, key: string | null): AiStatus
  /** Sends a tiny request with the current settings; resolves with a short success message. */
  aiTest(): string
  /**
   * Commit message for the staged changes (all uncommitted changes when nothing is staged).
   * With a requestId, the text is streamed as 'ai:chunk' events and aiCancel can stop it.
   */
  aiCommitMessage(repo: string, requestId?: string): AiCommitMessage
  /** Title and body for a pull request of `head` into `base` (branch names or shas). */
  aiPullRequestText(repo: string, base: string, head: string, requestId?: string): AiPullRequestText
  /** Markdown: what changed, why, and the risks. */
  aiExplain(repo: string, target: AiExplainTarget, requestId?: string): AiExplanation
  /**
   * A proposed resolution for each conflict block of a conflicted file. Refused for a file
   * that looks like it holds secrets. Suggestions are never applied by themselves: the user
   * accepts each one.
   */
  aiResolveConflict(repo: string, path: string, requestId?: string): AiConflictResult
  /** A plan splitting the uncommitted changes into logical commits. */
  aiComposeCommits(repo: string, requestId?: string): AiComposition
  /**
   * Commits the plan in order. Refuses when the working copy changed since the plan, or
   * when the plan does not use every change exactly once. On failure, nothing is committed
   * and the index is put back. Undo takes back all the commits at once.
   */
  aiApplyComposition(repo: string, plan: AiComposition): { commits: number }
  /** Stops a running request (it rejects with "Cancelled."). */
  aiCancel(requestId: string): void
}

export const AI_METHODS = [
  'aiStatus',
  'aiSetKey',
  'aiTest',
  'aiCommitMessage',
  'aiPullRequestText',
  'aiExplain',
  'aiResolveConflict',
  'aiComposeCommits',
  'aiApplyComposition',
  'aiCancel'
] as const satisfies readonly (keyof AiApi)[]

export interface AiEvents {
  /** Streamed text of a running request started with a requestId. */
  'ai:chunk': { requestId: string; text: string }
  /** The key store or the provider settings changed. */
  'ai:status': AiStatus
}

export const AI_EVENTS = ['ai:chunk', 'ai:status'] as const satisfies readonly (keyof AiEvents)[]
