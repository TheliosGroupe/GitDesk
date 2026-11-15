// Pure helpers for the activity dashboard: who is who, filtering, bucketing.
import type {
  ActivityCommit,
  ActivityData,
  ActivityPayload,
  ActivityPush
} from '../../../shared/types'
import { LOCALE } from './format'

/** Categorical slots (validated palette, dark steps) – see activity.css. */
export const SERIES_SLOTS = 8

export interface Person {
  key: string
  name: string
  login: string | null
  avatar: string | null
  /** 1..8 for the most active people, null = folded into "Other". */
  slot: number | null
  commits: number
  pushes: number
}

export const seriesColor = (slot: number | null): string =>
  slot ? `var(--series-${slot})` : 'var(--series-other)'

/** A commit belongs to its author's GitHub account when known, otherwise to the author name. */
/** ActivityData from what the main process sends (commits name their repository by index). */
export function expandActivity(p: ActivityPayload): ActivityData {
  const { repos, ...rest } = p
  return { ...rest, commits: p.commits.map((c) => ({ ...c, repo: repos[c.repo] ?? '' })) }
}

export function commitPersonKey(c: ActivityCommit, data: ActivityData): string {
  const login = data.identities[c.email]?.login
  return login ? `@${login.toLowerCase()}` : `n:${c.author.toLowerCase()}`
}

export function pushPersonKey(p: ActivityPush): string {
  return p.actor ? `@${p.actor.toLowerCase()}` : 'n:unknown'
}

/**
 * Everyone in the loaded data, most active first. Colors are assigned once on
 * the whole data set, so filtering never repaints a person.
 */
export function buildPeople(data: ActivityData): Map<string, Person> {
  const people = new Map<string, Person>()
  const get = (key: string, name: string, login: string | null): Person => {
    let p = people.get(key)
    if (!p) {
      p = { key, name, login, avatar: null, slot: null, commits: 0, pushes: 0 }
      people.set(key, p)
    }
    return p
  }
  for (const c of data.commits) {
    const id = data.identities[c.email]
    const p = get(commitPersonKey(c, data), id?.login ?? c.author, id?.login ?? null)
    p.commits++
    p.avatar ??= id?.avatar ?? null
  }
  for (const push of data.pushes) {
    const p = get(pushPersonKey(push), push.actor ?? 'Unknown', push.actor)
    p.pushes++
    if (push.actor) p.avatar = data.loginAvatars[push.actor] ?? p.avatar
  }
  const ranked = [...people.values()].sort(
    (a, b) => b.commits + b.pushes - (a.commits + a.pushes) || a.name.localeCompare(b.name)
  )
  ranked.forEach((p, i) => (p.slot = i < SERIES_SLOTS ? i + 1 : null))
  return new Map(ranked.map((p) => [p.key, p]))
}

export interface Filter {
  sinceSec: number
  untilSec: number
  repos: Set<string> | null
  person: string | null
}

export function filterCommits(data: ActivityData, f: Filter): ActivityCommit[] {
  return data.commits.filter(
    (c) =>
      c.time >= f.sinceSec &&
      c.time < f.untilSec &&
      (!f.repos || f.repos.has(c.repo)) &&
      (!f.person || commitPersonKey(c, data) === f.person)
  )
}

export function filterPushes(data: ActivityData, f: Filter): ActivityPush[] {
  return data.pushes.filter(
    (p) =>
      p.time >= f.sinceSec &&
      p.time < f.untilSec &&
      (!f.repos || f.repos.has(p.repo)) &&
      (!f.person || pushPersonKey(p) === f.person)
  )
}

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

export interface DayBucket {
  /** Local midnight, unix seconds. */
  start: number
  label: string
  total: number
  counts: Map<string, number>
}

/** One bucket per local day from `sinceSec` to `untilSec`, commits counted per person. */
export function dailyBuckets(
  commits: ActivityCommit[],
  data: ActivityData,
  sinceSec: number,
  untilSec: number
): DayBucket[] {
  const buckets: DayBucket[] = []
  const index = new Map<string, DayBucket>()
  const d = new Date(sinceSec * 1000)
  d.setHours(0, 0, 0, 0)
  while (d.getTime() / 1000 < untilSec) {
    const b: DayBucket = {
      start: d.getTime() / 1000,
      label: d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }),
      total: 0,
      counts: new Map()
    }
    buckets.push(b)
    index.set(dayKey(d), b)
    d.setDate(d.getDate() + 1)
  }
  for (const c of commits) {
    const b = index.get(dayKey(new Date(c.time * 1000)))
    if (!b) continue
    const key = commitPersonKey(c, data)
    b.counts.set(key, (b.counts.get(key) ?? 0) + 1)
    b.total++
  }
  return buckets
}

export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday'
]

/** 7 x 24 counts in local time, Monday first. */
export function weekHourGrid(times: number[]): number[][] {
  const grid = WEEKDAYS.map(() => new Array<number>(24).fill(0))
  for (const t of times) {
    const d = new Date(t * 1000)
    grid[(d.getDay() + 6) % 7][d.getHours()]++
  }
  return grid
}

export function hourHistogram(times: number[]): number[] {
  const hours = new Array<number>(24).fill(0)
  for (const t of times) hours[new Date(t * 1000).getHours()]++
  return hours
}

/** Clean axis ticks (1, 2, 5 × 10^n steps), at most ~4 intervals. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1]
  const raw = max / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  // Counts are whole numbers: never a step below 1.
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow)
  const ticks: number[] = []
  for (let v = 0; v < max + step; v += step) {
    ticks.push(Math.max(v, 0))
    if (v >= max) break
  }
  return ticks.map((v) => Math.round(v))
}

export function timeOfDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(LOCALE, {
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** "Today", "Yesterday" or a short date, relative to `nowSec`. */
export function dayHeading(unixSeconds: number, nowSec: number): string {
  const day = new Date(unixSeconds * 1000)
  const today = new Date(nowSec * 1000)
  if (dayKey(day) === dayKey(today)) return 'Today'
  today.setDate(today.getDate() - 1)
  if (dayKey(day) === dayKey(today)) return 'Yesterday'
  return day.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })
}

export function compact(n: number): string {
  return n >= 10_000
    ? `${(n / 1000).toFixed(0)}K`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}K`
      : String(n)
}

/** Items paired with a day heading on the first item of each day (lists are newest first). */
export function withDayHeadings<T extends { time: number }>(
  items: T[],
  nowSec: number
): { item: T; heading: string | null }[] {
  return items.map((item, i) => {
    const day = dayHeading(item.time, nowSec)
    const previous = i > 0 ? dayHeading(items[i - 1].time, nowSec) : null
    return { item, heading: day !== previous ? day : null }
  })
}
