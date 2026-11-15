import { PanelRightOpen } from 'lucide-react'
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { paletteFor, ruleColorForBranch, ruleColorsBySha } from '../../../shared/branchColors'
import type {
  AppState,
  AvatarMap,
  Commit,
  FileChange,
  RefsInfo,
  Settings,
  Stash,
  UndoInfo
} from '../../../shared/types'
import '../assets/repo.css'
import type { DraggedBranch } from '../lib/branchDrag'
import { errorMessage, repoName, shortSha } from '../lib/format'
import { layoutGraph } from '../lib/graph'
import {
  expandPanel,
  panelModes,
  setTerminalMaximized,
  toggleFocus,
  togglePanel,
  usePanelLayout
} from '../lib/layout'
import { usePanelWidths } from '../lib/panelWidths'
import { useResolvedTheme } from '../lib/theme'
import { matchShortcut, titled, type ShortcutId } from '../lib/shortcuts'
import { CommitGraph, WIP_SHA, type RefLabel } from './CommitGraph'
import { DiffView, type HunkAction } from './DiffView'
import { useAiAvailable } from './ai/useAi'
import { FileHistoryView } from './FileHistory'
import { RepoToolbar } from './RepoToolbar'
import {
  commitMenu,
  dropMenu,
  moreMenu,
  pullMenu,
  refMenu,
  stashMenu,
  type MenuContext,
  type PatchSpec
} from './repoMenus'
import { Resizer } from './Resizer'
import { SearchBar } from './SearchBar'
import { useCenterView } from './shell/centerView'
import { RepoDialogs, type RepoDialog } from './shell/RepoDialogs'
import {
  appendPage,
  applySnapshot,
  EMPTY_VIEW,
  sameData,
  singleFlight,
  useEvent,
  useNow,
  type ViewData
} from './shell/refresh'
import { TerminalDock } from './shell/TerminalDock'
import { toggleTerminal, type TerminalState } from './shell/terminalState'
import { CommitPanel, WorkingCopyPanel, type Act } from './SidePanels'
import { Sidebar } from './Sidebar'
import { TrustBanner } from './trust/TrustBanner'
import { ContextMenu, type MenuItem, type MenuState } from './ui'
import { useDialogs, useToasts } from './ui-context'
import { isolateText } from '../lib/highlight'

// Loaded when first opened, not at startup.
const CompareView = lazy(() =>
  import('./gitextras/CompareView').then((m) => ({ default: m.CompareView }))
)

const PAGE = 1500
/** One empty map, so the memoized commit panel sees the same props when pictures are off. */
const NO_AVATARS: AvatarMap = {}
/** A focus right after a refresh brings nothing new (the watcher saw any change). */
const FOCUS_REFRESH_MS = 2000

function buildRefLabels(refs: RefsInfo): Map<string, RefLabel[]> {
  const map = new Map<string, RefLabel[]>()
  const add = (sha: string, label: RefLabel): void => {
    if (!map.has(sha)) map.set(sha, [])
    map.get(sha)!.push(label)
  }
  // A local branch sitting on the same commit as its upstream gets one pill with a cloud.
  const hiddenRemotes = new Set<string>()
  for (const b of refs.branches) {
    const upstream = refs.remoteBranches.find((rb) => rb.fullName === b.upstream)
    const synced = !!upstream && upstream.sha === b.sha
    if (synced) hiddenRemotes.add(upstream.fullName)
    add(b.sha, { kind: 'local', name: b.name, current: b.isHead, synced })
  }
  if (!refs.headBranch && refs.headSha)
    add(refs.headSha, { kind: 'head', name: 'HEAD (detached)', current: true })
  for (const rb of refs.remoteBranches) {
    if (!hiddenRemotes.has(rb.fullName)) add(rb.sha, { kind: 'remote', name: rb.fullName })
  }
  for (const t of refs.tags) add(t.sha, { kind: 'tag', name: t.name })
  for (const labels of map.values())
    labels.sort((a, b) => Number(!!b.current) - Number(!!a.current))
  return map
}

const pathsOf = (file: FileChange): string[] =>
  file.origPath ? [file.origPath, file.path] : [file.path]

