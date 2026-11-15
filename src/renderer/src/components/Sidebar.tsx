import type { AppState } from '../../../shared/types'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleDot,
  Cloud,
  FolderTree,
  GitBranch,
  GitPullRequest,
  Laptop,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Tag
} from 'lucide-react'
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode
} from 'react'
import type { RefsInfo, Stash } from '../../../shared/types'
import { branchDragSource, branchDropTarget, type DraggedBranch } from '../lib/branchDrag'
import { relativeTime } from '../lib/format'
import {
  expandPanel,
  setAllSidebarSections,
  setSidebarSection,
  togglePanel,
  useSidebarSections,
  type PanelMode,
  type SidebarSectionId
} from '../lib/layout'
import { titled } from '../lib/shortcuts'
import type { RefLabel } from './CommitGraph'
import { CodeText } from './DiffView'
import { IssuesSection } from './hosting/IssuesSection'
import { PullRequestsSection } from './PullRequests'
import { WorktreesSection } from './terminal/WorktreesSection'

// Their props only change with the repository: a refresh or a selection skips them.
/** Memoized, and rendered again when `now` moves on: it shows relative times. */
const withClock = <P extends object>(C: ComponentType<P>): ComponentType<P & { now: number }> =>
  memo(C as ComponentType<P & { now: number }>)

const Worktrees = memo(WorktreesSection)
const PullRequests = withClock(PullRequestsSection)
const Issues = withClock(IssuesSection)

interface Props {
  repo: string
  /** Full sidebar, icon rail (collapsed) or hidden (focus mode). */
  mode: PanelMode
  /** "owner/repo" when origin is on GitHub: shows the pull requests section. */
  github: string | null
  /** origin is on a known hosting service: show its pull/merge requests. */
  hosted: boolean
  refs: RefsInfo
  /** Color of the first branch color rule matching a branch, if any. */
  branchColor?(kind: RefLabel['kind'], name: string): string | undefined
  stashes: Stash[]
  selected: string | null
  onSelectSha(sha: string): void
  onRefMenu(e: React.MouseEvent, label: RefLabel, sha: string): void
  onRefDoubleClick(label: RefLabel): void
  onStashMenu(e: React.MouseEvent, stash: Stash): void
  onStashDoubleClick(stash: Stash): void
  /** A branch was dropped on the checked-out branch. */
  onBranchDrop(e: React.DragEvent, branch: DraggedBranch): void
  /** Something changed the repository (e.g. a pull request was checked out). */
  onChanged(): void
  /** Opens a repository tab (a worktree). */
  onOpenRepo(path: string): void
  /** The repository list changed (e.g. a worktree was removed): its tab must go. */
  onStateChange(state: AppState): void
  /** The time (useNow): relative dates move on although the data stays the same. */
  now: number
}

interface SectionDef {
  id: SidebarSectionId
  title: string
  icon: ReactNode
  count?: number
  defaultOpen: boolean
}

