import {
  ChevronDown,
  ChevronRight,
  GitBranchPlus,
  GitMerge,
  GitPullRequestArrow,
  LoaderCircle,
  RefreshCw,
  Table2,
  ChartColumn,
  Trash,
  TriangleAlert,
  Upload
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Account,
  ActivityCommit,
  ActivityData,
  ActivityPush,
  AppState,
  PushKind
} from '../../../shared/types'
import {
  buildPeople,
  commitPersonKey,
  compact,
  dailyBuckets,
  dayHeading,
  expandActivity,
  filterCommits,
  filterPushes,
  hourHistogram,
  pushPersonKey,
  seriesColor,
  timeOfDay,
  weekHourGrid,
  withDayHeadings,
  WEEKDAYS,
  type DayBucket,
  type Filter,
  type Person
} from '../lib/activity'
import { errorMessage, repoName, shortSha } from '../lib/format'
import { Heatmap, HourStrip, Legend, StackedColumns, type Series } from './ActivityCharts'
import { Avatar } from './ui'

/** Loaded once; the 7/30/90-day ranges are cut locally so people keep their colors. */
const LOAD_DAYS = 90
const RANGES = [7, 30, 90]
const FEED_PAGE = 60
const CODE_PUSHES: PushKind[] = ['push', 'force_push', 'pr_merge', 'merge_queue_merge']
const isCodePush = (p: ActivityPush): boolean => CODE_PUSHES.includes(p.kind)

const VERBS: Record<PushKind, string> = {
  push: 'pushed to',
  force_push: 'force-pushed to',
  branch_creation: 'created branch',
  branch_deletion: 'deleted branch',
  pr_merge: 'merged a pull request into',
  merge_queue_merge: 'merged (queue) into'
}

const KIND_ICONS: Record<PushKind, React.ReactNode> = {
  push: <Upload size={13} />,
  force_push: <TriangleAlert size={13} />,
  branch_creation: <GitBranchPlus size={13} />,
  branch_deletion: <Trash size={13} />,
  pr_merge: <GitPullRequestArrow size={13} />,
  merge_queue_merge: <GitMerge size={13} />
}

function Stat({
  label,
  value,
  delta,
  days,
  sub
}: {
  label: string
  value: string
  delta?: number | null
  days?: number
  sub?: string
}): React.JSX.Element {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {delta != null && (
        <div className="stat-delta">
          {delta > 0 ? '↑ +' : delta < 0 ? '↓ ' : '± '}
          {delta} vs previous {days} days
        </div>
      )}
      {sub && <div className="stat-delta">{sub}</div>}
    </div>
  )
}

function Card({
  title,
  subtitle,
  actions,
  children,
  className = ''
}: {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={`act-card ${className}`}>
      <header className="act-card-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <div className="muted">{subtitle}</div>}
        </div>
        <span className="spacer" />
        {actions}
      </header>
      {children}
    </section>
  )
}

