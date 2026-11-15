import {
  CircleCheck,
  CircleDot,
  CircleX,
  CloudDownload,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Rocket,
  Search,
  TriangleAlert
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Account, AppState } from '../../../../shared/types'
import {
  PROVIDER_LABELS,
  type IssueSource,
  type IssueTrackers,
  type LaunchpadData,
  type LaunchpadGroup,
  type LaunchpadItem
} from '../../../../shared/features/hosting'
import { errorMessage, fullDate, relativeTime } from '../../lib/format'
import { Avatar } from '../ui'
import { useToasts } from '../ui-context'
import { ProviderBadge } from './ProviderBadge'
import '../../assets/hosting.css'

const GROUPS: { group: LaunchpadGroup; title: string; empty: string }[] = [
  { group: 'review', title: 'Waiting for my review', empty: 'No pull request waits for you.' },
  { group: 'mine', title: 'My pull requests', empty: 'You have no open pull request.' },
  { group: 'issue', title: 'Assigned issues', empty: 'No open issue is assigned to you.' }
]

type Sort = 'updated' | 'repo'

const ISSUE_SOURCES: string[] = ['github', 'gitlab', 'jira', 'linear'] satisfies IssueSource[]

function CiIcon({ item }: { item: LaunchpadItem }): React.JSX.Element | null {
  if (item.ci === 'success')
    return (
      <span className="lp-ci ok" title="Checks passed">
        <CircleCheck size={14} />
      </span>
    )
  if (item.ci === 'failure')
    return (
      <span className="lp-ci bad" title="Checks failed">
        <CircleX size={14} />
      </span>
    )
  if (item.ci === 'pending')
    return (
      <span className="lp-ci warn" title="Checks running">
        <CircleDot size={14} />
      </span>
    )
  return null
}

function ReviewBadge({ item }: { item: LaunchpadItem }): React.JSX.Element | null {
  switch (item.review) {
    case 'approved':
      return <span className="badge lp-review ok">Approved</span>
    case 'changes_requested':
      return <span className="badge lp-review bad">Changes requested</span>
    case 'review_required':
      return <span className="badge lp-review muted">Review required</span>
    case 'commented':
      return (
        <span className="badge lp-review muted">
          <MessageSquare size={11} /> Commented
        </span>
      )
    default:
      return null
  }
}

