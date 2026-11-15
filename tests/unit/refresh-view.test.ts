// The repository view's refresh helpers (shell/refresh.ts): coalescing and keeping what
// did not change, so React and the graph layout skip it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoSnapshot } from '../../src/shared/api'
import type { Commit, RefsInfo, WorkingStatus } from '../../src/shared/types'
import {
  appendPage,
  applySnapshot,
  cardsToRead,
  currentNow,
  EMPTY_VIEW,
  logSignature,
  NOW_TICK_MS,
  sameData,
  shouldAskAvatar,
  singleFlight,
  subscribeNow
} from '../../src/renderer/src/components/shell/refresh'

const commit = (sha: string, parents: string[] = []): Commit => ({
  sha: sha.padEnd(40, '0'),
  parents: parents.map((p) => p.padEnd(40, '0')),
  author: 'A',
  email: 'a@example.com',
  date: 1,
  subject: sha
})

const refs = (sha = 'a'): RefsInfo => ({
  headSha: sha,
  headBranch: 'main',
  branches: [
    {
      name: 'main',
      sha,
      isHead: true,
      upstream: null,
      ahead: 0,
      behind: 0,
      upstreamGone: false
    }
  ],
  remoteBranches: [],
  tags: [],
  remotes: []
})

const status = (unstaged: string[] = []): WorkingStatus => ({
  branch: 'main',
  headSha: 'a',
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: unstaged.map((path) => ({ path, kind: 'M' as const })),
  conflicted: [],
  operation: null
})

const snapshot = (over: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  status: status(),
  refsKey: 'r1',
  logKey: 'r1:1500',
  stashKey: 's1',
  refs: refs(),
  log: [commit('a')],
  stashes: [],
  ...over
})

describe('singleFlight', () => {
  it('runs one pass at a time and coalesces the calls made meanwhile into one more', async () => {
    let passes = 0
    let release: () => void = () => undefined
    const flight = singleFlight(async () => {
      passes++
      await new Promise<void>((r) => (release = r))
    })
    const first = flight.run()
    const others = [flight.run(), flight.run(), flight.run()]
    expect(passes).toBe(1)
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(passes).toBe(2) // one more pass for the three calls
    release()
    await Promise.all([first, ...others])
    expect(passes).toBe(2)
    expect(flight.lastDone()).toBeGreaterThan(0)
  })

  it('keeps working after a failed pass', async () => {
    let calls = 0
    const flight = singleFlight(async () => {
      calls++
      if (calls === 1) throw new Error('boom')
    })
    await flight.run()
    await flight.run()
    expect(calls).toBe(2)
  })
})

describe('applySnapshot', () => {
  it('takes everything from the first snapshot', () => {
    const snap = snapshot()
    const { next, changed } = applySnapshot(EMPTY_VIEW, snap)
    expect(changed).toBe(true)
    expect(next.refs).toBe(snap.refs)
    expect(next.status).toBe(snap.status)
    expect(next.commits).toBe(snap.log)
    expect(next.known).toEqual({ refsKey: 'r1', logKey: 'r1:1500', stashKey: 's1' })
  })

  it('keeps the previous objects when nothing changed', () => {
    const { next: first } = applySnapshot(EMPTY_VIEW, snapshot())
    // Same data from main (new objects over IPC), and the "unchanged" parts as null.
    const { next, changed } = applySnapshot(
      first,
      snapshot({ status: status(), refs: null, log: null, stashes: null })
    )
    expect(changed).toBe(false)
    expect(next.refs).toBe(first.refs)
    expect(next.status).toBe(first.status)
    expect(next.commits).toBe(first.commits)
    expect(next.stashes).toBe(first.stashes)
  })

  it('replaces only the part that changed', () => {
    const { next: first } = applySnapshot(EMPTY_VIEW, snapshot())
    const { next, changed } = applySnapshot(
      first,
      snapshot({ status: status(['a.txt']), refs: null, log: null, stashes: null })
    )
    expect(changed).toBe(true)
    expect(next.status?.unstaged).toHaveLength(1)
    expect(next.refs).toBe(first.refs)
    expect(next.commits).toBe(first.commits)
  })

  it('keeps the commit list (and the graph layout) when the same commits come back', () => {
    const { next: first } = applySnapshot(EMPTY_VIEW, snapshot())
    const { next, changed } = applySnapshot(
      first,
      snapshot({ refsKey: 'r2', logKey: 'r2:1500', refs: refs('b'), log: [commit('a')] })
    )
    expect(changed).toBe(true) // the refs moved
    expect(next.commits).toBe(first.commits)
    expect(next.known?.logKey).toBe('r2:1500')
  })

  it('keeps its own log key when the log did not come back', () => {
    const { next: first } = applySnapshot(EMPTY_VIEW, snapshot())
    // "Load more" grew the list while a snapshot asked with the old key was on its way.
    const grown = { ...first, known: { ...first.known!, logKey: 'r1:3000' } }
    const { next } = applySnapshot(grown, snapshot({ refs: null, log: null, stashes: null }))
    expect(next.known?.logKey).toBe('r1:3000')
  })
})