function ViewToggle({
  table,
  onChange
}: {
  table: boolean
  onChange(table: boolean): void
}): React.JSX.Element {
  return (
    <div className="segmented" role="group" aria-label="Chart or table">
      <button className={table ? '' : 'active'} onClick={() => onChange(false)} title="Chart">
        <ChartColumn size={14} />
      </button>
      <button className={table ? 'active' : ''} onClick={() => onChange(true)} title="Table">
        <Table2 size={14} />
      </button>
    </div>
  )
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: { value: T; label: string; disabled?: boolean }[]
  onChange(v: T): void
  label: string
}): React.JSX.Element {
  return (
    <div className="segmented text" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={o.value === value ? 'active' : ''}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function RepoPicker({
  repos,
  selected,
  onChange
}: {
  repos: string[]
  selected: Set<string> | null
  onChange(next: Set<string> | null): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const toggle = (repo: string): void => {
    const next = new Set(selected ?? repos)
    if (next.has(repo)) next.delete(repo)
    else next.add(repo)
    onChange(next.size === repos.length ? null : next)
  }
  const label = !selected
    ? 'All repositories'
    : selected.size === 1
      ? repoName([...selected][0])
      : `${selected.size} repositories`

  return (
    <div className="picker" ref={ref}>
      <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        {label} <ChevronDown size={14} />
      </button>
      {open && (
        <div className="picker-menu" role="listbox">
          <button className="picker-item" onClick={() => onChange(null)}>
            <input type="checkbox" readOnly checked={!selected} tabIndex={-1} /> All repositories
          </button>
          <div className="menu-sep" />
          {repos.map((r) => (
            <button key={r} className="picker-item" onClick={() => toggle(r)} title={r}>
              <input
                type="checkbox"
                readOnly
                checked={!selected || selected.has(r)}
                tabIndex={-1}
              />
              {repoName(r)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tables (the readable twin of each chart)
// ---------------------------------------------------------------------------

function DailyTable({
  buckets,
  series,
  value
}: {
  buckets: DayBucket[]
  series: Series[]
  value(b: DayBucket, s: Series): number
}): React.JSX.Element {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Day</th>
            <th className="num">Total</th>
            {series.map((s) => (
              <th key={s.key} className="num">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...buckets].reverse().map((b) => (
            <tr key={b.start}>
              <td>{b.label}</td>
              <td className="num">{b.total}</td>
              {series.map((s) => (
                <td key={s.key} className="num">
                  {value(b, s) || ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HeatTable({ grid }: { grid: number[][] }): React.JSX.Element {
  return (
    <div className="table-wrap">
      <table className="data-table compact">
        <thead>
          <tr>
            <th />
            {grid[0].map((_, h) => (
              <th key={h} className="num">
                {String(h).padStart(2, '0')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, d) => (
            <tr key={d}>
              <th>{WEEKDAYS[d].slice(0, 3)}</th>
              {row.map((v, h) => (
                <td key={h} className="num">
                  {v || ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

type Expansion = { loading: boolean; commits?: ActivityCommit[]; error?: string }

function PushFeed({
  pushes,
  people,
  now,
  onOpenRepo
}: {
  pushes: ActivityPush[]
  people: Map<string, Person>
  now: number
  onOpenRepo(path: string): void
}): React.JSX.Element {
  const [limit, setLimit] = useState(FEED_PAGE)
  const [open, setOpen] = useState<Record<string, Expansion>>({})

  const toggle = async (p: ActivityPush): Promise<void> => {
    if (open[p.id]) {
      setOpen((o) => {
        const next = { ...o }
        delete next[p.id]
        return next
      })
      return
    }
    setOpen((o) => ({ ...o, [p.id]: { loading: true } }))
    try {
      const commits = await window.api.pushCommits(p.repo, p.before, p.after)
      setOpen((o) => ({ ...o, [p.id]: { loading: false, commits } }))
    } catch (e) {
      setOpen((o) => ({ ...o, [p.id]: { loading: false, error: errorMessage(e) } }))
    }
  }

  return (
    <div className="feed">
      {withDayHeadings(pushes.slice(0, limit), now).map(({ item: p, heading }) => {
        const who = people.get(pushPersonKey(p))
        const state = open[p.id]
        const expandable = p.kind !== 'branch_deletion'
        return (
          <div key={p.id}>
            {heading && <div className="feed-day">{heading}</div>}
            <div className={`feed-item kind-${p.kind}`}>
              <button
                className="icon-btn feed-toggle"
                disabled={!expandable}
                onClick={() => toggle(p)}
                aria-label={state ? 'Hide commits' : 'Show commits'}
              >
                {expandable ? state ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
              </button>
              <span
                className="feed-person-mark"
                style={{ background: seriesColor(who?.slot ?? null) }}
              />
              <Avatar name={p.actor ?? '?'} src={who?.avatar} size={24} />
              <div className="feed-text">
                <strong>{p.actor ?? 'Someone'}</strong>{' '}
                <span className="muted">{VERBS[p.kind]}</span>{' '}
                <code className="feed-branch">{p.branch}</code> <span className="muted">in</span>{' '}
                <button className="link-btn" onClick={() => onOpenRepo(p.repo)}>
                  {repoName(p.repo)}
                </button>
                {p.kind === 'force_push' && (
                  <span className="status serious">
                    <TriangleAlert size={12} /> force push
                  </span>
                )}
              </div>
              <span className="feed-kind" title={p.kind.replace(/_/g, ' ')}>
                {KIND_ICONS[p.kind]}
              </span>
              <time className="feed-time">{timeOfDay(p.time)}</time>
            </div>
            {state && (
              <div className="feed-commits">
                {state.loading && (
                  <div className="muted">
                    <LoaderCircle size={13} className="spin" /> Reading commits…
                  </div>
                )}
                {state.error && <div className="error-text">{state.error}</div>}
                {state.commits && !state.commits.length && (
                  <div className="muted">No new commits.</div>
                )}
                {state.commits?.map((c) => (
                  <div className="feed-commit" key={c.sha}>
                    <code>{shortSha(c.sha)}</code>
                    <span className="feed-subject">{c.subject}</span>
                    <span className="muted">{c.author}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      {pushes.length > limit && (
        <button className="btn block" onClick={() => setLimit(limit + FEED_PAGE)}>
          Show more ({pushes.length - limit} left)
        </button>
      )}
      {!pushes.length && <div className="empty-state">No pushes in this period.</div>}
    </div>
  )
}

function CommitFeed({
  commits,
  data,
  people,
  now,
  onOpenRepo
}: {
  commits: ActivityCommit[]
  data: ActivityData
  people: Map<string, Person>
  now: number
  onOpenRepo(path: string): void
}): React.JSX.Element {
  const [limit, setLimit] = useState(FEED_PAGE)
  return (
    <div className="feed">
      {withDayHeadings(commits.slice(0, limit), now).map(({ item: c, heading }) => {
        const who = people.get(commitPersonKey(c, data))
        return (
          <div key={c.repo + c.sha}>
            {heading && <div className="feed-day">{heading}</div>}
            <div className="feed-item">
              <span className="feed-toggle" />
              <span
                className="feed-person-mark"
                style={{ background: seriesColor(who?.slot ?? null) }}
              />
              <Avatar name={who?.name ?? c.author} src={who?.avatar} size={24} />
              <div className="feed-text">
                <strong>{who?.name ?? c.author}</strong>{' '}
                <span className="feed-subject">{c.subject}</span> <span className="muted">in</span>{' '}
                <button className="link-btn" onClick={() => onOpenRepo(c.repo)}>
                  {repoName(c.repo)}
                </button>
                {c.merge && <span className="badge muted">merge</span>}
              </div>
              <code className="feed-sha">{shortSha(c.sha)}</code>
              <time className="feed-time">{timeOfDay(c.time)}</time>
            </div>
          </div>
        )
      })}
      {commits.length > limit && (
        <button className="btn block" onClick={() => setLimit(limit + FEED_PAGE)}>
          Show more ({commits.length - limit} left)
        </button>
      )}
      {!commits.length && <div className="empty-state">No commits in this period.</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

interface PersonRow {
  person: Person
  /** Times (unix seconds) of their commits and code pushes in the period. */
  commits: number[]
  pushes: number[]
  repos: Set<string>
  days: Set<string>
}

export function ActivityView({
  state,
  accounts,
  onOpenRepo,
  onSignIn
}: {
  state: AppState
  accounts: Account[]
  onOpenRepo(path: string): void
  onSignIn(): void
}): React.JSX.Element {
  const [data, setData] = useState<ActivityData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState(30)
  const [repos, setRepos] = useState<Set<string> | null>(null)
  const [person, setPerson] = useState<string | null>(null)
  const [heatMetric, setHeatMetric] = useState<'commits' | 'pushes'>('commits')
  const [feedMode, setFeedMode] = useState<'pushes' | 'commits'>('pushes')
  const [tables, setTables] = useState({ daily: false, heat: false })

  const repoCount = state.repos.length
  useEffect(() => {
    let cancelled = false
    const apply = (d: ActivityData): void => {
      if (cancelled) return
      setData(d)
      setError(null)
      setLoading(false)
    }
    const fail = (e: unknown): void => {
      if (cancelled) return
      setError(errorMessage(e))
      setLoading(false)
    }
    const read = (): Promise<void> =>
      window.api.activity(LOAD_DAYS).then((p) => apply(expandActivity(p)), fail)
    void read()
    const off = window.api.onReposSynced(() => void read())
    return () => {
      cancelled = true
      off()
    }
  }, [accounts.length, repoCount])

  const reload = async (): Promise<void> => {
    setLoading(true)
    try {
      setData(expandActivity(await window.api.activity(LOAD_DAYS)))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  const now = data?.generatedAt ?? 0
  const people = useMemo(() => (data ? buildPeople(data) : new Map<string, Person>()), [data])
  const filter = useMemo<Filter>(
    () => ({ sinceSec: now - days * 86_400, untilSec: now + 60, repos, person }),
    [now, days, repos, person]
  )
  const commits = useMemo(() => (data ? filterCommits(data, filter) : []), [data, filter])
  const pushes = useMemo(() => (data ? filterPushes(data, filter) : []), [data, filter])
  const codePushes = useMemo(() => pushes.filter(isCodePush), [pushes])

  const previous = useMemo(() => {
    if (!data || days >= LOAD_DAYS) return null
    const f = { ...filter, sinceSec: now - 2 * days * 86_400, untilSec: now - days * 86_400 }
    return {
      commits: filterCommits(data, f).length,
      pushes: filterPushes(data, f).filter(isCodePush).length
    }
  }, [data, filter, days, now])

  const buckets = useMemo(
    () => (data ? dailyBuckets(commits, data, filter.sinceSec, filter.untilSec) : []),
    [commits, data, filter]
  )

  const series = useMemo<Series[]>(() => {
    if (!data) return []
    const present = new Set(commits.map((c) => commitPersonKey(c, data)))
    const list: Series[] = [...people.values()]
      .filter((p) => p.slot && present.has(p.key))
      .map((p) => ({ key: p.key, label: p.name, slot: p.slot }))
    if ([...present].some((k) => !people.get(k)?.slot))
      list.push({ key: 'other', label: 'Other', slot: null })
    return list
  }, [commits, data, people])

  const listed = useMemo(() => new Set(series.map((s) => s.key)), [series])
  const seriesValue = (b: DayBucket, s: Series): number =>
    s.key === 'other'
      ? [...b.counts].reduce((sum, [k, v]) => (listed.has(k) ? sum : sum + v), 0)
      : (b.counts.get(s.key) ?? 0)
  const seriesTotals = useMemo(() => {
    const totals = new Map<string, number>()
    for (const b of buckets) {
      for (const [k, v] of b.counts) {
        const key = listed.has(k) ? k : 'other'
        totals.set(key, (totals.get(key) ?? 0) + v)
      }
    }
    return totals
  }, [buckets, listed])

  const heatTimes = (heatMetric === 'commits' ? commits : codePushes).map((x) => x.time)
  const grid = weekHourGrid(heatTimes)
  const busiest = useMemo(() => {
    const g = weekHourGrid(
      commits.length ? commits.map((c) => c.time) : codePushes.map((p) => p.time)
    )
    let best: [number, number, number] = [0, 0, 0]
    g.forEach((row, d) => row.forEach((v, h) => v > best[2] && (best = [d, h, v])))
    return best
  }, [commits, codePushes])

  const rows = useMemo(() => {
    if (!data) return []
    const byKey = new Map<string, PersonRow>()
    const row = (key: string): PersonRow | null => {
      const p = people.get(key)
      if (!p) return null
      let r = byKey.get(key)
      if (!r) {
        r = { person: p, commits: [], pushes: [], repos: new Set(), days: new Set() }
        byKey.set(key, r)
      }
      return r
    }
    const day = (t: number): string => new Date(t * 1000).toDateString()
    for (const c of commits) {
      const r = row(commitPersonKey(c, data))
      if (!r) continue
      r.commits.push(c.time)
      r.repos.add(c.repo)
      r.days.add(day(c.time))
    }
    for (const p of codePushes) {
      const r = row(pushPersonKey(p))
      if (!r) continue
      r.pushes.push(p.time)
      r.repos.add(p.repo)
      r.days.add(day(p.time))
    }
    return [...byKey.values()].sort(
      (a, b) => b.commits.length + b.pushes.length - (a.commits.length + a.pushes.length)
    )
  }, [commits, codePushes, data, people])

  const pushAvailable = data?.pushSources.some((s) => s.ok) ?? false
  const missingPush = data?.pushSources.filter((s) => s.github && !s.ok) ?? []
  const localOnly = data?.pushSources.filter((s) => !s.github).length ?? 0
  const mode = pushAvailable ? feedMode : 'commits'
  const contributors = new Set([
    ...commits.map((c) => (data ? commitPersonKey(c, data) : '')),
    ...codePushes.map(pushPersonKey)
  ]).size

  if (!data) {
    return (
      <div className="activity-view">
        <div className="empty-state">
          {error ? (
            <span className="error-text">{error}</span>
          ) : (
            <>
              <LoaderCircle size={16} className="spin" /> Reading the history of {repoCount}{' '}
              repositories…
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="activity-view">
      <div className="act-header">
        <div>
          <h1>Activity</h1>
          <div className="muted">
            Who works on what, and when · {repoCount} repositor{repoCount === 1 ? 'y' : 'ies'} ·
            updated {timeOfDay(data.generatedAt)}
          </div>
        </div>
      </div>

      <div className="act-filters">
        <Segmented<number>
          label="Period"
          value={days}
          onChange={setDays}
          options={RANGES.map((d) => ({ value: d, label: `Last ${d} days` }))}
        />
        <RepoPicker repos={state.repos} selected={repos} onChange={setRepos} />
        <select
          className="input act-person"
          value={person ?? ''}
          onChange={(e) => setPerson(e.target.value || null)}
          aria-label="Person"
        >
          <option value="">Everyone</option>
          {[...people.values()].map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn" onClick={reload} disabled={loading} title="Reload">
          {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
        {error && <span className="error-text">{error}</span>}
      </div>

      {(missingPush.length > 0 || localOnly > 0) && (
        <div className="act-notice">
          {!accounts.length ? (
            <>
              Pushes come from GitHub.{' '}
              <button className="link-btn" onClick={onSignIn}>
                Sign in with GitHub
              </button>{' '}
              to see who pushed what, and when.
            </>
          ) : (
            missingPush.map((s) => (
              <div key={s.repo}>
                No push history for {repoName(s.repo)}: {s.error}
              </div>
            ))
          )}
          {localOnly > 0 && (
            <div className="muted">
              {localOnly} repositor{localOnly === 1 ? 'y is' : 'ies are'} not on GitHub: commits
              only.
            </div>
          )}
        </div>
      )}

      <div className={loading ? 'act-body refreshing' : 'act-body'}>
        <div className="kpis">
          <Stat
            label="Commits"
            value={compact(commits.length)}
            delta={previous && commits.length - previous.commits}
            days={days}
          />
          <Stat
            label="Pushes"
            value={pushAvailable ? compact(codePushes.length) : '—'}
            delta={pushAvailable && previous ? codePushes.length - previous.pushes : null}
            days={days}
          />
          <Stat label="People active" value={String(contributors)} />
          <Stat
            label="Busiest time"
            value={
              busiest[2]
                ? `${WEEKDAYS[busiest[0]].slice(0, 3)} · ${String(busiest[1]).padStart(2, '0')}h`
                : '—'
            }
            sub={
              busiest[2]
                ? `${busiest[2]} ${commits.length ? 'commits' : 'pushes'} in that hour slot`
                : undefined
            }
          />
        </div>

        <div className="act-grid">
          <Card
            title="Commits per day"
            subtitle="By author, all branches"
            actions={
              <ViewToggle
                table={tables.daily}
                onChange={(daily) => setTables({ ...tables, daily })}
              />
            }
          >
            {series.length > 1 && (
              <Legend
                series={series}
                totals={seriesTotals}
                selected={person}
                onSelect={setPerson}
              />
            )}
            {tables.daily ? (
              <DailyTable buckets={buckets} series={series} value={seriesValue} />
            ) : (
              <StackedColumns buckets={buckets} series={series} unit="commits" />
            )}
          </Card>

          <Card
            title="When work happens"
            subtitle="Your local time"
            actions={
              <>
                <Segmented<'commits' | 'pushes'>
                  label="Metric"
                  value={heatMetric}
                  onChange={setHeatMetric}
                  options={[
                    { value: 'commits', label: 'Commits' },
                    { value: 'pushes', label: 'Pushes', disabled: !pushAvailable }
                  ]}
                />
                <ViewToggle
                  table={tables.heat}
                  onChange={(heat) => setTables({ ...tables, heat })}
                />
              </>
            }
          >
            {tables.heat ? <HeatTable grid={grid} /> : <Heatmap grid={grid} unit={heatMetric} />}
          </Card>
        </div>

        <Card title="People" subtitle="Click someone to focus the whole page on them">
          <div className="table-wrap">
            <table className="data-table people">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="num">Commits</th>
                  <th className="num">Pushes</th>
                  <th>Repositories</th>
                  <th className="num">Active days</th>
                  <th>Last seen</th>
                  <th>Active hours</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const last = Math.max(...r.commits, ...r.pushes)
                  const color = seriesColor(r.person.slot)
                  return (
                    <tr
                      key={r.person.key}
                      className={person === r.person.key ? 'selected' : ''}
                      onClick={() => setPerson(person === r.person.key ? null : r.person.key)}
                    >
                      <td>
                        <span className="person">
                          <span className="viz-swatch" style={{ background: color }} />
                          <Avatar name={r.person.name} src={r.person.avatar} size={22} />
                          {r.person.name}
                        </span>
                      </td>
                      <td className="num">{r.commits.length}</td>
                      <td className="num">{pushAvailable ? r.pushes.length : '—'}</td>
                      <td>
                        {[...r.repos].map((repo) => (
                          <span key={repo} className="badge">
                            {repoName(repo)}
                          </span>
                        ))}
                      </td>
                      <td className="num">{r.days.size}</td>
                      <td>
                        {dayHeading(last, now)} {timeOfDay(last)}
                      </td>
                      <td>
                        <HourStrip
                          hours={hourHistogram(r.commits.length ? r.commits : r.pushes)}
                          color={color}
                          label={`Hours when ${r.person.name} ${r.commits.length ? 'commits' : 'pushes'}`}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!rows.length && <div className="empty-state">Nobody worked in this period.</div>}
          </div>
        </Card>

        <Card
          title="Recent activity"
          subtitle={mode === 'pushes' ? 'Pushes as recorded by GitHub' : 'Commits, newest first'}
          actions={
            <Segmented<'pushes' | 'commits'>
              label="Feed"
              value={mode}
              onChange={setFeedMode}
              options={[
                { value: 'pushes', label: 'Pushes', disabled: !pushAvailable },
                { value: 'commits', label: 'Commits' }
              ]}
            />
          }
        >
          {mode === 'pushes' ? (
            <PushFeed pushes={pushes} people={people} now={now} onOpenRepo={onOpenRepo} />
          ) : (
            <CommitFeed
              commits={commits}
              data={data}
              people={people}
              now={now}
              onOpenRepo={onOpenRepo}
            />
          )}
        </Card>
      </div>
    </div>
  )
}
