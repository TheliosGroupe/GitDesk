import { describe, expect, it } from 'vitest'
import type { ActivityCommit, ActivityData, ActivityPush } from '../../src/shared/types'
import {
  buildPeople,
  commitPersonKey,
  compact,
  dailyBuckets,
  dayHeading,
  filterCommits,
  filterPushes,
  hourHistogram,
  niceTicks,
  pushPersonKey,
  seriesColor,
  timeOfDay,
  weekHourGrid,
  withDayHeadings,
  type Filter
} from '../../src/renderer/src/lib/activity'

// Local-time timestamps, so the tests pass in any time zone.
const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime() / 1000

let n = 0
const commit = (over: Partial<ActivityCommit> = {}): ActivityCommit => ({
  repo: '/r/one',
  sha: `sha${n++}`,
  author: 'Ada',
  email: 'ada@example.com',
  time: at(2024, 6, 17),
  subject: 'work',
  merge: false,
  ...over
})

const push = (over: Partial<ActivityPush> = {}): ActivityPush => ({
  repo: '/r/one',
  id: `push${n++}`,
  actor: 'octo',
  time: at(2024, 6, 17),
  branch: 'main',
  kind: 'push',
  before: 'a',
  after: 'b',
  ...over
})

const data = (over: Partial<ActivityData> = {}): ActivityData => ({
  generatedAt: at(2024, 6, 18),
  commits: [],
  pushes: [],
  identities: {},
  loginAvatars: {},
  pushSources: [],
  ...over
})

const ALL: Filter = { sinceSec: 0, untilSec: Infinity, repos: null, person: null }

describe('person keys', () => {
  it('uses the GitHub login when the email is known, else the author name', () => {
    const d = data({ identities: { 'ada@example.com': { login: 'AdaL', avatar: null } } })
    expect(commitPersonKey(commit(), d)).toBe('@adal')
    expect(commitPersonKey(commit({ email: 'x@y', author: 'Bob Smith' }), d)).toBe('n:bob smith')
  })

  it('ignores an identity without a login', () => {
    const d = data({ identities: { 'ada@example.com': { login: null, avatar: 'pic' } } })
    expect(commitPersonKey(commit(), d)).toBe('n:ada')
  })

  it('keys pushes by actor, or "unknown"', () => {
    expect(pushPersonKey(push({ actor: 'Octo' }))).toBe('@octo')
    expect(pushPersonKey(push({ actor: null }))).toBe('n:unknown')
  })
})

describe('seriesColor', () => {
  it('maps slots to CSS variables', () => {
    expect(seriesColor(3)).toBe('var(--series-3)')
    expect(seriesColor(null)).toBe('var(--series-other)')
  })
})

describe('buildPeople', () => {
  it('merges commits and pushes of the same GitHub account', () => {
    const d = data({
      commits: [commit(), commit()],
      pushes: [push({ actor: 'adal' })],
      identities: { 'ada@example.com': { login: 'AdaL', avatar: 'commit-pic' } },
      loginAvatars: { adal: 'push-pic' }
    })
    const people = buildPeople(d)
    expect([...people.keys()]).toEqual(['@adal'])
    expect(people.get('@adal')).toEqual({
      key: '@adal',
      name: 'AdaL',
      login: 'AdaL',
      // The account picture from the push lookup wins.
      avatar: 'push-pic',
      slot: 1,
      commits: 2,
      pushes: 1
    })
  })

  it('ranks by activity, then by name, and folds people past 8 into "Other"', () => {
    const commits: ActivityCommit[] = []
    // p0 has 10 commits, p1 9, ... p9 1.
    for (let i = 0; i < 10; i++) {
      for (let k = 0; k < 10 - i; k++) commits.push(commit({ author: `p${i}`, email: `p${i}@x` }))
    }
    // Two people with the same count: alphabetical order.
    commits.push(commit({ author: 'zed', email: 'z@x' }), commit({ author: 'amy', email: 'a@x' }))
    const people = [...buildPeople(data({ commits })).values()]
    expect(people.slice(0, 3).map((p) => p.name)).toEqual(['p0', 'p1', 'p2'])
    expect(people.map((p) => p.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, null, null, null, null])
    expect(people.slice(-3).map((p) => p.name)).toEqual(['amy', 'p9', 'zed'])
  })

  it('names anonymous pushes "Unknown"', () => {
    const people = buildPeople(data({ pushes: [push({ actor: null })] }))
    expect(people.get('n:unknown')).toMatchObject({ name: 'Unknown', login: null, pushes: 1 })
  })
})

describe('filters', () => {
  const d = data({
    commits: [
      commit({ sha: 'early', time: at(2024, 6, 1) }),
      commit({ sha: 'in', time: at(2024, 6, 10) }),
      commit({ sha: 'other-repo', time: at(2024, 6, 10), repo: '/r/two' }),
      commit({ sha: 'bob', time: at(2024, 6, 10), author: 'Bob', email: 'bob@x' }),
      commit({ sha: 'edge', time: at(2024, 6, 20, 0) })
    ],
    pushes: [
      push({ id: 'p-in', time: at(2024, 6, 10) }),
      push({ id: 'p-anon', time: at(2024, 6, 10), actor: null }),
      push({ id: 'p-late', time: at(2024, 6, 25) })
    ]
  })
  const range: Filter = {
    sinceSec: at(2024, 6, 5),
    untilSec: at(2024, 6, 20, 0),
    repos: null,
    person: null
  }

  it('keeps commits in [since, until)', () => {
    expect(filterCommits(d, range).map((c) => c.sha)).toEqual(['in', 'other-repo', 'bob'])
  })

  it('filters commits by repository and person', () => {
    expect(filterCommits(d, { ...range, repos: new Set(['/r/two']) }).map((c) => c.sha)).toEqual([
      'other-repo'
    ])
    expect(filterCommits(d, { ...range, person: 'n:bob' }).map((c) => c.sha)).toEqual(['bob'])
    expect(filterCommits(d, { ...range, repos: new Set() })).toEqual([])
  })

  it('filters pushes the same way', () => {
    expect(filterPushes(d, range).map((p) => p.id)).toEqual(['p-in', 'p-anon'])
    expect(filterPushes(d, { ...range, person: '@octo' }).map((p) => p.id)).toEqual(['p-in'])
    expect(filterPushes(d, { ...ALL, repos: new Set(['/r/two']) })).toEqual([])
  })
})