describe('appendPage', () => {
  it('appends a page that continues the list', () => {
    const { next: first } = applySnapshot(EMPTY_VIEW, snapshot({ log: [commit('b', ['a'])] }))
    const next = appendPage(first, { commits: [commit('a')], logKey: 'r1:3000' })
    expect(next?.commits.map((c) => c.subject)).toEqual(['b', 'a'])
    expect(next?.known?.logKey).toBe('r1:3000')
    expect(next?.logSignature).toBe(logSignature(next!.commits))
  })

  it('refuses a page that repeats loaded commits (the history moved)', () => {
    const { next: first } = applySnapshot(EMPTY_VIEW, snapshot())
    expect(appendPage(first, { commits: [commit('a')], logKey: 'x' })).toBeNull()
    expect(appendPage(EMPTY_VIEW, { commits: [commit('z')], logKey: 'x' })).toBeNull()
  })
})

describe('sameData', () => {
  it('compares IPC data by value', () => {
    expect(sameData(status(), status())).toBe(true)
    expect(sameData(status(['x']), status())).toBe(false)
    expect(sameData(null, null)).toBe(true)
  })
})

describe('the minute clock (relative dates move on while the data stays the same)', () => {
  afterEach(() => vi.useRealTimers())

  it('ticks once a minute for every listener, with one timer that stops with the last', () => {
    vi.useFakeTimers()
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeNow(a)
    const offB = subscribeNow(b)
    expect(vi.getTimerCount()).toBe(1)
    const before = currentNow()
    vi.advanceTimersByTime(NOW_TICK_MS)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(currentNow()).toBe(before + NOW_TICK_MS)
    offA()
    vi.advanceTimersByTime(NOW_TICK_MS)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    offB()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Projects page shown again', () => {
  it('reads the new repositories, the changed ones and the open tabs', () => {
    const cached = new Set(['a', 'b', 'c', 'd'])
    expect(
      cardsToRead(['a', 'b', 'c', 'd', 'e'], (r) => cached.has(r), new Set(['b']), ['c'])
    ).toEqual(['b', 'c', 'e'])
    expect(cardsToRead(['a'], (r) => cached.has(r), new Set(), [])).toEqual([])
  })

  it('asks again for a picture not found, a few minutes later, and never for one found', () => {
    expect(shouldAskAvatar(undefined, 1000, 500)).toBe(true)
    expect(shouldAskAvatar({ src: null, at: 1000 }, 1200, 500)).toBe(false)
    expect(shouldAskAvatar({ src: null, at: 1000 }, 1500, 500)).toBe(true)
    expect(shouldAskAvatar({ src: 'data:x', at: 0 }, 1e12, 500)).toBe(false)
  })
})
