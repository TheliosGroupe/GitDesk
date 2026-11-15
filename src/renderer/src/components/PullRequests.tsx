import { GitPullRequest, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { PullRequest } from '../../../shared/types'
import { PROVIDER_LABELS, type RemoteInfo } from '../../../shared/features/hosting'
import { errorMessage, fullDate, relativeTime } from '../lib/format'
import { Avatar, ContextMenu, type MenuState } from './ui'
import { useToasts } from './ui-context'
import '../assets/features.css'

interface Props {
  repo: string
  currentBranch: string | null
  onChanged(): void
}

type Loaded = { key: string; repo: string; prs: PullRequest[] | null; error: string | null }

/** "owner:branch" when the head branch lives in another repository (a fork). */
function headLabel(pr: PullRequest, baseSlug: string | null): string {
  if (pr.headRepo && baseSlug && pr.headRepo.toLowerCase() !== baseSlug.toLowerCase()) {
    return `${pr.headRepo.split('/')[0]}:${pr.headRef}`
  }
  return pr.headRef
}

/**
 * Whether the checked-out branch is this pull request: its `pr/<n>` branch, or its head
 * branch when that lives in this repository (a fork's "main" is not our "main").
 */
function isCurrent(
  pr: PullRequest,
  currentBranch: string | null,
  baseSlug: string | null
): boolean {
  if (currentBranch === null) return false
  if (`pr/${pr.number}` === currentBranch) return true
  const sameRepo =
    !pr.headRepo || (!!baseSlug && pr.headRepo.toLowerCase() === baseSlug.toLowerCase())
  return sameRepo && pr.headRef === currentBranch
}

/** Open pull requests (GitHub, Bitbucket, Azure DevOps) or merge requests (GitLab) of origin. */
export function PullRequestsSection({ repo, currentBranch, onChanged }: Props): React.JSX.Element {
  const toasts = useToasts()
  const [nonce, setNonce] = useState(0)
  const [loaded, setLoaded] = useState<Loaded>()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [remote, setRemote] = useState<{ repo: string; info: RemoteInfo | null } | null>(null)
  const key = `${repo}\0${nonce}`

  useEffect(() => {
    let cancelled = false
    window.api.pullRequests(repo).then(
      (prs) => !cancelled && setLoaded({ key, repo, prs, error: null }),
      (e) => !cancelled && setLoaded({ key, repo, prs: null, error: errorMessage(e) })
    )
    return () => {
      cancelled = true
    }
  }, [repo, key])

  // Which provider origin is on, and the base repository (to tell forks apart).
  useEffect(() => {
    let cancelled = false
    window.api.remotesOf([repo]).then(
      (r) => !cancelled && setRemote({ repo, info: r[repo] ?? null }),
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [repo])

  const info = remote?.repo === repo ? remote.info : null
  const baseSlug = info?.slug ?? null
  const site = info?.provider ? PROVIDER_LABELS[info.provider] : 'the web'
  const noun = info?.provider === 'gitlab' ? 'merge request' : 'pull request'

  const loading = loaded?.key !== key
  // While refreshing, keep showing the previous list of the same repository.
  const shown = loaded?.repo === repo ? loaded : undefined
  const closeMenu = useCallback(() => setMenu(null), [])

  const checkout = async (pr: PullRequest): Promise<void> => {
    setBusy(pr.number)
    try {
      await window.api.checkoutPullRequest(repo, pr.number)
      toasts.info(`Checked out ${noun} #${pr.number} as pr/${pr.number}`)
      onChanged()
    } catch (e) {
      toasts.error(`Could not check out #${pr.number}: ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const openMenu = (pr: PullRequest, x: number, y: number): void => {
    setMenu({
      x,
      y,
      items: [
        {
          label: `Check out ${noun}`,
          hint: `pr/${pr.number}`,
          disabled: busy !== null,
          onClick: () => void checkout(pr)
        },
        'separator',
        {
          label: `Open on ${site}`,
          disabled: !pr.url.startsWith('https://'),
          onClick: () =>
            void window.api.openHostingUrl(pr.url).catch((e) => toasts.error(errorMessage(e)))
        },
        {
          label: 'Copy link',
          onClick: () => void navigator.clipboard.writeText(pr.url)
        }
      ]
    })
  }

  const refresh = (
    <button
      className="icon-btn pr-refresh"
      title={`Refresh ${noun}s`}
      aria-label="Refresh pull requests"
      disabled={loading}
      onClick={() => setNonce((n) => n + 1)}
    >
      {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
    </button>
  )

  let status: React.ReactNode
  if (!shown) status = <span>Loading…</span>
  else if (shown.error)
    status = (
      <span className="pr-error" title={shown.error}>
        {shown.error}
      </span>
    )
  else if (!shown.prs?.length) status = <span>No open {noun}s</span>
  else status = <span>{shown.prs.length} open</span>

  return (
    <div className="pr-section">
      <div className="pr-status">
        {status}
        {refresh}
      </div>
      {shown?.prs?.map((pr) => {
        const current = isCurrent(pr, currentBranch, baseSlug)
        return (
          <div
            key={pr.number}
            className={`sb-item pr-item${current ? ' current' : ''}`}
            role="button"
            tabIndex={0}
            title={`#${pr.number} ${pr.title}\n${headLabel(pr, baseSlug)} → ${pr.baseRef}${
              pr.author ? `\nby ${pr.author}` : ''
            }, updated ${fullDate(pr.updatedAt)}`}
            onClick={(e) => openMenu(pr, e.clientX, e.clientY)}
            onContextMenu={(e) => {
              e.preventDefault()
              openMenu(pr, e.clientX, e.clientY)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ContextMenu') return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              openMenu(pr, r.left + 24, r.bottom)
            }}
          >
            {busy === pr.number ? (
              <Loader2 size={16} className="spin pr-avatar" />
            ) : pr.author || pr.authorAvatar ? (
              <Avatar
                name={pr.author ?? '?'}
                src={pr.authorAvatar}
                size={16}
                className="pr-avatar"
              />
            ) : (
              <GitPullRequest size={14} className="pr-avatar" />
            )}
            <span className="pr-text">
              <span className="pr-title">
                <span className="pr-number">#{pr.number}</span> {pr.title}
              </span>
              <span className="pr-branches">
                {headLabel(pr, baseSlug)} → {pr.baseRef} · {relativeTime(pr.updatedAt)}
              </span>
            </span>
            {pr.draft && <span className="badge muted pr-draft">Draft</span>}
          </div>
        )
      })}
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </div>
  )
}