export const RepoView = memo(function RepoView({
  repo,
  active,
  settings,
  worktreeOf,
  getState,
  accountsKey,
  onOpenRepo,
  onStateChange
}: {
  repo: string
  active: boolean
  settings: Settings
  /** The main repository when this one is a worktree of it (AppState.worktreeParents). */
  worktreeOf: string | null
  /**
   * The app state as it is now, for the dialogs that need it. A function, not the state
   * itself: every state change (a tab switch) would otherwise re-render every tab.
   */
  getState(): AppState | null
  /** Changes on sign-in / sign-out, so profile pictures are looked up again. */
  accountsKey: string
  /** Opens (or shows) a repository tab, e.g. a worktree. */
  onOpenRepo(path: string): void
  onStateChange(state: AppState): void
}): React.JSX.Element {
  const toasts = useToasts()
  const dialogs = useDialogs()
  // refs, status, stashes and commits: replaced together, each kept while unchanged.
  const [view, setView] = useState<ViewData>(EMPTY_VIEW)
  const { refs, status, stashes, commits } = view
  const [limit, setLimit] = useState(PAGE)
  const [chosen, setSelected] = useState<string | null>(null)
  const center = useCenterView()
  const diffTarget = center.diffTarget
  const [busy, setBusy] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [avatars, setAvatars] = useState<AvatarMap>({})
  // A render a minute while shown, so relative dates (graph rows, stashes) move on although
  // an unchanged refresh renders nothing.
  const now = useNow(active)
  const [undo, setUndo] = useState<UndoInfo | null>(null)
  const [github, setGithub] = useState<string | null>(null)
  /** origin is on a hosting service GitDesk knows (GitHub, GitLab, Bitbucket, Azure DevOps). */
  const [hosted, setHosted] = useState(false)
  const [matches, setMatches] = useState<Set<string> | null>(null)
  const [dialog, setDialog] = useState<RepoDialog | null>(null)
  const [terminal, setTerminal] = useState<TerminalState>('closed')
  const ai = useAiAvailable()
  const data = useRef<ViewData>(EMPTY_VIEW)
  const limitRef = useRef(PAGE)
  const undoRef = useRef<UndoInfo | null>(null)
  const errorRef = useRef<string | null>(null)
  const loadingMore = useRef(false)
  const hadConflicts = useRef(false)
  const viewRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const widths = usePanelWidths()
  const panelLayout = usePanelLayout()
  const modes = panelModes(panelLayout)
  const showAvatars = settings.showAvatars

  const showError = (message: string | null): void => {
    if (errorRef.current === message) return
    errorRef.current = message
    setLoadError(message)
  }

  // App keeps one RepoView per repository (keyed by its path): `repo` never changes here.
  const load = useEvent(async (): Promise<void> => {
    // Undo availability is optional: a failure there must not break the view.
    window.api.undoInfo(repo).then(
      (info) => {
        if (sameData(undoRef.current, info)) return
        undoRef.current = info
        setUndo(info)
      },
      () => {
        // Unknown now: never offer an undo that may no longer be valid.
        if (undoRef.current === null) return
        undoRef.current = null
        setUndo(null)
      }
    )
    try {
      const asked = limitRef.current
      const snap = await window.api.snapshot(repo, asked, data.current.known)
      // "Load more" meanwhile, and this list is shorter: one more pass reads the longer one.
      if (snap.log && asked !== limitRef.current) void refresh()
      const { next, changed } = applySnapshot(data.current, snap)
      data.current = next
      // An action stopped on conflicts: show the working copy with its conflicts and banner.
      const conflicts = snap.status.conflicted.length > 0
      if (conflicts && !hadConflicts.current) setSelected(WIP_SHA)
      hadConflicts.current = conflicts
      if (changed) setView(next)
      showError(null)
      // A working-copy diff can change while the file list stays the same (one more edit).
      const workingDiff = center.view.kind === 'diff' && center.view.target.kind !== 'commit'
      if (changed || workingDiff) setVersion((v) => v + 1)
    } catch (e) {
      showError(errorMessage(e))
    }
  })
  // One refresh at a time: the watcher, focus and actions calling meanwhile share one more.
  const [flight] = useState(() => singleFlight(() => load()))
  const refresh = flight.run

  useEffect(() => {
    if (!active) return
    void refresh()
    window.api.watch(repo)
    const off = window.api.onRepoChanged((changed) => changed === repo && refresh())
    const onFocus = (): void => {
      if (Date.now() - flight.lastDone() > FOCUS_REFRESH_MS) void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
      window.api.unwatch(repo)
    }
  }, [active, repo, refresh, flight])

  /** "Load more": only the next page of the history, unless it moved meanwhile. */
  const loadMore = useEvent(async (): Promise<void> => {
    if (loadingMore.current) return
    loadingMore.current = true
    const before = data.current
    const nextLimit = limitRef.current + PAGE
    let page: Awaited<ReturnType<typeof window.api.logPage>> = null
    try {
      if (before.known)
        page = await window.api.logPage(repo, before.commits.length, PAGE, before.known.refsKey)
    } catch {
      page = null
    }
    const now = data.current
    const next = page && now.logSignature === before.logSignature ? appendPage(now, page) : null
    limitRef.current = nextLimit
    setLimit(nextLimit)
    if (next) {
      data.current = next
      setView(next)
    } else {
      // Read the whole list again, with the new length.
      if (now.known) data.current = { ...now, known: { ...now.known, logKey: '' } }
      void refresh()
    }
    loadingMore.current = false
  })

  // Where origin is hosted, and its github.com "owner/repo" for pull request links: read
  // once, when the tab is first shown (tabs restored in the background wait). The answer
  // is kept even if the effect was cleaned up meanwhile: this view (`repo` never changes)
  // still wants it, and React's StrictMode runs effects twice on the same instance.
  const hosting = useRef<'unread' | 'reading' | 'read'>('unread')
  useEffect(() => {
    if (!active || hosting.current !== 'unread') return
    hosting.current = 'reading'
    window.api.remotesOf([repo]).then(
      (r) => {
        hosting.current = 'read'
        const info = r[repo]
        setHosted(!!info?.provider)
        setGithub(info?.provider === 'github' && info.host === 'github.com' ? info.slug : null)
      },
      () => {
        hosting.current = 'unread' // asked again the next time the tab is shown
      }
    )
  }, [active, repo])

  const hasChanges =
    !!status &&
    (status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.conflicted.length > 0 ||
      !!status.operation)

  const headSha = status?.headSha ?? null

  // Default selection: the work in progress if any, otherwise HEAD.
  const selected =
    chosen === null || (chosen === WIP_SHA && !hasChanges)
      ? hasChanges
        ? WIP_SHA
        : headSha
      : chosen

  const graphCommits = useMemo<Commit[]>(() => {
    if (!hasChanges) return commits
    const wip: Commit = {
      sha: WIP_SHA,
      parents: headSha ? [headSha] : [],
      author: '',
      email: '',
      date: 0,
      subject: ''
    }
    return [wip, ...commits]
  }, [commits, hasChanges, headSha])

  const loaded = useMemo(() => new Set(commits.map((c) => c.sha)), [commits])
  const isLoaded = useCallback((sha: string) => loaded.has(sha), [loaded])

  // Profile pictures: one sample commit per author email (the main process caches them).
  // Only authors not asked for yet: "Load more" asks for the new ones.
  const asked = useRef({ scope: '', emails: new Set<string>() })
  useEffect(() => {
    if (!active || !showAvatars || !commits.length) return
    const scope = `${repo}\0${accountsKey}`
    if (asked.current.scope !== scope) asked.current = { scope, emails: new Set() }
    const { emails } = asked.current
    const replace = emails.size === 0
    const authors = new Map<string, string>()
    for (const c of commits) {
      const email = (c.email ?? '').toLowerCase()
      if (email && !emails.has(email) && !authors.has(email)) authors.set(email, c.sha)
      if (authors.size >= 500) break // the most the main process takes at once
    }
    if (!authors.size) return
    for (const email of authors.keys()) emails.add(email)
    let settled = false
    const retry = (): void => {
      for (const email of authors.keys()) emails.delete(email)
    }
    window.api
      .avatars(
        repo,
        [...authors].map(([email, sha]) => ({ email, sha }))
      )
      .then(
        (map) => {
          if (settled) return
          settled = true
          setAvatars((prev) => (replace ? map : { ...prev, ...map }))
        },
        () => {
          settled = true
          retry()
        }
      )
    return () => {
      // Dropped before its answer: asked again next time.
      if (!settled) retry()
      settled = true
    }
  }, [active, showAvatars, commits, repo, accountsKey])
  const refsBySha = useMemo(
    () => (refs ? buildRefLabels(refs) : new Map<string, RefLabel[]>()),
    [refs]
  )

  // Branch colors: rules recolor the lanes of matching branches, their labels and icons.
  const theme = useResolvedTheme()
  const branchColors = settings.branchColors
  const rules = branchColors.rules
  const ruleColors = useMemo(
    () => (rules.length ? ruleColorsBySha(refsBySha, rules, theme) : undefined),
    [refsBySha, rules, theme]
  )
  const layout = useMemo(() => layoutGraph(graphCommits, ruleColors), [graphCommits, ruleColors])
  const branchColor = useCallback(
    (kind: RefLabel['kind'], name: string): string | undefined =>
      rules.length ? ruleColorForBranch(rules, kind, name, theme) : undefined,
    [rules, theme]
  )
  const customPalette = useMemo(
    () => (branchColors[theme].length ? paletteFor(branchColors, theme) : null),
    [branchColors, theme]
  )

  const act: Act = useCallback(
    async (label, fn, done) => {
      setBusy(label)
      try {
        await fn()
        if (done) toasts.info(done)
        return true
      } catch (e) {
        toasts.error(errorMessage(e))
        return false
      } finally {
        setBusy(null)
        refresh()
      }
    },
    [refresh, toasts]
  )

  const { followSelection } = center
  const selectSha = useCallback(
    (sha: string) => {
      setSelected(sha)
      followSelection(sha)
    },
    [followSelection]
  )

  /** Ctrl/⌘+click on a commit in the graph: compare it with the selected one. */
  const compareWithSelected = (sha: string): void => {
    if (!selected || selected === WIP_SHA || selected === sha) {
      selectSha(sha)
      return
    }
    center.openCompare(selected, sha)
  }

  // ---- actions ------------------------------------------------------------

  const currentBranch = status?.branch ?? null

  const createBranch = async (startPoint: string | null): Promise<void> => {
    const name = await dialogs.prompt({
      title: 'Create a branch',
      label: startPoint
        ? `Starting at commit ${shortSha(startPoint)}`
        : `Starting at ${isolateText(currentBranch ?? 'HEAD')}`,
      placeholder: 'feature/my-change',
      okLabel: 'Create and check out'
    })
    if (name)
      await act(
        'Creating branch',
        () => window.api.createBranch(repo, name, startPoint, true),
        `Switched to ${isolateText(name)}`
      )
  }

  const checkoutLabel = (label: RefLabel): void => {
    if (label.current) return
    if (label.kind === 'local')
      act('Checking out', () => window.api.checkout(repo, label.name), `Switched to ${label.name}`)
    else if (label.kind === 'remote')
      act(
        'Checking out',
        () => window.api.checkoutRemote(repo, label.name),
        `Checked out ${isolateText(label.name)}`
      )
    else if (label.kind === 'tag') act('Checking out', () => window.api.checkout(repo, label.name))
  }

  const deleteBranch = async (name: string): Promise<void> => {
    if (
      !(await dialogs.confirm({
        title: `Delete branch ${isolateText(name)}?`,
        okLabel: 'Delete',
        danger: true
      }))
    )
      return
    setBusy('Deleting branch')
    try {
      await window.api.deleteBranch(repo, name, false)
      toasts.info(`Deleted ${isolateText(name)}`)
    } catch (e) {
      const message = errorMessage(e)
      if (/not fully merged/i.test(message)) {
        const force = await dialogs.confirm({
          title: `${isolateText(name)} is not fully merged`,
          message:
            'Its commits are not in your current branch. Delete it anyway? Those commits may be lost.',
          okLabel: 'Force delete',
          danger: true
        })
        if (force)
          await act(
            'Deleting branch',
            () => window.api.deleteBranch(repo, name, true),
            `Deleted ${isolateText(name)}`
          )
      } else toasts.error(message)
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const sync = (): Promise<boolean> =>
    act('Syncing', () => window.api.fetch(repo), 'Synced with all remotes')
  const pull = (): Promise<boolean> =>
    act('Pulling', () => window.api.pull(repo, 'ff-only'), 'Pulled')
  const push = (): Promise<boolean> => act('Pushing', () => window.api.push(repo, false), 'Pushed')

  const stashChanges = async (): Promise<void> => {
    // The prompt needs a value: keeping this default lets git write its usual message.
    const fallback = `WIP on ${currentBranch ?? 'detached HEAD'}`
    const message = await dialogs.prompt({
      title: 'Stash changes',
      label: 'Message (optional: keep the default or describe the work)',
      initial: fallback,
      okLabel: 'Stash'
    })
    if (message !== null)
      await act(
        'Stashing',
        () => window.api.stash(repo, message === fallback ? '' : message),
        'Changes stashed'
      )
  }

  const exportPatch = async (spec: PatchSpec): Promise<void> => {
    try {
      const saved = await window.api.exportPatch(repo, spec)
      if (saved) toasts.info(`Patch saved to ${isolateText(saved)}`)
    } catch (e) {
      toasts.error(errorMessage(e))
    }
  }

  const applyPatchFile = async (): Promise<void> => {
    setBusy('Applying patch')
    try {
      const result = await window.api.applyPatchFile(repo)
      if (result.applied) toasts.info(result.message || 'Patch applied')
      else if (result.message) toasts.error(result.message)
    } catch (e) {
      toasts.error(errorMessage(e))
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const agentStarted = (worktreePath: string, next: AppState): void => {
    onStateChange(next)
    onOpenRepo(worktreePath)
  }

  const runUndo = (): void => {
    if (!undo || busy) return
    act('Undoing', () => window.api.undo(repo), undo.label.replace(/^Undo\b/, 'Undid'))
  }

  const stageAll = (): void => {
    if (!status?.unstaged.length) return
    act('Staging', () => window.api.stage(repo, status.unstaged.flatMap(pathsOf)))
  }

  const openMenu = (e: React.MouseEvent, items: MenuItem[]): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const menuContext = (): MenuContext => ({
    repo,
    refs: refs!,
    status: status!,
    github,
    act,
    dialogs,
    createBranch,
    checkoutLabel,
    deleteBranch,
    openRebase: (base, baseLabel) => setDialog({ kind: 'rebase', base, baseLabel }),
    ai,
    hasChanges,
    compare: center.openCompare,
    explain: (target) => setDialog({ kind: 'explain', target }),
    startAgent: (baseRef) => setDialog({ kind: 'startAgent', baseRef }),
    createPullRequest: (branch) => setDialog({ kind: 'createPullRequest', branch }),
    compose: () => setDialog({ kind: 'composer' }),
    exportPatch,
    applyPatchFile
  })

  const onCommitMenu = (e: React.MouseEvent, c: Commit): void => {
    selectSha(c.sha)
    openMenu(e, commitMenu(menuContext(), c))
  }

  const onRefMenu = (e: React.MouseEvent, label: RefLabel, sha: string): void => {
    selectSha(sha)
    openMenu(e, refMenu(menuContext(), label))
  }

  const onStashMenu = (e: React.MouseEvent, s: Stash): void => {
    selectSha(s.sha)
    openMenu(e, stashMenu(menuContext(), s))
  }

  const onPullMenu = (e: React.MouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: rect.left, y: rect.bottom + 4, items: pullMenu(menuContext()) })
  }

  /** The toolbar's "…" button: patches, agents, AI. */
  const onMoreMenu = (e: React.MouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: rect.right - 260, y: rect.bottom + 4, items: moreMenu(menuContext()) })
  }

  /** Merge / rebase menu at the point where a branch was dropped on the checked-out branch. */
  const onBranchDrop = (e: React.DragEvent, branch: DraggedBranch): void => {
    if (!currentBranch) return
    setMenu({ x: e.clientX, y: e.clientY, items: dropMenu(menuContext(), branch) })
  }

  /** "+N" on a graph row: every branch and tag on that commit. */
  const moreRefsMenu = (e: React.MouseEvent, labels: RefLabel[], sha: string): void => {
    selectSha(sha)
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({
      x: rect.left,
      y: rect.bottom + 4,
      items: labels.map((label) => ({
        label: label.current
          ? `${isolateText(label.name)} (checked out)`
          : `Check out ${isolateText(label.name)}`,
        hint: label.kind === 'local' ? 'branch' : label.kind,
        disabled: !!label.current,
        onClick: () => checkoutLabel(label)
      }))
    })
  }

  /** Double-click on a commit: check out the local branch there, never a detached HEAD. */
  const onRowDoubleClick = (c: Commit): void => {
    const here = refs?.branches.filter((b) => b.sha === c.sha) ?? []
    if (here.length && !here.some((b) => b.isHead))
      checkoutLabel({ kind: 'local', name: here[0].name })
  }

  const pickSearchResult = (c: Commit): void => {
    center.close()
    setSelected(c.sha)
    if (!loaded.has(c.sha))
      toasts.info(
        `${shortSha(c.sha)} is older than the loaded history: its details are on the right.`
      )
  }

  const onHunk = async (action: HunkAction, patch: string): Promise<void> => {
    if (action === 'discard') {
      const ok = await dialogs.confirm({
        title: 'Discard these changes?',
        message: 'This cannot be undone.',
        okLabel: 'Discard',
        danger: true
      })
      if (!ok) return
    }
    const opts = {
      stage: { cached: true, reverse: false },
      unstage: { cached: true, reverse: true },
      discard: { cached: false, reverse: true }
    }[action]
    await act(
      action === 'stage'
        ? 'Staging hunk'
        : action === 'unstage'
          ? 'Unstaging hunk'
          : 'Discarding hunk',
      () => window.api.applyPatch(repo, patch, opts)
    )
  }

  const onFile = async (action: HunkAction): Promise<void> => {
    if (!diffTarget || diffTarget.kind === 'commit') return
    const file = diffTarget.file
    if (action === 'stage') {
      if (await act('Staging', () => window.api.stage(repo, pathsOf(file))))
        center.openDiff({
          kind: 'staged',
          file: { ...file, kind: file.kind === '?' ? 'A' : file.kind }
        })
    } else if (action === 'unstage') {
      if (await act('Unstaging', () => window.api.unstage(repo, pathsOf(file))))
        center.openDiff({ kind: 'unstaged', file })
    } else {
      const ok = await dialogs.confirm({
        title: `Discard changes to ${isolateText(file.path)}?`,
        message: 'This cannot be undone.',
        okLabel: 'Discard',
        danger: true
      })
      if (ok && (await act('Discarding', () => window.api.discard(repo, [file])))) center.close()
    }
  }

  // ---- keyboard shortcuts (only in the active tab) --------------------------

  const runShortcut = (id: ShortcutId): void => {
    if (id === 'search') {
      searchRef.current?.focus()
      searchRef.current?.select()
    } else if (id === 'help') setDialog({ kind: 'help' })
    else if (id === 'terminal') setTerminal(toggleTerminal)
    else if (id === 'sync') sync()
    else if (id === 'pull') pull()
    else if (id === 'push') push()
    else if (id === 'branch') createBranch(null)
    else if (id === 'stash') {
      if (hasChanges) stashChanges()
    } else if (id === 'undo') runUndo()
    else if (id === 'stageAll') stageAll()
    else if (id === 'toggleSidebar') togglePanel('sidebar')
    else if (id === 'toggleDetails') togglePanel('right')
    else if (id === 'focusMode') toggleFocus()
  }

  // Re-registered on every render so the handler always sees the latest state.
  useEffect(() => {
    if (!active || !status) return
    const onKey = (e: KeyboardEvent): void => {
      const id = matchShortcut(e)
      // Dialogs and menus own the keyboard while they are open.
      if (!id || document.querySelector('.modal-backdrop, .context-menu')) return
      e.preventDefault()
      runShortcut(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Ctrl+` also works from inside the terminal, which keeps most keys for itself.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (matchShortcut(e) !== 'terminal' || document.querySelector('.modal-backdrop')) return
      e.preventDefault()
      e.stopPropagation()
      setTerminal(toggleTerminal)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])

  // Stable identities for the memoized children; each call runs the latest version.
  const h = {
    onRefMenu: useEvent(onRefMenu),
    checkoutLabel: useEvent(checkoutLabel),
    onStashMenu: useEvent(onStashMenu),
    onStashDoubleClick: useEvent((s: Stash) =>
      act(
        'Applying stash',
        () => window.api.stashApply(repo, s.index, false, s.sha),
        `Applied ${isolateText(s.ref)}`
      )
    ),
    onBranchDrop: useEvent(onBranchDrop),
    onOpenRepo: useEvent(onOpenRepo),
    onStateChange: useEvent(onStateChange),
    onFetch: useEvent(() => act('Fetching', () => window.api.fetch(repo), 'Fetched all remotes')),
    onCancelNetwork: useEvent(() => void window.api.cancelNetwork(repo).catch(() => undefined)),
    pull: useEvent(pull),
    onPullMenu: useEvent(onPullMenu),
    push: useEvent(push),
    onBranch: useEvent(() => createBranch(null)),
    stashChanges: useEvent(stashChanges),
    onPop: useEvent(() =>
      act(
        'Popping stash',
        () => window.api.stashApply(repo, 0, true, stashes[0]?.sha),
        'Stash popped'
      )
    ),
    runUndo: useEvent(runUndo),
    sync: useEvent(sync),
    onHelp: useEvent(() => setDialog({ kind: 'help' })),
    onToggleTerminal: useEvent(() => setTerminal(toggleTerminal)),
    onStartAgent: useEvent(() => setDialog({ kind: 'startAgent', baseRef: null })),
    onMoreMenu: useEvent(onMoreMenu),
    pickSearchResult: useEvent(pickSearchResult),
    compareWithSelected: useEvent(compareWithSelected),
    onCommitMenu: useEvent(onCommitMenu),
    moreRefsMenu: useEvent(moreRefsMenu),
    onRowDoubleClick: useEvent(onRowDoubleClick),
    onHunk: useEvent(onHunk),
    onFile: useEvent(onFile),
    onCompose: useEvent(() => setDialog({ kind: 'composer' })),
    onExportPatch: useEvent((staged: boolean) => exportPatch({ kind: 'working', staged })),
    closeMenu: useEvent(() => setMenu(null)),
    closeDialog: useEvent(() => setDialog(null)),
    agentStarted: useEvent(agentStarted),
    hideTerminal: useEvent(() => setTerminal('hidden')),
    toggleMaximized: useEvent(() => setTerminalMaximized(!panelLayout.terminalMaximized))
  }
  const search = useMemo(
    () => (
      <SearchBar
        repo={repo}
        inputRef={searchRef}
        isLoaded={isLoaded}
        onPick={h.pickSearchResult}
        onMatches={setMatches}
      />
    ),
    [repo, isLoaded, h.pickSearchResult]
  )

  // ---- render -------------------------------------------------------------

  if (!refs || !status) {
    return (
      <div className="repo-view loading" style={{ display: active ? undefined : 'none' }}>
        <TrustBanner repo={repo} onChanged={refresh} />
        {loadError ? (
          <div className="empty-state error">{loadError}</div>
        ) : (
          <div className="empty-state">Loading {repoName(repo)}…</div>
        )}
      </div>
    )
  }

  const changeCount = status.staged.length + status.unstaged.length + status.conflicted.length
  const wipText =
    `// WIP — ${changeCount} change${changeCount === 1 ? '' : 's'}` +
    (status.staged.length ? `, ${status.staged.length} staged` : '') +
    (status.conflicted.length ? `, ${status.conflicted.length} conflicted` : '')

  return (
    <div
      ref={viewRef}
      className={`repo-view resizable sidebar-${modes.sidebar} right-${modes.right}`}
      style={
        {
          display: active ? undefined : 'none',
          '--sidebar-w': `${widths.sidebar}px`,
          '--right-w': `${widths.right}px`
        } as React.CSSProperties
      }
    >
      <RepoToolbar
        repo={repo}
        status={status}
        busy={busy}
        hasChanges={hasChanges}
        hasStashes={stashes.length > 0}
        undo={undo}
        editor={settings.editor}
        search={search}
        onFetch={h.onFetch}
        onCancelNetwork={h.onCancelNetwork}
        onPull={h.pull}
        onPullMenu={h.onPullMenu}
        onPush={h.push}
        onBranch={h.onBranch}
        onStash={h.stashChanges}
        onPop={h.onPop}
        onUndo={h.runUndo}
        onSync={h.sync}
        onHelp={h.onHelp}
        version={version}
        worktreeOf={worktreeOf}
        onOpenRepo={h.onOpenRepo}
        onChanged={refresh}
        terminalOpen={terminal === 'open'}
        onToggleTerminal={h.onToggleTerminal}
        onStartAgent={h.onStartAgent}
        onMoreMenu={h.onMoreMenu}
        layout={panelLayout}
      />

      <Sidebar
        mode={modes.sidebar}
        repo={repo}
        github={github}
        hosted={hosted}
        refs={refs}
        branchColor={branchColor}
        stashes={stashes}
        selected={selected}
        onSelectSha={selectSha}
        onRefMenu={h.onRefMenu}
        onRefDoubleClick={h.checkoutLabel}
        onStashMenu={h.onStashMenu}
        onStashDoubleClick={h.onStashDoubleClick}
        onBranchDrop={h.onBranchDrop}
        onChanged={refresh}
        onOpenRepo={h.onOpenRepo}
        onStateChange={h.onStateChange}
        now={now}
      />
      {/* A collapsed panel ignores its width; expanding it brings the width back. */}
      {modes.sidebar === 'open' && (
        <Resizer panel="sidebar" width={widths.sidebar} container={viewRef} />
      )}

      <div
        className={
          terminal === 'open' && panelLayout.terminalMaximized
            ? 'center-column terminal-maximized'
            : 'center-column'
        }
      >
        <TrustBanner repo={repo} onChanged={refresh} />
        <main className="center">
          {center.view.kind === 'history' ? (
            <FileHistoryView
              repo={repo}
              path={center.view.path}
              onClose={center.close}
              onSelectSha={selectSha}
              avatars={avatars}
              showAvatars={showAvatars}
            />
          ) : center.view.kind === 'diff' ? (
            <DiffView
              repo={repo}
              target={center.view.target}
              version={version}
              onClose={center.close}
              onHunk={h.onHunk}
              onFile={h.onFile}
            />
          ) : center.view.kind === 'compare' ? (
            <Suspense fallback={<div className="empty-state">Loading…</div>}>
              <CompareView
                repo={repo}
                from={center.view.from}
                to={center.view.to}
                onClose={center.close}
                onSelectSha={selectSha}
              />
            </Suspense>
          ) : commits.length === 0 && !hasChanges ? (
            <div className="empty-state">
              No commits yet. Add files to this folder, then stage and commit them.
            </div>
          ) : (
            <CommitGraph
              commits={graphCommits}
              layout={layout}
              refsBySha={refsBySha}
              branchColor={branchColor}
              customPalette={customPalette}
              headSha={status.headSha}
              selected={selected}
              wipText={wipText}
              hasMore={commits.length >= limit}
              showAvatars={showAvatars}
              avatars={avatars}
              matches={matches?.size ? matches : null}
              onSelect={selectSha}
              onCompare={h.compareWithSelected}
              onContextMenu={h.onCommitMenu}
              onRefContextMenu={h.onRefMenu}
              onRefDoubleClick={h.checkoutLabel}
              onMoreRefs={h.moreRefsMenu}
              onRowDoubleClick={h.onRowDoubleClick}
              onBranchDrop={h.onBranchDrop}
              onLoadMore={loadMore}
              now={now}
            />
          )}
        </main>
        <TerminalDock
          cwd={repo}
          state={terminal}
          tabActive={active}
          onHide={h.hideTerminal}
          maximized={panelLayout.terminalMaximized}
          onToggleMaximized={h.toggleMaximized}
        />
      </div>

      {modes.right === 'open' && <Resizer panel="right" width={widths.right} container={viewRef} />}
      <aside className="right" aria-label="Details">
        {modes.right === 'rail' && (
          <button
            className="details-rail"
            aria-label="Expand the details panel"
            title={titled('Expand the details panel', 'toggleDetails')}
            onClick={() => expandPanel('right')}
          >
            <PanelRightOpen size={16} />
            <span className="details-rail-label">
              {selected === WIP_SHA || (!selected && hasChanges)
                ? `Working copy · ${changeCount}`
                : 'Commit details'}
            </span>
          </button>
        )}
        {/* Stays mounted while collapsed: a commit message being written is kept. */}
        <div className="right-body" hidden={modes.right !== 'open'}>
          {selected === WIP_SHA || (!selected && hasChanges) ? (
            <WorkingCopyPanel
              repo={repo}
              status={status}
              activeFile={diffTarget}
              onOpenFile={center.openDiff}
              onFileHistory={center.openHistory}
              editor={settings.editor}
              act={act}
              ai={ai}
              onCompose={h.onCompose}
              onExportPatch={h.onExportPatch}
            />
          ) : selected ? (
            <CommitPanel
              repo={repo}
              sha={selected}
              activeFile={diffTarget}
              avatars={showAvatars ? avatars : NO_AVATARS}
              onOpenFile={center.openDiff}
              onSelectSha={selectSha}
              onFileHistory={center.openHistory}
              editor={settings.editor}
            />
          ) : (
            <div className="side-panel">
              <div className="empty-state">Select a commit</div>
            </div>
          )}
        </div>
      </aside>

      {menu && <ContextMenu menu={menu} onClose={h.closeMenu} />}
      <RepoDialogs
        repo={repo}
        dialog={dialog}
        getState={getState}
        onClose={h.closeDialog}
        onRefresh={refresh}
        onAgentStarted={h.agentStarted}
      />
    </div>
  )
})