function Section({
  def,
  open,
  children
}: {
  def: SectionDef
  open: boolean
  children: ReactNode
}): React.JSX.Element {
  const { id, title, icon, count } = def
  return (
    <div className="sb-section" data-section={id}>
      <button
        className="sb-section-title"
        onClick={() => setSidebarSection(id, !open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {icon}
        <span>{title}</span>
        {count !== undefined && <span className="count">{count}</span>}
      </button>
      {open && <div className="sb-items">{children}</div>}
    </div>
  )
}

interface RowProps {
  kind: 'local' | 'remote' | 'tag'
  name: string
  sha: string
  /** The checked-out branch: branches dropped on it are merged or rebased. */
  current?: boolean
  selected: boolean
  indent?: boolean
  /** Branch color rule's color. */
  color?: string
  ahead?: number
  behind?: number
  gone?: boolean
  dropOver?: boolean
  setDropOver?(over: boolean): void
  onSelectSha(sha: string): void
  onRefMenu(e: React.MouseEvent, label: RefLabel, sha: string): void
  onRefDoubleClick(label: RefLabel): void
  onBranchDrop(e: React.DragEvent, branch: DraggedBranch): void
}

/** One branch or tag. Memoized: selecting a commit only re-renders the rows it changes. */
const RefRow = memo(function RefRow(p: RowProps): React.JSX.Element {
  const label: RefLabel = { kind: p.kind, name: p.name, current: p.current }
  const branch = p.kind === 'local' || p.kind === 'remote' ? p.kind : null
  const target = branch === 'local' && p.current && p.setDropOver
  return (
    <div
      className={[
        'sb-item',
        p.current && 'current',
        p.selected && 'selected',
        p.indent && 'indent',
        target && p.dropOver && 'drop-over'
      ]
        .filter(Boolean)
        .join(' ')}
      {...(branch ? branchDragSource({ kind: branch, name: p.name }) : {})}
      {...(target ? branchDropTarget(p.name, p.setDropOver!, p.onBranchDrop) : {})}
      onClick={() => p.onSelectSha(p.sha)}
      onDoubleClick={() => p.onRefDoubleClick(label)}
      onContextMenu={(e) => p.onRefMenu(e, label, p.sha)}
      title={p.name}
    >
      {branch ? (
        <GitBranch
          size={13}
          color={p.color}
          className={p.color ? 'sb-branch-icon ruled' : 'sb-branch-icon'}
        />
      ) : (
        <Tag size={13} />
      )}
      <span className="sb-name">
        <CodeText text={p.name} />
      </span>
      {p.kind === 'local' && (
        <span className="sb-badges">
          {p.gone && (
            <span className="badge muted" title="Upstream branch was deleted">
              gone
            </span>
          )}
          {!!p.ahead && (
            <span className="badge" title={`${p.ahead} to push`}>
              ↑{p.ahead}
            </span>
          )}
          {!!p.behind && (
            <span className="badge" title={`${p.behind} to pull`}>
              ↓{p.behind}
            </span>
          )}
        </span>
      )}
    </div>
  )
})

const StashRow = memo(function StashRow({
  stash: s,
  selected,
  onSelectSha,
  onStashMenu,
  onStashDoubleClick
}: {
  stash: Stash
  selected: boolean
  /** Renders the date again when it moves on. */
  now: number
  onSelectSha(sha: string): void
  onStashMenu(e: React.MouseEvent, stash: Stash): void
  onStashDoubleClick(stash: Stash): void
}): React.JSX.Element {
  return (
    <div
      className={selected ? 'sb-item selected' : 'sb-item'}
      onClick={() => onSelectSha(s.sha)}
      onDoubleClick={() => onStashDoubleClick(s)}
      onContextMenu={(e) => onStashMenu(e, s)}
      title={`${s.ref}: ${s.message} (double-click to apply)`}
    >
      <Archive size={13} />
      <span className="sb-name">
        <CodeText text={s.message} />
      </span>
      <span className="sb-date">{relativeTime(s.date)}</span>
    </div>
  )
})

/** Memoized: a refresh that changed nothing (same refs and stashes) skips it. */
export const Sidebar = memo(function Sidebar(props: Props): React.JSX.Element {
  const { refs, stashes, selected } = props
  const [filter, setFilter] = useState('')
  const [dropOver, setDropOver] = useState(false)
  const opened = useSidebarSections()
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Section picked on the rail: scrolled into view once the sidebar is open. */
  const [reveal, setReveal] = useState<SidebarSectionId | null>(null)
  const match = (name: string): boolean =>
    !filter || name.toLowerCase().includes(filter.toLowerCase())

  const remotes = useMemo(() => {
    const groups = new Map<string, typeof refs.remoteBranches>()
    for (const r of refs.remotes) groups.set(r, [])
    for (const rb of refs.remoteBranches) {
      if (!groups.has(rb.remote)) groups.set(rb.remote, [])
      groups.get(rb.remote)!.push(rb)
    }
    return [...groups.entries()]
  }, [refs])

  // Sections opened or closed by hand stay so (in every repository); the others follow their
  // default, which may arrive after the first render (issues are open when origin is hosted).
  const defs: SectionDef[] = [
    {
      id: 'local',
      title: 'Local',
      icon: <Laptop size={14} />,
      count: refs.branches.length,
      defaultOpen: true
    },
    {
      id: 'remote',
      title: 'Remote',
      icon: <Cloud size={14} />,
      count: refs.remoteBranches.length,
      defaultOpen: true
    },
    { id: 'worktrees', title: 'Worktrees', icon: <FolderTree size={14} />, defaultOpen: true },
    ...(props.hosted
      ? [
          {
            id: 'pulls' as const,
            title: 'Pull requests',
            icon: <GitPullRequest size={14} />,
            defaultOpen: true
          }
        ]
      : []),
    { id: 'issues', title: 'Issues', icon: <CircleDot size={14} />, defaultOpen: props.hosted },
    {
      id: 'tags',
      title: 'Tags',
      icon: <Tag size={14} />,
      count: refs.tags.length,
      defaultOpen: true
    },
    {
      id: 'stashes',
      title: 'Stashes',
      icon: <Archive size={14} />,
      count: stashes.length,
      defaultOpen: true
    }
  ]
  const byId = new Map(defs.map((d) => [d.id, d]))
  const isOpen = (id: SidebarSectionId): boolean => opened[id] ?? byId.get(id)?.defaultOpen ?? true
  const anyOpen = defs.some((d) => isOpen(d.id))

  useEffect(() => {
    if (props.mode !== 'open' || !reveal) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-section="${reveal}"]`)
    el?.scrollIntoView({ block: 'start' })
    el?.querySelector<HTMLElement>('.sb-section-title')?.focus()
    // A one-shot request, done once the sidebar shows the section.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReveal(null)
  }, [props.mode, reveal])

  const openFromRail = (id: SidebarSectionId): void => {
    setSidebarSection(id, true)
    setReveal(id)
    expandPanel('sidebar')
  }

  const section = (id: SidebarSectionId, children: ReactNode): React.JSX.Element | null => {
    const def = byId.get(id)
    return def ? (
      <Section def={def} open={isOpen(id)}>
        {children}
      </Section>
    ) : null
  }

  // Handlers every row shares (stable: see RepoView).
  const rowHandlers = {
    onSelectSha: props.onSelectSha,
    onRefMenu: props.onRefMenu,
    onRefDoubleClick: props.onRefDoubleClick,
    onBranchDrop: props.onBranchDrop
  }

  const locals = refs.branches.filter((b) => match(b.name))
  const tags = refs.tags.filter((t) => match(t.name))
  const stashList = stashes.filter((s) => match(s.message))

  return (
    <nav
      className={props.mode === 'open' ? 'sidebar' : `sidebar is-${props.mode}`}
      aria-label="Branches"
    >
      {props.mode === 'rail' && (
        <div className="sb-rail">
          <button
            className="icon-btn sb-rail-btn"
            aria-label="Expand the sidebar"
            title={titled('Expand the sidebar', 'toggleSidebar')}
            onClick={() => expandPanel('sidebar')}
          >
            <PanelLeftOpen size={16} />
          </button>
          <span className="sb-rail-sep" />
          {defs.map((d) => (
            <button
              key={d.id}
              className="icon-btn sb-rail-btn"
              aria-label={d.title}
              title={d.count !== undefined ? `${d.title} (${d.count})` : d.title}
              onClick={() => openFromRail(d.id)}
            >
              {d.icon}
              {!!d.count && <span className="sb-rail-count">{d.count > 99 ? '99+' : d.count}</span>}
            </button>
          ))}
        </div>
      )}
      {/* Stays mounted while collapsed: the filter and the fetched lists are kept. */}
      <div className="sb-body" hidden={props.mode !== 'open'}>
        <div className="sb-head">
          <div className="sb-filter">
            <Search size={14} />
            <input
              placeholder="Filter branches"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <button
            className="icon-btn sb-head-btn"
            aria-label={anyOpen ? 'Collapse all sections' : 'Expand all sections'}
            title={anyOpen ? 'Collapse all sections' : 'Expand all sections'}
            onClick={() =>
              setAllSidebarSections(
                defs.map((d) => d.id),
                !anyOpen
              )
            }
          >
            {anyOpen ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
          </button>
          <button
            className="icon-btn sb-head-btn"
            aria-label="Collapse the sidebar"
            title={titled('Collapse the sidebar', 'toggleSidebar')}
            onClick={() => togglePanel('sidebar')}
          >
            <PanelLeftClose size={15} />
          </button>
        </div>
        <div className="sb-scroll" ref={scrollRef}>
          {section(
            'local',
            <>
              {locals.map((b) => (
                <RefRow
                  key={b.name}
                  kind="local"
                  name={b.name}
                  sha={b.sha}
                  current={b.isHead}
                  selected={b.sha === selected}
                  color={props.branchColor?.('local', b.name)}
                  ahead={b.ahead}
                  behind={b.behind}
                  gone={b.upstreamGone}
                  {...(b.isHead ? { dropOver, setDropOver } : {})}
                  {...rowHandlers}
                />
              ))}
              {!refs.branches.length && <div className="sb-empty">No branches yet</div>}
            </>
          )}

          {section(
            'remote',
            <>
              {remotes.map(([remote, branches]) => (
                <div key={remote}>
                  <div className="sb-group">{remote}</div>
                  {branches
                    .filter((rb) => match(rb.fullName))
                    .map((rb) => (
                      <RefRow
                        key={rb.fullName}
                        kind="remote"
                        name={rb.fullName}
                        sha={rb.sha}
                        selected={rb.sha === selected}
                        indent
                        color={props.branchColor?.('remote', rb.fullName)}
                        {...rowHandlers}
                      />
                    ))}
                </div>
              ))}
              {!refs.remotes.length && <div className="sb-empty">No remotes</div>}
            </>
          )}

          {section(
            'worktrees',
            <Worktrees
              repo={props.repo}
              onOpenRepo={props.onOpenRepo}
              onStateChange={props.onStateChange}
              onChanged={props.onChanged}
            />
          )}

          {section(
            'pulls',
            <PullRequests
              repo={props.repo}
              currentBranch={refs.headBranch}
              onChanged={props.onChanged}
              now={props.now}
            />
          )}

          {/* Hosted issues, Jira or Linear: the section explains itself when none is set up. */}
          {section(
            'issues',
            <Issues
              repo={props.repo}
              currentBranch={refs.headBranch}
              onChanged={props.onChanged}
              now={props.now}
            />
          )}

          {section(
            'tags',
            tags.map((t) => (
              <RefRow
                key={t.name}
                kind="tag"
                name={t.name}
                sha={t.sha}
                selected={t.sha === selected}
                {...rowHandlers}
              />
            ))
          )}

          {section(
            'stashes',
            stashList.map((s) => (
              <StashRow
                key={s.ref}
                stash={s}
                selected={s.sha === selected}
                now={props.now}
                onSelectSha={props.onSelectSha}
                onStashMenu={props.onStashMenu}
                onStashDoubleClick={props.onStashDoubleClick}
              />
            ))
          )}
        </div>
      </div>
    </nav>
  )
})