describe('dailyBuckets', () => {
  it('makes one bucket per local day and counts commits per person', () => {
    const commits = [
      commit({ time: at(2024, 6, 10, 0, 30) }),
      commit({ time: at(2024, 6, 10, 23, 59) }),
      commit({ time: at(2024, 6, 12, 8), author: 'Bob', email: 'bob@x' }),
      commit({ time: at(2024, 6, 1) }) // outside the range
    ]
    const d = data({ commits })
    const buckets = dailyBuckets(commits, d, at(2024, 6, 10, 15), at(2024, 6, 12, 18))
    expect(buckets.map((b) => b.start)).toEqual([
      at(2024, 6, 10, 0),
      at(2024, 6, 11, 0),
      at(2024, 6, 12, 0)
    ])
    expect(buckets.map((b) => b.label)).toEqual(['10 Jun', '11 Jun', '12 Jun'])
    expect(buckets.map((b) => b.total)).toEqual([2, 0, 1])
    expect(buckets[0].counts.get('n:ada')).toBe(2)
    expect(buckets[2].counts.get('n:bob')).toBe(1)
    expect(buckets[1].counts.size).toBe(0)
  })

  it('starts at local midnight of the first day', () => {
    // Noon to noon on the same day still covers that day.
    const one = dailyBuckets([], data(), at(2024, 6, 10), at(2024, 6, 10))
    expect(one.map((b) => b.start)).toEqual([at(2024, 6, 10, 0)])
    // Up to midnight: nothing.
    expect(dailyBuckets([], data(), at(2024, 6, 10), at(2024, 6, 10, 0))).toEqual([])
  })
})

describe('time histograms', () => {
  it('weekHourGrid is Monday first, local hours', () => {
    // 17 June 2024 is a Monday, 16 June a Sunday.
    const grid = weekHourGrid([at(2024, 6, 17, 9), at(2024, 6, 17, 9, 45), at(2024, 6, 16, 23)])
    expect(grid).toHaveLength(7)
    expect(grid.every((row) => row.length === 24)).toBe(true)
    expect(grid[0][9]).toBe(2)
    expect(grid[6][23]).toBe(1)
    expect(grid.flat().reduce((a, b) => a + b, 0)).toBe(3)
  })

  it('hourHistogram counts per local hour', () => {
    const hours = hourHistogram([at(2024, 6, 17, 0), at(2024, 6, 18, 0, 59), at(2024, 6, 19, 13)])
    expect(hours).toHaveLength(24)
    expect(hours[0]).toBe(2)
    expect(hours[13]).toBe(1)
  })
})

describe('niceTicks', () => {
  it('uses 1, 2, 5 x 10^n steps up to the max', () => {
    expect(niceTicks(0)).toEqual([0, 1])
    expect(niceTicks(-3)).toEqual([0, 1])
    expect(niceTicks(1)).toEqual([0, 1])
    expect(niceTicks(3)).toEqual([0, 1, 2, 3])
    expect(niceTicks(4)).toEqual([0, 1, 2, 3, 4])
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8])
    expect(niceTicks(10)).toEqual([0, 5, 10])
    expect(niceTicks(100)).toEqual([0, 50, 100])
    expect(niceTicks(130)).toEqual([0, 50, 100, 150])
  })

  it('always ends at or above the max with whole numbers', () => {
    for (const max of [1, 2, 5, 9, 17, 33, 99, 250, 999, 12345]) {
      const ticks = niceTicks(max)
      expect(ticks[0]).toBe(0)
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max)
      expect(ticks.every(Number.isInteger)).toBe(true)
      expect(ticks.length).toBeLessThanOrEqual(6)
    }
  })
})

describe('compact', () => {
  it('abbreviates thousands', () => {
    expect(compact(0)).toBe('0')
    expect(compact(999)).toBe('999')
    expect(compact(1000)).toBe('1.0K')
    expect(compact(1234)).toBe('1.2K')
    expect(compact(25_000)).toBe('25K')
  })
})

describe('day headings', () => {
  const now = at(2024, 6, 17, 12)

  it('says Today, Yesterday, or the full date', () => {
    expect(dayHeading(at(2024, 6, 17, 0, 1), now)).toBe('Today')
    expect(dayHeading(at(2024, 6, 16, 23, 59), now)).toBe('Yesterday')
    expect(dayHeading(at(2024, 6, 10), now)).toBe('Monday 10 June')
  })

  it('formats the time of day as HH:MM', () => {
    expect(timeOfDay(at(2024, 6, 17, 9, 5))).toBe('09:05')
  })

  it('puts a heading on the first item of each day only', () => {
    const items = [
      { time: at(2024, 6, 17, 11) },
      { time: at(2024, 6, 17, 9) },
      { time: at(2024, 6, 16, 20) },
      { time: at(2024, 6, 10) }
    ]
    expect(withDayHeadings(items, now).map((x) => x.heading)).toEqual([
      'Today',
      null,
      'Yesterday',
      'Monday 10 June'
    ])
    expect(withDayHeadings(items, now)[1].item).toBe(items[1])
  })
})
