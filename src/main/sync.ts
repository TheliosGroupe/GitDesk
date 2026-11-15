import { BrowserWindow } from 'electron'
import { REPO_CHANGED_CHANNEL, REPOS_SYNCED_CHANNEL } from '../shared/api'
import type { SyncResult } from '../shared/types'
import { git } from './git'
import { exclusive } from './queue'
import { cachedRemotes, commitGraphFlag, fetchAll } from './repo'
import { findStoredPath } from './paths'
import { accountFor, loadState } from './store'

// Fetching repositories from their remotes.
// - In the background, only followed repositories (cloned through GitDesk with a
//   GitHub account) are fetched: others could pop up a credential prompt.
// - "Sync" in the UI fetches every repository that has a remote, or those of a workspace.
// - A few repositories are synced at once, each one still queued behind its own writes.
//   Only those linked to a GitDesk account (whose helper never prompts) fetch at the same
//   time; the others' fetches take turns, so at most one credential prompt shows.
// - The UI reloads only when something changed: refs moved, or a fetch error came or went
//   ("Sync" also reloads after any fetch, for the cards' "fetched … ago").

/** Repositories synced at the same time. */
export const SYNC_CONCURRENCY = 4

const errors = new Map<string, string>()
let timer: NodeJS.Timeout | null = null
let running: { all: boolean; only: string[] | null; promise: Promise<SyncResult> } | null = null

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args)
}

export function fetchError(repo: string): string | null {
  return errors.get(repo) ?? null
}

async function hasRemote(repo: string): Promise<boolean> {
  try {
    // Cached until the repository's config changes: a sync of many repositories does not
    // run `git remote` in each one every time.
    return (await cachedRemotes(repo)).length > 0
  } catch {
    return false
  }
}

/** Every ref and where it points: equal before and after a fetch when it brought nothing. */
function refTips(repo: string): Promise<string | null> {
  return git(repo, ['for-each-ref', '--format=%(objectname) %(refname)']).catch(() => null)
}

let turns: Promise<unknown> = Promise.resolve()

/** Runs `fn` after the previous one given here has finished. */
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const result = turns.then(fn)
  turns = result.catch(() => undefined)
  return result
}

/**
 * Fetches, remembering the error for the dashboard card; true when refs changed.
 * `takeTurn`: the fetch may use the user's own credential helper, so it waits for the others.
 *
 * The repository's write queue is held only while its own fetch runs: a fetch waiting for
 * its turn (behind another repository's credential prompt) must not hold up a commit or a
 * stage here. The ref snapshots are reads, taken outside the queue: a local write landing
 * between them can only cause one more reload, never hide a change.
 */
async function fetchAndCompare(repo: string, takeTurn = false): Promise<boolean> {
  try {
    const before = await refTips(repo)
    const graphFlag = await commitGraphFlag(repo)
    const fetch = (): Promise<void> => exclusive(repo, () => fetchAll(repo, graphFlag))
    await (takeTurn ? inTurn(fetch) : fetch())
    const changed = before === null || (await refTips(repo)) !== before
    errors.delete(repo)
    return changed
  } catch (e) {
    errors.set(repo, e instanceof Error ? e.message : String(e))
    throw e
  }
}

/**
 * Fetches one repository (the Fetch button or a dashboard card). The view that asked
 * refreshes by itself; others hear about it only when refs moved or the fetch failed.
 */
export async function fetchRepo(repo: string): Promise<void> {
  let changed = true
  try {
    changed = await fetchAndCompare(repo)
  } finally {
    if (changed) broadcast(REPO_CHANGED_CHANNEL, repo)
  }
}

/** Runs `fn` on every item, at most `size` at a time. */
export async function inPool<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
}

async function run(all: boolean, only: string[] | null): Promise<SyncResult> {
  const result: SyncResult = { fetched: 0, failed: [] }
  let reload = false
  const state = loadState()
  // Only registered repositories, whatever the UI sends.
  const wanted = only && new Set(only.map((p) => findStoredPath(state.repos, p)))
  const pool = wanted ? state.repos.filter((r) => wanted.has(r)) : state.repos
  const candidates = all ? pool : pool.filter((r) => state.repoAccounts[r])
  const failed = new Map<string, string>()
  await inPool(candidates, SYNC_CONCURRENCY, async (repo) => {
    if (!(await hasRemote(repo))) return
    const hadError = errors.get(repo)
    try {
      const changed = await fetchAndCompare(repo, !accountFor(repo))
      result.fetched++
      if (changed) broadcast(REPO_CHANGED_CHANNEL, repo)
      if (changed || hadError !== undefined || all) reload = true
    } catch (e) {
      failed.set(repo, e instanceof Error ? e.message : String(e))
      if (errors.get(repo) !== hadError) reload = true
    }
  })
  // In the order of the list, whichever finished first.
  for (const repo of candidates) {
    const error = failed.get(repo)
    if (error !== undefined) result.failed.push({ repo, error })
  }
  if (reload) broadcast(REPOS_SYNCED_CHANNEL)
  return result
}

/**
 * Fetches followed repositories (`all` = false) or every repository with a remote;
 * `only` limits it to some repositories (a workspace).
 */
export async function syncAll(all = false, only?: string[]): Promise<SyncResult> {
  const subset = only ? only.filter((p): p is string => typeof p === 'string') : null
  if (running) {
    const current = running
    const result = await current.promise
    // A background sync was running: still fetch the others when asked for all.
    if (!all || (current.all && !current.only && !subset)) return result
  }
  const promise = run(all, subset)
  running = { all, only: subset, promise }
  try {
    return await promise
  } finally {
    if (running?.promise === promise) running = null
  }
}

/** (Re)starts the timer from the current settings. */
export function scheduleSync(): void {
  if (timer) clearInterval(timer)
  timer = null
  const minutes = loadState().settings.fetchIntervalMinutes
  if (minutes > 0) timer = setInterval(() => void syncAll(false), minutes * 60_000)
}
