import {
  CircleAlert,
  CircleCheck,
  CloudDownload,
  Ellipsis,
  FolderGit2,
  FolderSearch,
  GitBranch,
  GitFork,
  Globe,
  Layers,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  TriangleAlert
} from 'lucide-react'
import { memo, useEffect, useMemo, useState } from 'react'
import type { Account, AppState, RepoSummary, Workspace } from '../../../shared/types'
import { PROVIDER_LABELS, type RemoteInfo } from '../../../shared/features/hosting'
import { errorMessage, LOCALE, relativeTime, repoName } from '../lib/format'
import { editorName, openFolderLabel } from '../lib/platform'
import { AccountBar, CloneDialog } from './GitHub'
import { AddAccountDialog } from './hosting/AddAccountDialog'
import { CloneOrganizationDialog } from './hosting/CloneOrganizationDialog'
import { accountLabel } from './hosting/labels'
import { ProviderBadge } from './hosting/ProviderBadge'
import {
  cardsToRead,
  sameData,
  shouldAskAvatar,
  singleFlight,
  useEvent,
  useNow
} from './shell/refresh'
import { TrustBadge } from './trust/TrustBadge'
import { Avatar, ContextMenu, type MenuState } from './ui'
import { useDialogs, useToasts } from './ui-context'
import '../assets/hosting.css'

// Kept while the Projects page is not shown (Home unmounts it): coming back shows the
// cards at once, and reads them again only when they are old, or changed meanwhile.
const cache = { summaries: new Map<string, RepoSummary>(), loadedAt: 0 }
/** Repositories changed since their card was read (a tab's watcher or a sync said so). */
const changedRepos = new Set<string>()
let listening = false
/** Once, for the whole session: it notes the changes while the page is not shown. */
function listenForChanges(): void {
  if (listening) return
  listening = true
  window.api.onRepoChanged((repo) => changedRepos.add(repo))
}
/** Last commit author's picture per repository, email, accounts and Gravatar setting. */
const avatarCache = new Map<string, { src: string | null; at: number }>()
const avatarPending = new Set<string>()
/**
 * The cards showing each avatar key. An answer re-renders whichever card is mounted now:
 * the Projects page may have been shown again (new cards) while the request ran.
 */
const avatarWaiters = new Map<string, Set<() => void>>()

function avatarFound(key: string, src: string | null): void {
  avatarCache.set(key, { src, at: Date.now() })
  for (const show of avatarWaiters.get(key) ?? []) show()
}
/** Focus or coming back to the page: the cards are read again when older than this. */
const STALE_MS = 30_000
/** No picture found: asked again after this (the main process decides when to look again). */
const AVATAR_MISS_MS = 5 * 60_000

const BAR_W = 6
const BAR_GAP = 3
const SPARK_H = 30

/** Commits per day for the last 30 days; today in the accent color, earlier days de-emphasized. */
function Activity({ values }: { values: number[] }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...values)
  const total = values.reduce((a, b) => a + b, 0)
  const width = values.length * (BAR_W + BAR_GAP) - BAR_GAP
  const dayLabel = (i: number): string => {
    const d = new Date()
    d.setDate(d.getDate() - (values.length - 1 - i))
    return d.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })
  }
  return (
    <div className="activity">
      <div className="activity-label">
        <strong>{total}</strong> commit{total === 1 ? '' : 's'} in the last 30 days
      </div>
      <div className="activity-chart" onMouseLeave={() => setHover(null)}>
        <svg
          width={width}
          height={SPARK_H}
          role="img"
          aria-label={`${total} commits in the last 30 days`}
        >
          <line x1={0} x2={width} y1={SPARK_H - 0.5} y2={SPARK_H - 0.5} className="spark-base" />
          {values.map((v, i) => {
            const x = i * (BAR_W + BAR_GAP)
            const h = v === 0 ? 0 : Math.max(3, (v / max) * (SPARK_H - 2))
            const today = i === values.length - 1
            const r = Math.min(2, h / 2)
            const y = SPARK_H - 1 - h
            return (
              <g key={i}>
                {h > 0 && (
                  <path
                    className={
                      today ? 'spark-bar today' : hover === i ? 'spark-bar hover' : 'spark-bar'
                    }
                    d={`M${x} ${SPARK_H - 1}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + BAR_W - r}Q${x + BAR_W} ${y} ${x + BAR_W} ${y + r}V${SPARK_H - 1}Z`}
                  />
                )}
                {/* Hit target taller and wider than the bar. */}
                <rect
                  x={x - BAR_GAP / 2}
                  y={0}
                  width={BAR_W + BAR_GAP}
                  height={SPARK_H}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                />
              </g>
            )
          })}
        </svg>
        {hover !== null && (
          <div className="spark-tip" style={{ left: hover * (BAR_W + BAR_GAP) + BAR_W / 2 }}>
            <span className="muted">{dayLabel(hover)}</span>
            <strong>
              {values[hover]} commit{values[hover] === 1 ? '' : 's'}
            </strong>
          </div>
        )}
      </div>
    </div>
  )
}