export function LaunchpadView({
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
  const toasts = useToasts()
  const [loaded, setLoaded] = useState<{
    key: string
    data: LaunchpadData | null
    error: string | null
  } | null>(null)
  /** Bumped by "Refresh": the next read skips the 2-minute cache. */
  const [request, setRequest] = useState({ n: 0, refresh: false })
  const [trackers, setTrackers] = useState<IssueTrackers | null>(null)
  const [source, setSource] = useState<string>('')
  const [repoFilter, setRepoFilter] = useState('')
  const [sort, setSort] = useState<Sort>('updated')
  const [busy, setBusy] = useState<string | null>(null)

  const accountsKey = accounts.map((a) => a.id).join(',')
  const key = `${accountsKey}\u0000${request.n}`
  useEffect(() => {
    let cancelled = false
    window.api.launchpad(request.refresh).then(
      (data) => !cancelled && setLoaded({ key, data, error: null }),
      (e) =>
        !cancelled &&
        setLoaded((prev) => ({ key, data: prev?.data ?? null, error: errorMessage(e) }))
    )
    return () => {
      cancelled = true
    }
  }, [key, request.refresh])

  useEffect(() => {
    window.api.issueTrackers().then(setTrackers, () => setTrackers({ jira: null, linear: null }))
  }, [accountsKey])

  const loading = loaded?.key !== key
  const data = loaded?.data ?? null
  const error = loaded?.error ?? null

  const items = useMemo(() => data?.items ?? [], [data])
  const sources = useMemo(() => [...new Set(items.map((i) => i.source))], [items])
  const repos = useMemo(
    () =>
      [...new Set(items.flatMap((i) => (i.repo ? [i.repo] : [])))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [items]
  )

  const visible = useMemo(() => {
    const q = repoFilter.trim().toLowerCase()
    return items
      .filter((i) => !source || i.source === source)
      .filter(
        (i) =>
          !q ||
          (i.repo ?? '').toLowerCase().includes(q) ||
          i.title.toLowerCase().includes(q) ||
          i.key.toLowerCase().includes(q)
      )
      .sort((a, b) =>
        sort === 'repo'
          ? (a.repo ?? '').localeCompare(b.repo ?? '') || b.updatedAt - a.updatedAt
          : b.updatedAt - a.updatedAt
      )
  }, [items, source, repoFilter, sort])

  const run = async (item: LaunchpadItem, fn: () => Promise<void>): Promise<void> => {
    setBusy(item.id)
    try {
      await fn()
    } catch (e) {
      toasts.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const checkout = (item: LaunchpadItem): Promise<void> =>
    run(item, async () => {
      const local = item.localRepo!
      if (item.group === 'issue') {
        const branch = await window.api.createBranchFromIssue(
          local,
          {
            source: item.source as IssueSource,
            key: item.key,
            number: item.number,
            title: item.title,
            url: item.url
          },
          { checkout: true }
        )
        toasts.info(`Created and checked out ${branch}`)
      } else {
        await window.api.checkoutPullRequest(local, item.number!)
        toasts.info(`Checked out ${item.key} as pr/${item.number}`)
      }
      onOpenRepo(local)
    })

  const clone = (item: LaunchpadItem): Promise<void> =>
    run(item, async () => {
      const { path } = await window.api.cloneRepo(item.cloneUrl!, item.accountId)
      toasts.info(`Cloned ${item.repo ?? path}`)
      onOpenRepo(path)
    })

  const hasTrackers = !!trackers && (!!trackers.jira || !!trackers.linear)
  const nothingConfigured = accounts.length === 0 && trackers !== null && !hasTrackers

  const row = (item: LaunchpadItem): React.JSX.Element => {
    const isPr = item.group !== 'issue'
    const canCheckout =
      !!item.localRepo && (isPr ? item.number !== null : ISSUE_SOURCES.includes(item.source))
    return (
      <div className="lp-row" key={item.id}>
        <ProviderBadge source={item.source} />
        {item.author || item.authorAvatar ? (
          <Avatar name={item.author ?? '?'} src={item.authorAvatar} size={22} />
        ) : (
          <span className="lp-avatar-placeholder" />
        )}
        <div className="lp-main">
          <div className="lp-title">
            <span className="lp-key">{item.key}</span>
            <span className="lp-title-text" title={item.title}>
              {item.title}
            </span>
          </div>
          <div className="lp-meta">
            {item.repo && <span className="lp-repo">{item.repo}</span>}
            {isPr && item.headRef && (
              <span className="lp-branch">
                <GitBranch size={11} /> {item.headRef}
                {item.baseRef ? ` → ${item.baseRef}` : ''}
              </span>
            )}
            {item.author && <span>by {item.author}</span>}
            <span title={fullDate(item.updatedAt)}>updated {relativeTime(item.updatedAt)}</span>
            <span className="muted" title={item.accountLabel}>
              {item.accountLabel}
            </span>
          </div>
        </div>
        <div className="lp-state">
          {item.draft && <span className="badge muted">Draft</span>}
          {!isPr && item.state && <span className="badge muted">{item.state}</span>}
          <ReviewBadge item={item} />
          <CiIcon item={item} />
        </div>
        <div className="lp-actions">
          {busy === item.id && <LoaderCircle size={14} className="spin" />}
          {canCheckout ? (
            <button
              className="btn small"
              disabled={busy !== null}
              onClick={() => void checkout(item)}
              title={
                isPr
                  ? `Check out as pr/${item.number} in your local clone`
                  : 'Create a branch for this issue in your local clone'
              }
            >
              <GitBranch size={13} /> Check out
            </button>
          ) : item.cloneUrl && !item.localRepo ? (
            <button
              className="btn small"
              disabled={busy !== null}
              onClick={() => void clone(item)}
              title="Clone this repository into your clone folder"
            >
              <CloudDownload size={13} /> Clone
            </button>
          ) : item.localRepo ? (
            <button className="btn small" onClick={() => onOpenRepo(item.localRepo!)}>
              Open repository
            </button>
          ) : null}
          <button
            className="btn small"
            onClick={() =>
              window.api.openHostingUrl(item.url).catch((e) => toasts.error(errorMessage(e)))
            }
            title={item.url}
          >
            <ExternalLink size={13} /> Open
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="launchpad">
      <div className="dash-header">
        <div>
          <h1>Launchpad</h1>
          <div className="muted">
            Pull requests and issues across your accounts
            {data && ` · updated ${relativeTime(data.generatedAt)}`}
          </div>
        </div>
        <span className="spacer" />
        <div className="dash-filter">
          <Search size={14} />
          <input
            placeholder="Filter by repository or title"
            aria-label="Filter by repository or title"
            list="launchpad-repos"
            value={repoFilter}
            onChange={(e) => setRepoFilter(e.target.value)}
          />
          <datalist id="launchpad-repos">
            {repos.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </div>
        <select
          className="input lp-select"
          aria-label="Provider"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">All providers</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {PROVIDER_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          className="input lp-select"
          aria-label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
        >
          <option value="updated">Recently updated</option>
          <option value="repo">By repository</option>
        </select>
        <button
          className="btn"
          onClick={() => setRequest((r) => ({ n: r.n + 1, refresh: true }))}
          disabled={loading}
          title="Read everything again from the providers"
        >
          {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} Refresh
        </button>
      </div>

      {nothingConfigured ? (
        <div className="dash-empty">
          <Rocket size={40} />
          <h2>Your pull requests and issues in one place</h2>
          <p>
            Sign in to GitHub, GitLab, Bitbucket or Azure DevOps (or connect Jira or Linear in
            Settings) to see what waits for your review, your pull requests with their checks, and
            the issues assigned to you.
          </p>
          <div className="dash-empty-actions">
            <button className="btn primary" onClick={onSignIn}>
              Sign in
            </button>
          </div>
        </div>
      ) : (
        <>
          {error && <div className="lp-error status bad">{error}</div>}
          {data?.errors.map((e) => (
            <div key={e.source} className="lp-error status warn" title={e.error}>
              <TriangleAlert size={14} /> {e.source}: {e.error}
            </div>
          ))}
          {!data && !error && (
            <div className="empty-state">
              <LoaderCircle size={16} className="spin" /> Loading…
            </div>
          )}
          {data &&
            GROUPS.map(({ group, title, empty }) => {
              const list = visible.filter((i) => i.group === group)
              return (
                <section key={group} className="lp-group" aria-label={title}>
                  <h2 className="lp-group-title">
                    {group === 'issue' ? <CircleDot size={15} /> : <GitPullRequest size={15} />}
                    {title}
                    <span className="badge">{list.length}</span>
                  </h2>
                  {list.length ? (
                    <div className="lp-list">{list.map(row)}</div>
                  ) : (
                    <div className="lp-empty muted">{empty}</div>
                  )}
                </section>
              )
            })}
          {data && state.repos.length === 0 && (
            <p className="help">
              Repositories you add to GitDesk get a “Check out” button here; the others can be
              cloned.
            </p>
          )}
        </>
      )}
    </div>
  )
}
