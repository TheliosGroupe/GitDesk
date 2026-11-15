// The repository view's refresh: one at a time, and only what changed reaches React state.

import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { KnownSnapshot, RepoSnapshot } from '../../../../shared/api'
import type { Commit, RefsInfo, Stash, WorkingStatus } from '../../../../shared/types'

/**
 * Runs `task` one at a time. A call while it runs asks for one more pass after it (all the
 * calls meanwhile share it) instead of starting a second one in parallel.
 */
export function singleFlight(task: () => Promise<void>): {
  run(): Promise<void>
  /** When the last pass finished (0: never). */
  lastDone(): number
} {
  let running: Promise<void> | null = null
  let again = false
  let done = 0
  const run = (): Promise<void> => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          await task().catch(() => undefined) // the task reports its own errors
        } while (again)
      } finally {
        running = null
        done = Date.now()
      }
    })()
    return running
  }
  return { run, lastDone: () => done }
}

/** Equal plain data (IPC results: JSON-like, keys in the same order). */
export function sameData(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** The commit list's identity: the graph keeps its layout while it is the same. */
export const logSignature = (commits: Commit[]): string =>
  commits.length + ':' + commits.map((c) => c.sha).join('')

export interface ViewData {
  refs: RefsInfo | null
  status: WorkingStatus | null
  stashes: Stash[]
  commits: Commit[]
  logSignature: string
  known: KnownSnapshot | null
}

export const EMPTY_VIEW: ViewData = {
  refs: null,
  status: null,
  stashes: [],
  commits: [],
  logSignature: '',
  known: null
}

/**
 * The view's data once a snapshot arrived. Parts that did not change keep their previous
 * object, so React (and the memoized graph layout) skip them; `changed` says if any did.
 */
export function applySnapshot(
  prev: ViewData,
  snap: RepoSnapshot
): { next: ViewData; changed: boolean } {
  const refs = snap.refs && !sameData(prev.refs, snap.refs) ? snap.refs : prev.refs
  const status = sameData(prev.status, snap.status) ? prev.status : snap.status
  const stashes =
    snap.stashes && !sameData(prev.stashes, snap.stashes) ? snap.stashes : prev.stashes
  let { commits, logSignature: signature } = prev
  if (snap.log) {
    const s = logSignature(snap.log)
    if (s !== signature) {
      commits = snap.log
      signature = s
    }
  }
  // No log: the list held is the one of the view's own key ("Load more" may have grown it
  // while this snapshot was on its way, or cleared it to read the list again).
  const logKey = snap.log ? snap.logKey : (prev.known?.logKey ?? snap.logKey)
  const next: ViewData = {
    refs,
    status,
    stashes,
    commits,
    logSignature: signature,
    known: { refsKey: snap.refsKey, logKey, stashKey: snap.stashKey }
  }
  const changed =
    refs !== prev.refs ||
    status !== prev.status ||
    stashes !== prev.stashes ||
    commits !== prev.commits
  return { next, changed }
}

/**
 * The view's data once a "Load more" page arrived, or null when it does not continue the
 * loaded list (the history moved meanwhile: reload it instead).
 */
export function appendPage(
  prev: ViewData,
  page: { commits: Commit[]; logKey: string }
): ViewData | null {
  if (!prev.known) return null
  const loaded = new Set(prev.commits.map((c) => c.sha))
  if (page.commits.some((c) => loaded.has(c.sha))) return null
  const commits = prev.commits.concat(page.commits)
  return {
    ...prev,
    commits,
    logSignature: logSignature(commits),
    known: { ...prev.known, logKey: page.logKey }
  }
}

// A shared clock for relative times ("5 minutes ago"): views that keep their objects while
// the data is unchanged would otherwise show "just now" forever. One timer for all.
export const NOW_TICK_MS = 60_000
const clock = {
  now: Date.now(),
  listeners: new Set<() => void>(),
  timer: null as ReturnType<typeof setInterval> | null
}

/** Calls `listener` once a minute; the timer runs only while someone listens. */
export function subscribeNow(listener: () => void): () => void {
  clock.listeners.add(listener)
  if (clock.timer === null) {
    clock.now = Date.now()
    clock.timer = setInterval(() => {
      clock.now = Date.now()
      for (const l of clock.listeners) l()
    }, NOW_TICK_MS)
  }
  return () => {
    clock.listeners.delete(listener)
    if (!clock.listeners.size && clock.timer !== null) {
      clearInterval(clock.timer)
      clock.timer = null
    }
  }
}

export const currentNow = (): number => clock.now
const noSubscription = (): (() => void) => () => undefined

/**
 * The time, updated once a minute while `enabled` (a hidden tab passes false and keeps the
 * value it had). Pass it to what renders relative times, so they move on.
 */
export function useNow(enabled = true): number {
  return useSyncExternalStore(enabled ? subscribeNow : noSubscription, currentNow)
}

/**
 * The Projects page shown again with fresh enough cards: the ones to read anyway (new,
 * changed meanwhile, or open as a tab, which stops watching as soon as it is hidden).
 */
export function cardsToRead(
  repos: string[],
  cached: (repo: string) => boolean,
  changed: Set<string>,
  openTabs: string[]
): string[] {
  return repos.filter((r) => !cached(r) || changed.has(r) || openTabs.includes(r))
}

/** Whether to ask for a card's picture: never asked, or not found and asked long enough ago. */
export function shouldAskAvatar(
  hit: { src: string | null; at: number } | undefined,
  now: number,
  retryMs: number
): boolean {
  return !hit || (hit.src === null && now - hit.at >= retryMs)
}

/** A function that keeps its identity across renders and always calls the latest `fn`. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}