/** Memoized: a reload that changed nothing on a repository skips its card. */
const RepoCard = memo(function RepoCard({
  path,
  summary,
  remote,
  worktreeOf,
  accounts,
  accountsKey,
  gravatar,
  showAvatars,
  now,
  onOpen,
  onMenu
}: {
  path: string
  summary: RepoSummary | undefined
  remote: RemoteInfo | null | undefined
  /** Main repository when this is a worktree. */
  worktreeOf: string | null
  accounts: Account[]
  /** Changes on sign-in / sign-out: pictures are looked up again. */
  accountsKey: string
  /** Settings' useGravatar: changing it looks pictures up again. */
  gravatar: boolean
  showAvatars: boolean
  /** The time (useNow): relative dates move on, and missing pictures are asked again. */
  now: number
  onOpen(path: string): void
  onMenu(e: React.MouseEvent, path: string): void
}): React.JSX.Element {
  const s = summary
  const last = s?.lastCommit ?? null
  const email = last?.email ?? ''
  const sha = last?.sha ?? ''
  // Once per repository, author, accounts and setting (not on every reload of the cards);
  // a miss is asked again a few minutes later (offline, rate limit).
  const avatarKey = `${path}\0${email.toLowerCase()}\0${accountsKey}\0${gravatar}`
  const [, setAvatarLoaded] = useState(0)

  useEffect(() => {
    const show = (): void => setAvatarLoaded((n) => n + 1)
    let waiters = avatarWaiters.get(avatarKey)
    if (!waiters) avatarWaiters.set(avatarKey, (waiters = new Set()))
    waiters.add(show)
    return () => {
      waiters.delete(show)
      if (!waiters.size && avatarWaiters.get(avatarKey) === waiters) avatarWaiters.delete(avatarKey)
    }
  }, [avatarKey])

  useEffect(() => {
    if (!showAvatars || !email || avatarPending.has(avatarKey)) return
    const hit = avatarCache.get(avatarKey)
    if (!shouldAskAvatar(hit, Date.now(), AVATAR_MISS_MS)) return
    avatarPending.add(avatarKey)
    const found = (src: string | null): void => avatarFound(avatarKey, src)
    window.api
      .avatars(path, [{ email, sha }])
      .then(
        (map) => found(map[email.toLowerCase()] ?? null),
        () => found(null) // a miss: asked again later
      )
      .finally(() => avatarPending.delete(avatarKey))
  }, [path, showAvatars, email, sha, avatarKey, now])

  const account = s?.account ? accounts.find((a) => a.id === s.account) : undefined
  // The summary knows github.com; other hosts come from remotesOf.
  const where = remote?.provider
    ? { provider: remote.provider, text: `${remote.host}/${remote.slug}` }
    : s?.github
      ? { provider: 'github' as const, text: `github.com/${s.github}` }
      : null
  return (
    <div
      className={s && !s.ok ? 'card broken' : 'card'}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(path)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(path)}
      onContextMenu={(e) => onMenu(e, path)}
    >
      <div className="card-top">
        <FolderGit2 size={18} className="card-icon" />
        <span className="card-name">{repoName(path)}</span>
        <TrustBadge repo={path} />
        {worktreeOf && (
          <span className="badge muted card-worktree" title={`Worktree of ${worktreeOf}`}>
            <GitFork size={11} /> worktree of {repoName(worktreeOf)}
          </span>
        )}
        {s?.branch && (
          <span className="card-branch" title="Current branch">
            <GitBranch size={12} /> {s.branch}
          </span>
        )}
      </div>
      <div className="card-path" title={path}>
        {path}
      </div>
      {where && (
        <div
          className="card-remote"
          title={
            account
              ? `Followed with ${accountLabel(account)}`
              : `On ${PROVIDER_LABELS[where.provider]}`
          }
        >
          {account ? (
            <Avatar name={account.login} src={account.avatar} size={14} />
          ) : where.provider === 'github' ? (
            <Globe size={12} />
          ) : (
            <ProviderBadge source={where.provider} size={14} />
          )}
          <span>{where.text}</span>
          {s?.lastFetch && <span>· fetched {relativeTime(s.lastFetch)}</span>}
        </div>
      )}

      {!s && <div className="card-loading">Reading…</div>}
      {s && !s.ok && (
        <div className="status bad">
          <TriangleAlert size={14} /> {s.error}
        </div>
      )}
      {s && s.ok && (
        <>
          <div className="card-status">
            {s.conflicts > 0 ? (
              <span className="status bad">
                <TriangleAlert size={14} /> {s.conflicts} conflict{s.conflicts > 1 ? 's' : ''}
              </span>
            ) : s.changes > 0 ? (
              <span className="status warn">
                <TriangleAlert size={14} /> {s.changes} uncommitted change{s.changes > 1 ? 's' : ''}
              </span>
            ) : (
              <span className="status ok">
                <CircleCheck size={14} /> Clean
              </span>
            )}
            {s.ahead > 0 && (
              <span className="badge" title="Commits not pushed yet">
                ↑{s.ahead} to push
              </span>
            )}
            {s.behind > 0 && (
              <span className="badge" title="Commits on the remote you don't have">
                ↓{s.behind} to pull
              </span>
            )}
            {s.branch && !s.upstream && s.lastCommit && (
              <span className="badge muted">not on a remote</span>
            )}
            {s.fetchError && (
              <span className="status bad" title={s.fetchError}>
                <CircleAlert size={14} /> Sync failed
              </span>
            )}
          </div>
          <div className="card-last-row">
            {last && showAvatars && (
              <Avatar name={last.author} src={avatarCache.get(avatarKey)?.src ?? null} size={28} />
            )}
            <div className="card-last">
              {last ? (
                <>
                  <span className="card-subject">{last.subject}</span>
                  <span className="muted">
                    {last.author} · {relativeTime(last.date)}
                  </span>
                </>
              ) : (
                <span className="muted">No commits yet</span>
              )}
            </div>
          </div>
          <Activity values={s.activity} />
        </>
      )}
    </div>
  )
})

