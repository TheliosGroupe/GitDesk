import { CircleDot, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Issue, IssuesResult } from '../../../../shared/features/hosting'
import { errorMessage, fullDate, relativeTime } from '../../lib/format'
import { Avatar, ContextMenu, type MenuState } from '../ui'
import { useToasts } from '../ui-context'
import { ProviderBadge } from './ProviderBadge'
import '../../assets/features.css'
import '../../assets/hosting.css'

interface Props {
  repo: string
  currentBranch: string | null
  onChanged(): void
}

type Loaded = { key: string; repo: string; result: IssuesResult | null; error: string | null }

const issueId = (i: Issue): string => `${i.source}:${i.key}`

/** Issues of the repository (GitHub / GitLab) and those assigned to you in Jira / Linear. */
export function IssuesSection({ repo, currentBranch, onChanged }: Props): React.JSX.Element {
  const toasts = useToasts()
  const [nonce, setNonce] = useState(0)
  const [loaded, setLoaded] = useState<Loaded>()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const key = `${repo}\0${nonce}`

  useEffect(() => {
    let cancelled = false
    window.api.issues(repo).then(
      (result) => !cancelled && setLoaded({ key, repo, result, error: null }),
      (e) => !cancelled && setLoaded({ key, repo, result: null, error: errorMessage(e) })
    )
    return () => {
      cancelled = true
    }
  }, [repo, key])

  const loading = loaded?.key !== key
  const shown = loaded?.repo === repo ? loaded : undefined
  const closeMenu = useCallback(() => setMenu(null), [])

  const createBranch = async (issue: Issue, checkout: boolean): Promise<void> => {
    setBusy(issueId(issue))
    try {
      const branch = await window.api.createBranchFromIssue(
        repo,
        {
          source: issue.source,
          key: issue.key,
          number: issue.number,
          title: issue.title,
          url: issue.url
        },
        { checkout }
      )
      toasts.info(checkout ? `Created and checked out ${branch}` : `Created branch ${branch}`)
      onChanged()
    } catch (e) {
      toasts.error(`Could not create a branch for ${issue.key}: ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const openMenu = (issue: Issue, x: number, y: number): void => {
    setMenu({
      x,
      y,
      items: [
        {
          label: 'Create branch and check out',
          disabled: busy !== null,
          onClick: () => void createBranch(issue, true)
        },
        {
          label: 'Create branch',
          disabled: busy !== null,
          onClick: () => void createBranch(issue, false)
        },
        'separator',
        {
          label: 'Open',
          hint: 'in the browser',
          onClick: () =>
            void window.api.openHostingUrl(issue.url).catch((e) => toasts.error(errorMessage(e)))
        },
        { label: 'Copy key', onClick: () => void navigator.clipboard.writeText(issue.key) },
        { label: 'Copy link', onClick: () => void navigator.clipboard.writeText(issue.url) }
      ]
    })
  }

  const refresh = (
    <button
      className="icon-btn pr-refresh"
      title="Refresh issues"
      aria-label="Refresh issues"
      disabled={loading}
      onClick={() => setNonce((n) => n + 1)}
    >
      {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
    </button>
  )

  const issues = shown?.result?.issues ?? []
  const errors = shown?.result?.errors ?? []
  let status: React.ReactNode
  if (!shown) status = <span>Loading…</span>
  else if (shown.error)
    status = (
      <span className="pr-error" title={shown.error}>
        {shown.error}
      </span>
    )
  else if (!issues.length)
    status = <span>{errors.length ? 'Could not read issues' : 'No open issues'}</span>
  else status = <span>{issues.length} open</span>

  return (
    <div className="pr-section issues-section">
      <div className="pr-status">
        {status}
        {refresh}
      </div>
      {errors.map((e) => (
        <div key={e} className="issue-error" title={e}>
          {e}
        </div>
      ))}
      {issues.map((issue) => {
        const id = issueId(issue)
        const current =
          currentBranch !== null &&
          currentBranch.toLowerCase().includes(issue.key.replace(/^#/, '').toLowerCase() + '-')
        return (
          <div
            key={id}
            className={`sb-item pr-item issue-item${current ? ' current' : ''}`}
            role="button"
            tabIndex={0}
            title={`${issue.key} ${issue.title}\n${issue.state}${
              issue.assignee ? ` · assigned to ${issue.assignee}` : ''
            }, updated ${fullDate(issue.updatedAt)}`}
            onClick={(e) => openMenu(issue, e.clientX, e.clientY)}
            onContextMenu={(e) => {
              e.preventDefault()
              openMenu(issue, e.clientX, e.clientY)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ContextMenu') return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              openMenu(issue, r.left + 24, r.bottom)
            }}
          >
            {busy === id ? (
              <Loader2 size={16} className="spin pr-avatar" />
            ) : issue.assignee || issue.assigneeAvatar ? (
              <Avatar
                name={issue.assignee ?? '?'}
                src={issue.assigneeAvatar}
                size={16}
                className="pr-avatar"
              />
            ) : (
              <CircleDot size={14} className="pr-avatar" />
            )}
            <span className="pr-text">
              <span className="pr-title">
                <span className="pr-number">{issue.key}</span> {issue.title}
              </span>
              <span className="pr-branches">
                {issue.state} · {relativeTime(issue.updatedAt)}
              </span>
            </span>
            <ProviderBadge source={issue.source} size={14} />
          </div>
        )
      })}
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </div>
  )
}