interface Props {
  state: AppState
  accounts: Account[]
  onOpen(path: string): void
  onStateChange(state: AppState): void
  onAccounts(accounts: Account[]): void
  onSignIn(): void
}

/** Windows paths are case-insensitive (the main process compares them the same way). */
const samePath = (a: string, b: string): boolean =>
  window.api.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

const WORKSPACE_KEY = 'gitdesk.dashboard.workspace'
const ALL = ''
const NEW = '\0new'

function readSelected(): string {
  try {
    return localStorage.getItem(WORKSPACE_KEY) ?? ALL
  } catch {
    return ALL
  }
}

function newId(): string {
  return `ws-${crypto.randomUUID()}`
}

export function Dashboard({
  state,
  accounts,
  onOpen,
  onStateChange,
  onAccounts,
  onSignIn
}: Props): React.JSX.Element {
  const toasts = useToasts()
  const dialogs = useDialogs()
  const [summaries, setSummaries] = useState(() => new Map(cache.summaries))
  const [remotes, setRemotes] = useState<Record<string, RemoteInfo | null>>({})
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dialog, setDialog] = useState<'clone' | 'account' | 'org' | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [selected, setSelected] = useState(readSelected)
  // The same list keeps the same identity (a new state object is not a new list).
  const reposKey = state.repos.join('\0')
  const repos = useMemo(() => (reposKey ? reposKey.split('\0') : []), [reposKey])
  const now = useNow()
  useEffect(listenForChanges, [])
  const workspaces = state.workspaces
  const workspace = workspaces.find((w) => w.id === selected) ?? null

  const select = (id: string): void => {
    setSelected(id)
    try {
      localStorage.setItem(WORKSPACE_KEY, id)
    } catch {
      /* private mode: not remembered */
    }
  }

  /** Reads the summaries of `list`; the cards update in batches, unchanged ones not at all. */
  const summarize = useEvent(async (list: string[]): Promise<void> => {
    const queue = [...list]
    let changed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = (): void => {
      timer = null
      if (!changed) return
      changed = false
      setSummaries(new Map(cache.summaries))
    }
    const worker = async (): Promise<void> => {
      while (queue.length) {
        const repo = queue.shift()!
        changedRepos.delete(repo) // a change from now on is seen by the next read
        try {
          const s = await window.api.summary(repo)
          const old = cache.summaries.get(repo)
          if (old && sameData(old, s)) continue
          cache.summaries.set(repo, s)
          changed = true
          timer ??= setTimeout(flush, 100)
        } catch {
          /* removed while loading */
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker))
    if (timer) clearTimeout(timer)
    flush()
  })

  // Every repository; one pass at a time (focus, timer and sync meanwhile share one more).
  const loadAll = useEvent(async (): Promise<void> => {
    // Set first: a focus while this pass runs does not ask for another one.
    cache.loadedAt = Date.now()
    await summarize(repos)
    for (const path of [...cache.summaries.keys()])
      if (!repos.includes(path)) cache.summaries.delete(path)
  })
  const [flight] = useState(() => singleFlight(() => loadAll()))
  const load = flight.run

  // Shown again: what was read last shows at once. Everything is read again when old, else
  // the new repositories, those changed meanwhile and the open tabs (a tab stops watching
  // as soon as it is hidden: a commit made just before coming back may not be noted yet).
  const [openTabs] = useState(state.openTabs)
  useEffect(() => {
    if (Date.now() - cache.loadedAt > STALE_MS) void load()
    else {
      const stale = cardsToRead(repos, (r) => cache.summaries.has(r), changedRepos, openTabs)
      if (stale.length) void summarize(stale)
    }
  }, [repos, openTabs, load, summarize])

  useEffect(() => {
    const onFocus = (): void => {
      if (Date.now() - cache.loadedAt > STALE_MS) void load()
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') onFocus()
    }
    // Nobody looks at a hidden or background window: focus catches up when it is back.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void load()
    }, 60_000)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    const offSynced = window.api.onReposSynced(() => void load())
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
      offSynced()
    }
  }, [load])

  // Where each repository's origin points (any provider), for the cards and the clone list.
  const accountsKey = accounts.map((a) => a.id).join(',')
  useEffect(() => {
    let cancelled = false
    window.api.remotesOf(repos).then(
      (r) => !cancelled && setRemotes(r),
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [repos, accountsKey])

  // "host|slug" of everything already in GitDesk, so the clone list can say "Following".
  const followed = useMemo(() => {
    const set = new Set<string>()
    for (const s of summaries.values())
      if (s.github) set.add(`github.com|${s.github.toLowerCase()}`)
    for (const r of Object.values(remotes)) if (r) set.add(`${r.host}|${r.slug.toLowerCase()}`)
    return set
  }, [summaries, remotes])

  const syncNow = async (): Promise<void> => {
    setSyncing(true)
    try {
      const result = await window.api.syncNow(workspace ? workspace.repos : undefined)
      if (result.failed.length) {
        const names = result.failed.map((f) => repoName(f.repo)).join(', ')
        toasts.error(`Could not fetch ${names}. Hover “Sync failed” on a card for details.`)
      } else if (result.fetched) {
        toasts.info(`Fetched ${result.fetched} repositor${result.fetched === 1 ? 'y' : 'ies'}`)
      } else {
        toasts.info('No repository has a remote to fetch from')
      }
    } catch (e) {
      toasts.error(errorMessage(e))
    } finally {
      setSyncing(false)
    }
  }

  const fetchOne = async (path: string): Promise<void> => {
    try {
      await window.api.fetch(path)
      toasts.info(`Fetched ${repoName(path)}`)
    } catch (e) {
      toasts.error(errorMessage(e))
    } finally {
      // Its card only ("fetched … ago", a fetch error): the others did not change.
      void summarize([path])
    }
  }

  // Most recently active projects first.
  const sorted = useMemo(() => {
    const q = filter.toLowerCase()
    return repos
      .filter((r) => !workspace || workspace.repos.some((p) => samePath(p, r)))
      .filter((r) => !q || r.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          (summaries.get(b)?.lastCommit?.date ?? 0) - (summaries.get(a)?.lastCommit?.date ?? 0)
      )
  }, [repos, summaries, filter, workspace])

  const dirty = [...summaries.values()].filter((s) => s.ok && (s.changes > 0 || s.ahead > 0)).length

  const run = async (fn: () => Promise<AppState>): Promise<void> => {
    try {
      onStateChange(await fn())
    } catch (e) {
      toasts.error(errorMessage(e))
    }
  }

  const saveWorkspaces = (next: Workspace[]): Promise<void> =>
    run(() => window.api.setWorkspaces(next))

  const createWorkspace = async (repos: string[] = []): Promise<string | null> => {
    const name = await dialogs.prompt({
      title: 'New workspace',
      label: 'Name',
      placeholder: 'e.g. Work, Side projects',
      okLabel: 'Create'
    })
    if (!name) return null
    const id = newId()
    await saveWorkspaces([...workspaces, { id, name, repos }])
    return id
  }

  const renameWorkspace = async (w: Workspace): Promise<void> => {
    const name = await dialogs.prompt({
      title: 'Rename workspace',
      label: 'Name',
      initial: w.name,
      okLabel: 'Rename'
    })
    if (name) await saveWorkspaces(workspaces.map((x) => (x.id === w.id ? { ...x, name } : x)))
  }

  const deleteWorkspace = async (w: Workspace): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Delete the workspace “${w.name}”?`,
      message: 'Its repositories stay in GitDesk and on disk.',
      okLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    await saveWorkspaces(workspaces.filter((x) => x.id !== w.id))
    select(ALL)
  }

  const setMembership = (w: Workspace, path: string, member: boolean): Promise<void> =>
    saveWorkspaces(
      workspaces.map((x) =>
        x.id !== w.id
          ? x
          : {
              ...x,
              repos: member
                ? [...x.repos.filter((p) => !samePath(p, path)), path]
                : x.repos.filter((p) => !samePath(p, path))
            }
      )
    )

  const workspaceMenu = (e: React.MouseEvent): void => {
    if (!workspace) return
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: 'Rename workspace…', onClick: () => void renameWorkspace(workspace) },
        {
          label: 'Clone an organization into it…',
          disabled: !accounts.length,
          onClick: () => setDialog('org')
        },
        'separator',
        { label: 'Delete workspace…', danger: true, onClick: () => void deleteWorkspace(workspace) }
      ]
    })
  }

  const cardMenu = (e: React.MouseEvent, path: string): void => {
    e.preventDefault()
    const memberOf = workspaces.filter((w) => w.repos.some((p) => samePath(p, path)))
    const others = workspaces.filter((w) => !memberOf.includes(w))
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Open', onClick: () => onOpen(path) },
        { label: 'Fetch', hint: 'all remotes', onClick: () => fetchOne(path) },
        { label: openFolderLabel, onClick: () => window.api.openFolder(path) },
        {
          label: `Open in ${editorName(state.settings.editor)}`,
          onClick: () => window.api.openInEditor(path)
        },
        'separator',
        ...others.map((w) => ({
          label: `Add to workspace ▸ ${w.name}`,
          onClick: () => void setMembership(w, path, true)
        })),
        {
          label: 'Add to workspace ▸ New workspace…',
          onClick: async () => {
            const id = await createWorkspace([path])
            if (id) select(id)
          }
        },
        ...memberOf.map((w) => ({
          label:
            memberOf.length > 1 ? `Remove from workspace “${w.name}”` : 'Remove from workspace',
          hint: memberOf.length > 1 ? undefined : w.name,
          onClick: () => void setMembership(w, path, false)
        })),
        'separator',
        {
          label: 'Remove from GitDesk',
          hint: 'files are kept',
          danger: true,
          onClick: () => run(() => window.api.removeRepo(path))
        }
      ]
    })
  }

  const openCard = useEvent(onOpen)
  const onCardMenu = useEvent(cardMenu)

  const onWorkspaceChange = async (value: string): Promise<void> => {
    if (value !== NEW) return select(value)
    const id = await createWorkspace()
    if (id) select(id)
  }

  return (
    <div className="dashboard">
      <div className="dash-header">
        <div>
          <h1>Projects</h1>
          <div className="muted">
            {workspace
              ? `${sorted.length} of ${repos.length} repositories in this workspace`
              : `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}`}
            {dirty > 0 && ` · ${dirty} with work not committed or not pushed`}
          </div>
        </div>
        <div className="workspace-picker">
          <select
            className="input"
            aria-label="Workspace"
            value={workspace ? workspace.id : ALL}
            onChange={(e) => void onWorkspaceChange(e.target.value)}
          >
            <option value={ALL}>All repositories</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.repos.length})
              </option>
            ))}
            <option value={NEW}>New workspace…</option>
          </select>
          {workspace && (
            <button
              className="icon-btn"
              aria-label="Workspace actions"
              title="Rename, delete, clone an organization into it"
              onClick={workspaceMenu}
            >
              <Ellipsis size={15} />
            </button>
          )}
        </div>
        <span className="spacer" />
        <div className="dash-filter">
          <Search size={14} />
          <input
            placeholder="Filter projects"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <button
          className="btn"
          onClick={() => void load()}
          title="Reload the status of every project (no network)"
          aria-label="Reload status"
        >
          <RefreshCw size={14} />
        </button>
        {repos.length > 0 &&
          (workspace ? (
            <button
              className="btn"
              onClick={syncNow}
              disabled={syncing || !workspace.repos.length}
              title={`Fetch the repositories of “${workspace.name}” now`}
            >
              {syncing ? <LoaderCircle size={14} className="spin" /> : <RotateCw size={14} />} Sync
              workspace
            </button>
          ) : (
            <button
              className="btn"
              onClick={syncNow}
              disabled={syncing}
              title="Fetch every repository that has a remote now"
            >
              {syncing ? <LoaderCircle size={14} className="spin" /> : <RotateCw size={14} />} Sync
            </button>
          ))}
        <button className="btn" onClick={() => run(() => window.api.scanFolder())}>
          <FolderSearch size={14} /> Scan a folder
        </button>
        <button className="btn" onClick={() => run(() => window.api.addRepo())}>
          <Plus size={14} /> Open repository
        </button>
        <button
          className="btn primary"
          onClick={() => setDialog('clone')}
          aria-label="Clone from GitHub, GitLab, Bitbucket or Azure DevOps"
          title="Clone from GitHub, GitLab, Bitbucket or Azure DevOps, or from any link"
        >
          <CloudDownload size={14} /> Clone
        </button>
      </div>
      <div className="dash-accounts">
        <AccountBar
          accounts={accounts}
          onAccounts={onAccounts}
          onSignIn={onSignIn}
          onAddAccount={() => setDialog('account')}
        />
      </div>

      {repos.length === 0 ? (
        <div className="dash-empty">
          <FolderGit2 size={40} />
          <h2>Follow your projects</h2>
          <p>
            Add a repository, or scan a folder that holds your projects to add every repository in
            it at once.
          </p>
          <div className="dash-empty-actions">
            <button className="btn" onClick={() => run(() => window.api.scanFolder())}>
              <FolderSearch size={14} /> Scan a folder
            </button>
            <button className="btn primary" onClick={() => run(() => window.api.addRepo())}>
              <Plus size={14} /> Open repository
            </button>
          </div>
        </div>
      ) : workspace && !sorted.length && !filter ? (
        <div className="dash-empty">
          <Layers size={40} />
          <h2>“{workspace.name}” is empty</h2>
          <p>
            Right-click a project in <em>All repositories</em> and choose <em>Add to workspace</em>,
            or clone every repository of an organization into it.
          </p>
          <div className="dash-empty-actions">
            <button className="btn" onClick={() => select(ALL)}>
              Show all repositories
            </button>
            <button
              className="btn primary"
              disabled={!accounts.length}
              onClick={() => setDialog('org')}
            >
              <CloudDownload size={14} /> Clone an organization…
            </button>
          </div>
        </div>
      ) : (
        <div className="cards">
          {sorted.map((path) => (
            <RepoCard
              key={path}
              path={path}
              summary={summaries.get(path)}
              remote={remotes[path]}
              worktreeOf={state.worktreeParents[path] ?? null}
              accounts={accounts}
              accountsKey={accountsKey}
              gravatar={state.settings.useGravatar}
              showAvatars={state.settings.showAvatars}
              now={now}
              onOpen={openCard}
              onMenu={onCardMenu}
            />
          ))}
        </div>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {dialog === 'clone' && (
        <CloneDialog
          accounts={accounts}
          settings={state.settings}
          followed={followed}
          onClose={() => setDialog(null)}
          onSettings={onStateChange}
          onSignIn={onSignIn}
          onCloned={({ state: next, path }) => {
            setDialog(null)
            onStateChange(next)
            onOpen(path)
            toasts.info(`Cloned ${repoName(path)}`)
          }}
        />
      )}
      {dialog === 'account' && (
        <AddAccountDialog
          settings={state.settings}
          onSettings={onStateChange}
          onClose={() => setDialog(null)}
          onAdded={(account) => {
            setDialog(null)
            onAccounts([...accounts.filter((a) => a.id !== account.id), account])
            toasts.info(`Signed in as ${accountLabel(account)}`)
          }}
        />
      )}
      {dialog === 'org' && (
        <CloneOrganizationDialog
          state={state}
          accounts={accounts}
          workspaceId={workspace?.id ?? null}
          onClose={() => setDialog(null)}
          onDone={(next, workspaceId) => {
            onStateChange(next)
            if (workspaceId) select(workspaceId)
          }}
        />
      )}
    </div>
  )
}
