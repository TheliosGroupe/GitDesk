import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Sparkles,
  TriangleAlert,
  Undo2
} from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AvatarMap,
  CommitDetails,
  DiffTarget,
  EditorChoice,
  FileChange,
  WorkingStatus
} from '../../../shared/types'
import { visibleRange } from '../lib/diff'
import { dirName, errorMessage, fileName, fullDate, shortSha } from '../lib/format'
import { ignoreExtensionPattern, ignoreFilePattern } from '../lib/gitignore'
import { isolateText } from '../lib/highlight'
import {
  COMMIT_HEIGHT_LIMITS,
  setCommitHeight,
  setWorkingSplit,
  toggleWorkingMaximized,
  toggleWorkingSection,
  useWorkingLayout,
  workingCollapsed,
  type WorkingLayout,
  type WorkingSectionId
} from '../lib/layout'
import { editorName, hasMod, modKey, showInFolderLabel } from '../lib/platform'
import { AiCommitButton } from './ai/AiCommitButton'
import { CodeText, Isolated } from './DiffView'
import { Avatar, ContextMenu, KindBadge, type MenuItem, type MenuState } from './ui'
import { useDialogs, useOpenFile, useToasts } from './ui-context'

export type Act = (label: string, fn: () => Promise<unknown>, done?: string) => Promise<boolean>

/** Path of `a` when it is a file of the `kind` list, else null (which row of a list is active). */
function activeIn(a: DiffTarget | null, kind: DiffTarget['kind']): string | null {
  return a && a.kind === kind ? a.file.path : null
}

/** A stable function that always calls the latest `fn`, so memoized rows keep their props. */
function useLatest<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}

interface FileAction {
  icon: React.ReactNode
  label: string
  onClick(file: FileChange): void
}

interface FileListProps {
  files: FileChange[]
  /** Path of the file shown in the diff, when it is one of this list. */
  activePath: string | null
  onOpen(file: FileChange): void
  onMenu?(e: React.MouseEvent, file: FileChange): void
  actions?: FileAction[]
}

const NO_ACTIONS: FileAction[] = []

/** Height of a row (.file-list li). */
const FILE_ROW_H = 26
/** Lists longer than this draw only the rows in view (plus OVERSCAN above and below). */
const WINDOW_FROM = 200
const OVERSCAN = 30

const FileRow = memo(function FileRow({
  file: f,
  active,
  onOpen,
  onMenu,
  actions
}: Omit<FileListProps, 'files' | 'activePath'> & {
  file: FileChange
  active: boolean
  actions: FileAction[]
}): React.JSX.Element {
  return (
    <li
      className={active ? 'active' : ''}
      onClick={() => onOpen(f)}
      onContextMenu={(e) => {
        if (!onMenu) return
        e.preventDefault()
        onMenu(e, f)
      }}
      title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
    >
      <KindBadge kind={f.kind} />
      <bdi className="file-name">
        <CodeText text={fileName(f.path)} />
      </bdi>
      <bdi className="file-dir">
        <CodeText text={dirName(f.path)} />
      </bdi>
      <span className="file-actions">
        {actions.map((a) => (
          <button
            key={a.label}
            className="icon-btn"
            title={a.label}
            aria-label={a.label}
            onClick={(e) => {
              e.stopPropagation()
              a.onClick(f)
            }}
          >
            {a.icon}
          </button>
        ))}
      </span>
    </li>
  )
})

/** The element that scrolls `el` (itself when it scrolls). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let e: HTMLElement | null = el; e; e = e.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(e).overflowY)) return e
  }
  return null
}

/** Rows [first, last) of a list of `count` rows in view of its scroll box, or all of a short list. */
function useVisibleRows(
  ref: React.RefObject<HTMLElement | null>,
  count: number
): [first: number, last: number] {
  const windowed = count > WINDOW_FROM
  const [range, setRange] = useState<[number, number]>([0, 2 * OVERSCAN])
  useEffect(() => {
    const el = ref.current
    if (!el || !windowed) return
    const box = scrollParent(el)
    const update = (): void => {
      // Rows start at the list's top edge (its ::before stands for the rows above).
      const top = !box
        ? 0
        : box === el
          ? el.scrollTop
          : box.getBoundingClientRect().top - el.getBoundingClientRect().top
      // Nothing scrolls it: every row is drawn.
      const [first, last] = box
        ? visibleRange(top, box.clientHeight, count, FILE_ROW_H, OVERSCAN)
        : [0, count]
      setRange((r) => (r[0] === first && r[1] === last ? r : [first, last]))
    }
    update()
    if (!box) return
    box.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(box)
    return () => {
      box.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [ref, count, windowed])
  return windowed ? [Math.min(range[0], count), Math.min(range[1], count)] : [0, count]
}

/** A list of changed files; long ones draw only the rows in view. */
const FileList = memo(function FileList({
  files,
  activePath,
  onOpen,
  onMenu,
  actions = NO_ACTIONS
}: FileListProps): React.JSX.Element {
  const ref = useRef<HTMLUListElement>(null)
  const [first, last] = useVisibleRows(ref, files.length)
  const windowed = files.length > WINDOW_FROM
  const style = windowed
    ? ({
        '--fl-before': `${first * FILE_ROW_H}px`,
        '--fl-after': `${(files.length - last) * FILE_ROW_H}px`
      } as React.CSSProperties)
    : undefined
  return (
    <ul ref={ref} className={windowed ? 'file-list windowed' : 'file-list'} style={style}>
      {files.slice(first, last).map((f) => (
        <FileRow
          key={f.kind + f.path}
          file={f}
          active={f.path === activePath}
          onOpen={onOpen}
          onMenu={onMenu}
          actions={actions}
        />
      ))}
    </ul>
  )
})

const pathsOf = (files: FileChange[]): string[] =>
  files.flatMap((f) => (f.origPath ? [f.origPath, f.path] : [f.path]))

/** Absolute path of a repository file, with the separators the repository path uses. */
function fullPath(repo: string, path: string): string {
  const sep = repo.includes('\\') ? '\\' : '/'
  return repo.replace(/[\\/]+$/, '') + sep + path.replace(/\//g, sep)
}

/** Right-click menu of a file: editor, file manager, paths, history, .gitignore + `extra` actions. */
function useFileMenu(
  repo: string,
  editor: EditorChoice,
  onFileHistory: (path: string) => void,
  act?: Act
): [
  open: (e: React.MouseEvent, file: FileChange, extra?: MenuItem[]) => void,
  menu: React.ReactNode
] {
  const toasts = useToasts()
  const openFile = useOpenFile()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const run = (fn: () => Promise<unknown>) => () => fn().catch((e) => toasts.error(errorMessage(e)))

  const open = (e: React.MouseEvent, file: FileChange, extra: MenuItem[] = []): void => {
    const gone = file.kind === 'D'
    const ext = /[^./]\.([^./]+)$/.exec(fileName(file.path))?.[1]
    const ignore: MenuItem[] =
      file.kind === '?' && act
        ? [
            'separator',
            {
              label: 'Add to .gitignore',
              onClick: () =>
                act(
                  'Ignoring',
                  () => window.api.ignorePath(repo, ignoreFilePattern(file.path)),
                  `Ignored ${file.path}`
                )
            },
            ...(ext
              ? [
                  {
                    label: `Ignore all *.${ext} files`,
                    onClick: () =>
                      act(
                        'Ignoring',
                        () => window.api.ignorePath(repo, ignoreExtensionPattern(ext)),
                        `Ignored *.${ext} files`
                      )
                  }
                ]
              : [])
          ]
        : []
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: `Open in ${editorName(editor)}`,
          disabled: gone,
          onClick: () => openFile(repo, file.path)
        },
        {
          label: showInFolderLabel,
          disabled: gone,
          onClick: run(() => window.api.showFile(repo, file.path))
        },
        'separator',
        { label: 'Copy path', onClick: run(() => navigator.clipboard.writeText(file.path)) },
        {
          label: 'Copy full path',
          onClick: run(() => navigator.clipboard.writeText(fullPath(repo, file.path)))
        },
        'separator',
        {
          label: 'File history',
          disabled: file.kind === '?',
          onClick: () => onFileHistory(file.path)
        },
        ...ignore,
        ...(extra.length ? ['separator' as const, ...extra] : [])
      ]
    })
  }
  return [open, menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />]
}

// ---------------------------------------------------------------------------
// Working copy sections: collapsible titles, splitters between them, a maximized list.

/** Section title that collapses or expands its section. */
function SectionToggle({
  id,
  layout,
  children
}: {
  id: WorkingSectionId
  layout: WorkingLayout
  children: React.ReactNode
}): React.JSX.Element {
  const open = !workingCollapsed(layout, id)
  return (
    <button
      className="section-toggle"
      aria-expanded={open}
      title={open ? 'Collapse' : 'Expand'}
      onClick={() => toggleWorkingSection(id)}
    >
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      <span>{children}</span>
    </button>
  )
}

function MaximizeButton({
  id,
  layout,
  label
}: {
  id: 'unstaged' | 'staged'
  layout: WorkingLayout
  label: string
}): React.JSX.Element {
  const on = layout.maximized === id
  const text = on ? `Restore the ${label} list` : `Maximize the ${label} list`
  return (
    <button
      className={on ? 'icon-btn small active' : 'icon-btn small'}
      aria-pressed={on}
      aria-label={text}
      title={text}
      onClick={() => toggleWorkingMaximized(id)}
    >
      {on ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
    </button>
  )
}

/**
 * Horizontal splitter between two working copy sections. While dragging it only touches the
 * sections' inline styles; the result is saved on release.
 */
function SectionSplitter({
  label,
  onStart,
  onMove,
  onEnd,
  onReset,
  onStep
}: {
  label: string
  onStart(): void
  /** Pixels moved down since the drag started. */
  onMove(dy: number): void
  onEnd(): void
  onReset(): void
  /** Keyboard: move by `dy` pixels. */
  onStep(dy: number): void
}): React.JSX.Element {
  const start = useRef<number | null>(null)
  const finish = (): void => {
    if (start.current === null) return
    start.current = null
    document.body.classList.remove('row-resizing')
    onEnd()
  }
  return (
    <div
      className="wc-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      tabIndex={0}
      title={`${label} (double-click to reset)`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = e.clientY
        document.body.classList.add('row-resizing')
        onStart()
      }}
      onPointerMove={(e) => start.current !== null && onMove(e.clientY - start.current)}
      onPointerUp={finish}
      onLostPointerCapture={finish}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16
        if (e.key === 'ArrowUp') onStep(-step)
        else if (e.key === 'ArrowDown') onStep(step)
        else if (e.key === 'Enter') onReset()
        else return
        e.preventDefault()
      }}
    />
  )
}

const LIST_MIN = 64

interface WorkingProps {
  repo: string
  status: WorkingStatus
  activeFile: DiffTarget | null
  onOpenFile(target: DiffTarget): void
  onFileHistory(path: string): void
  editor: EditorChoice
  act: Act
  /** An AI provider is configured: show the AI buttons. */
  ai: boolean
  onCompose(): void
  onExportPatch(staged: boolean): void
}

/** How the banner names each multi-step git operation. */
const OPERATION_LABELS: Record<NonNullable<WorkingStatus['operation']>, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
  am: 'Applying patches'
}

// Memoized (as CommitPanel): RepoView passes stable handlers, so a refresh that changed
// nothing, or a click in the graph, leaves the panel as it is.
export const WorkingCopyPanel = memo(function WorkingCopyPanel({
  repo,
  status,
  activeFile,
  onOpenFile,
  onFileHistory,
  editor,
  act,
  ai,
  onCompose,
  onExportPatch
}: WorkingProps): React.JSX.Element {
  const dialogs = useDialogs()
  const [openMenu, menu] = useFileMenu(repo, editor, onFileHistory, act)
  const [sectionMenu, setSectionMenu] = useState<MenuState | null>(null)
  /** "…" of the unstaged / staged section: export those changes as a patch. */
  const openSectionMenu = (e: React.MouseEvent, staged: boolean): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setSectionMenu({
      x: rect.left,
      y: rect.bottom + 4,
      items: [
        {
          label: staged ? 'Export staged changes as patch…' : 'Export unstaged changes as patch…',
          onClick: () => onExportPatch(staged)
        }
      ]
    })
  }
  const sectionMore = (staged: boolean): React.JSX.Element => (
    <button
      className="icon-btn small"
      title={staged ? 'More: export staged changes as patch' : 'More: export changes as patch'}
      aria-label={staged ? 'More staged actions' : 'More unstaged actions'}
      onClick={(e) => openSectionMenu(e, staged)}
    >
      <Ellipsis size={14} />
    </button>
  )
  const stageItem = (f: FileChange, label = 'Stage file'): MenuItem => ({
    label,
    onClick: () => act('Staging', () => window.api.stage(repo, pathsOf([f])))
  })
  const discard = async (files: FileChange[]): Promise<void> => {
    const ok = await dialogs.confirm({
      title:
        files.length === 1
          ? `Discard changes to ${isolateText(fileName(files[0].path))}?`
          : `Discard ${files.length} changes?`,
      message:
        files.length === 1 ? (
          <>
            <Isolated text={files[0].path} />: this cannot be undone. A new file will be deleted.
          </>
        ) : (
          'This cannot be undone. New files will be deleted.'
        ),
      okLabel: 'Discard',
      danger: true
    })
    if (ok) await act('Discarding', () => window.api.discard(repo, files))
  }
  const stagedCount = status.staged.length

  // Stable handlers and actions: a refresh or a layout change does not redraw every file row.
  const openUnstaged = useLatest((f: FileChange) => onOpenFile({ kind: 'unstaged', file: f }))
  const openStaged = useLatest((f: FileChange) => onOpenFile({ kind: 'staged', file: f }))
  const stageOne = useLatest((f: FileChange) =>
    act('Staging', () => window.api.stage(repo, [f.path]))
  )
  const unstageOne = useLatest((f: FileChange) =>
    act('Unstaging', () => window.api.unstage(repo, pathsOf([f])))
  )
  const discardOne = useLatest((f: FileChange) => discard([f]))
  const conflictMenu = useLatest((e: React.MouseEvent, f: FileChange) =>
    openMenu(e, f, [stageItem(f, 'Mark resolved (stage)')])
  )
  const unstagedMenu = useLatest((e: React.MouseEvent, f: FileChange) =>
    openMenu(e, f, [
      stageItem(f),
      { label: 'Discard changes…', danger: true, onClick: () => discard([f]) }
    ])
  )
  const stagedMenu = useLatest((e: React.MouseEvent, f: FileChange) =>
    openMenu(e, f, [{ label: 'Unstage file', onClick: () => unstageOne(f) }])
  )
  const conflictActions = useMemo(
    () => [{ icon: <Plus size={14} />, label: 'Mark resolved (stage)', onClick: stageOne }],
    [stageOne]
  )
  const unstagedActions = useMemo(
    () => [
      { icon: <Undo2 size={14} />, label: 'Discard changes', onClick: discardOne },
      { icon: <Plus size={14} />, label: 'Stage file', onClick: stageOne }
    ],
    [discardOne, stageOne]
  )
  const stagedActions = useMemo(
    () => [{ icon: <Minus size={14} />, label: 'Unstage file', onClick: unstageOne }],
    [unstageOne]
  )

  // ---- section layout ----
  const layout = useWorkingLayout()
  const unstagedOpen = !workingCollapsed(layout, 'unstaged')
  const stagedOpen = !workingCollapsed(layout, 'staged')
  const commitOpen = !workingCollapsed(layout, 'commit')
  const unstagedRef = useRef<HTMLElement>(null)
  const stagedRef = useRef<HTMLElement>(null)
  const commitRef = useRef<HTMLElement>(null)
  const drag = useRef({ a: 0, b: 0, value: 0 })

  /** Splitter between the two file lists: the unstaged share of their space. */
  const listsDrag = {
    onStart: () => {
      drag.current.a = unstagedRef.current?.getBoundingClientRect().height ?? 0
      drag.current.b = stagedRef.current?.getBoundingClientRect().height ?? 0
      drag.current.value = layout.split
    },
    onMove: (dy: number) => {
      const { a, b } = drag.current
      const total = a + b
      if (total <= 0) return
      const h = Math.min(total - LIST_MIN, Math.max(LIST_MIN, a + dy))
      const split = Math.min(0.9, Math.max(0.1, h / total))
      drag.current.value = split
      unstagedRef.current?.style.setProperty('--wc-grow', String(split))
      stagedRef.current?.style.setProperty('--wc-grow', String(1 - split))
    },
    onEnd: () => setWorkingSplit(drag.current.value),
    onReset: () => setWorkingSplit(null),
    onStep: (dy: number) => {
      const a = unstagedRef.current?.getBoundingClientRect().height ?? 0
      const b = stagedRef.current?.getBoundingClientRect().height ?? 0
      if (a + b > 0) setWorkingSplit((a + dy) / (a + b))
    }
  }

  /** Splitter above the commit box: its height (the file lists give or take the space). */
  const lists = (): number =>
    (unstagedOpen ? (unstagedRef.current?.getBoundingClientRect().height ?? 0) - LIST_MIN : 0) +
    (stagedOpen ? (stagedRef.current?.getBoundingClientRect().height ?? 0) - LIST_MIN : 0)
  const commitDrag = {
    onStart: () => {
      drag.current.a = commitRef.current?.getBoundingClientRect().height ?? 0
      drag.current.b = Math.max(0, lists())
      drag.current.value = drag.current.a
    },
    onMove: (dy: number) => {
      const { a, b } = drag.current
      const h = Math.round(
        Math.min(a + b, COMMIT_HEIGHT_LIMITS.max, Math.max(COMMIT_HEIGHT_LIMITS.min, a - dy))
      )
      drag.current.value = h
      commitRef.current?.style.setProperty('height', `${h}px`)
    },
    onEnd: () => {
      if (Math.abs(drag.current.value - drag.current.a) >= 1) setCommitHeight(drag.current.value)
    },
    onReset: () => setCommitHeight(null),
    onStep: (dy: number) => {
      const h = commitRef.current?.getBoundingClientRect().height ?? 0
      if (dy < 0 && lists() < -dy) return
      setCommitHeight(h - dy)
    }
  }
  const bothLists = unstagedOpen && stagedOpen
  const commitSized = commitOpen && (unstagedOpen || stagedOpen)

  return (
    <div
      className={[
        'side-panel working',
        !unstagedOpen && !stagedOpen && 'lists-collapsed',
        layout.maximized && 'maximized'
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {status.operation && (
        <div className="banner warning">
          <TriangleAlert size={16} />
          <div>
            <strong>{OPERATION_LABELS[status.operation]} in progress.</strong>
            <div>
              {status.conflicted.length
                ? 'Click each conflicted file to resolve it (or fix it in your editor and stage it), then continue.'
                : 'Conflicts resolved: continue to finish it.'}
            </div>
            <div className="banner-actions">
              <button
                className="btn small"
                onClick={() => act('Aborting', () => window.api.abortOperation(repo))}
              >
                Abort
              </button>
              <button
                className="btn small primary"
                disabled={status.conflicted.length > 0}
                onClick={() => act('Continuing', () => window.api.continueOperation(repo))}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {status.conflicted.length > 0 && (
        <section>
          <div className="section-title">
            <span>Conflicts ({status.conflicted.length})</span>
          </div>
          <FileList
            files={status.conflicted}
            activePath={activeIn(activeFile, 'unstaged')}
            onOpen={openUnstaged}
            onMenu={conflictMenu}
            actions={conflictActions}
          />
        </section>
      )}

      <section
        ref={unstagedRef}
        className={unstagedOpen ? 'wc-list' : 'wc-list collapsed'}
        data-wc="unstaged"
        style={{ '--wc-grow': layout.split } as React.CSSProperties}
      >
        <div className="section-title">
          <SectionToggle id="unstaged" layout={layout}>
            Unstaged files ({status.unstaged.length})
          </SectionToggle>
          <span className="section-actions">
            {status.unstaged.length > 0 && (
              <>
                {sectionMore(false)}
                <button className="link-btn danger" onClick={() => discard(status.unstaged)}>
                  Discard all
                </button>
                <button
                  className="btn small primary"
                  onClick={() =>
                    act('Staging', () => window.api.stage(repo, pathsOf(status.unstaged)))
                  }
                >
                  Stage all
                </button>
              </>
            )}
            <MaximizeButton id="unstaged" layout={layout} label="unstaged files" />
          </span>
        </div>
        {unstagedOpen && (
          <FileList
            files={status.unstaged}
            activePath={activeIn(activeFile, 'unstaged')}
            onOpen={openUnstaged}
            onMenu={unstagedMenu}
            actions={unstagedActions}
          />
        )}
      </section>

      {bothLists && (
        <SectionSplitter label="Resize the unstaged and staged file lists" {...listsDrag} />
      )}

      <section
        ref={stagedRef}
        className={stagedOpen ? 'wc-list' : 'wc-list collapsed'}
        data-wc="staged"
        style={{ '--wc-grow': 1 - layout.split } as React.CSSProperties}
      >
        <div className="section-title">
          <SectionToggle id="staged" layout={layout}>
            Staged files ({stagedCount})
          </SectionToggle>
          <span className="section-actions">
            {stagedCount > 0 && (
              <>
                {sectionMore(true)}
                <button
                  className="btn small"
                  onClick={() =>
                    act('Unstaging', () => window.api.unstage(repo, pathsOf(status.staged)))
                  }
                >
                  Unstage all
                </button>
              </>
            )}
            <MaximizeButton id="staged" layout={layout} label="staged files" />
          </span>
        </div>
        {stagedOpen && (
          <FileList
            files={status.staged}
            activePath={activeIn(activeFile, 'staged')}
            onOpen={openStaged}
            onMenu={stagedMenu}
            actions={stagedActions}
          />
        )}
      </section>

      {commitSized && <SectionSplitter label="Resize the commit box" {...commitDrag} />}

      <CommitBox
        repo={repo}
        boxRef={commitRef}
        stagedCount={stagedCount}
        unstagedCount={status.unstaged.length}
        conflictedCount={status.conflicted.length}
        layout={layout}
        open={commitOpen}
        height={commitSized ? layout.commitHeight : null}
        act={act}
        ai={ai}
        onCompose={onCompose}
      />
      {menu}
      {sectionMenu && <ContextMenu menu={sectionMenu} onClose={() => setSectionMenu(null)} />}
    </div>
  )
})

/**
 * The commit message and its buttons. Its own component: typing re-renders only this box, not
 * the file lists next to it.
 */
function CommitBox({
  repo,
  boxRef,
  stagedCount,
  unstagedCount,
  conflictedCount,
  layout,
  open,
  height,
  act,
  ai,
  onCompose
}: {
  repo: string
  boxRef: React.RefObject<HTMLElement | null>
  stagedCount: number
  unstagedCount: number
  conflictedCount: number
  layout: WorkingLayout
  /** Expanded (description, amend), else a single summary row. */
  open: boolean
  /** Height set with the splitter above it, or null for its natural height. */
  height: number | null
  act: Act
  ai: boolean
  onCompose(): void
}): React.JSX.Element {
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [amend, setAmend] = useState(false)

  const toggleAmend = async (checked: boolean): Promise<void> => {
    setAmend(checked)
    if (checked && !summary && !description) {
      const message = await window.api.lastCommitMessage(repo)
      const [first, ...rest] = message.split('\n')
      setSummary(first ?? '')
      setDescription(rest.join('\n').trim())
    }
  }

  const commit = async (): Promise<void> => {
    const message = description.trim()
      ? `${summary.trim()}\n\n${description.trim()}`
      : summary.trim()
    const ok = await act(amend ? 'Amending' : 'Committing', () =>
      window.api.commit(repo, message, amend)
    )
    if (ok) {
      setSummary('')
      setDescription('')
      setAmend(false)
    }
  }

  const canCommit =
    (stagedCount > 0 || amend) && (summary.trim().length > 0 || amend) && conflictedCount === 0
  const commitLabel = amend
    ? 'Amend previous commit'
    : stagedCount
      ? `Commit changes to ${stagedCount} file${stagedCount > 1 ? 's' : ''}`
      : 'Stage files to commit'

  return (
    <section
      ref={boxRef}
      className={open ? 'commit-box' : 'commit-box collapsed'}
      style={height ? { height } : undefined}
    >
      {open && (
        <div className="section-title">
          <SectionToggle id="commit" layout={layout}>
            Commit
          </SectionToggle>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={amend}
              onChange={(e) => toggleAmend(e.target.checked)}
            />
            Amend previous commit
          </label>
        </div>
      )}
      <div className="summary-row">
        {!open && (
          <button
            className="icon-btn small section-toggle-icon"
            aria-expanded={false}
            aria-label="Expand the commit box"
            title="Expand the commit box (description, amend)"
            onClick={() => toggleWorkingSection('commit')}
          >
            <ChevronRight size={14} />
          </button>
        )}
        <div className="summary-wrap">
          <input
            className="input"
            placeholder="Summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && hasMod(e) && canCommit && commit()}
          />
          <span className={summary.length > 72 ? 'counter over' : 'counter'}>
            {72 - summary.length}
          </span>
        </div>
        {ai && open && (
          <AiCommitButton
            repo={repo}
            disabled={stagedCount === 0 && unstagedCount === 0}
            onMessage={(s, d) => {
              setSummary(s)
              setDescription(d)
            }}
          />
        )}
        {!open && description.trim() && (
          // The description is hidden while collapsed but still committed: say so.
          <button
            className="desc-indicator"
            aria-label="Has a description: expand the commit box to see it"
            title={description.trim().split('\n')[0]}
            onClick={() => toggleWorkingSection('commit')}
          >
            + description
          </button>
        )}
        {!open && (
          <button
            className="btn small primary commit-inline"
            disabled={!canCommit}
            onClick={commit}
            aria-label={commitLabel}
            title={`${commitLabel} (${modKey}+Enter)`}
          >
            <Check size={14} />
            Commit
          </button>
        )}
      </div>
      {open && (
        <>
          <textarea
            className="input"
            placeholder="Description (optional)"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && hasMod(e) && canCommit && commit()}
          />
          <button
            className="btn primary block"
            disabled={!canCommit}
            onClick={commit}
            title={`${modKey}+Enter`}
          >
            {commitLabel}
          </button>
        </>
      )}
      {ai && open && (
        <button
          className="btn block compose-btn"
          disabled={!(stagedCount || unstagedCount) || conflictedCount > 0}
          onClick={onCompose}
          title="Let AI split your changes into a series of focused commits"
        >
          <Sparkles size={14} /> Compose commits with AI…
        </button>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------

interface CommitProps {
  repo: string
  sha: string
  activeFile: DiffTarget | null
  avatars: AvatarMap
  onOpenFile(target: DiffTarget): void
  onSelectSha(sha: string): void
  onFileHistory(path: string): void
  editor: EditorChoice
}

export const CommitPanel = memo(function CommitPanel({
  repo,
  sha,
  activeFile,
  avatars,
  onOpenFile,
  onSelectSha,
  onFileHistory,
  editor
}: CommitProps): React.JSX.Element {
  const [openMenu, menu] = useFileMenu(repo, editor, onFileHistory)
  const [result, setResult] = useState<{
    sha: string
    details: CommitDetails | null
    error: string | null
  }>()

  useEffect(() => {
    let cancelled = false
    window.api.commitDetails(repo, sha).then(
      (details) => !cancelled && setResult({ sha, details, error: null }),
      (e) => !cancelled && setResult({ sha, details: null, error: errorMessage(e) })
    )
    return () => {
      cancelled = true
    }
  }, [repo, sha])

  const details = result?.sha === sha ? result.details : null
  const error = result?.sha === sha ? result.error : null
  const openCommitFile = useLatest((f: FileChange) => {
    if (details)
      onOpenFile({ kind: 'commit', sha: details.sha, parent: details.parents[0] ?? null, file: f })
  })
  const fileMenu = useLatest((e: React.MouseEvent, f: FileChange) => openMenu(e, f))

  if (error)
    return (
      <div className="side-panel">
        <div className="empty-state error">{error}</div>
      </div>
    )
  if (!details)
    return (
      <div className="side-panel">
        <div className="empty-state">Loading…</div>
      </div>
    )

  return (
    <div className="side-panel commit">
      <section>
        <div className="commit-sha">
          <span>commit {shortSha(details.sha)}</span>
          <button
            className="icon-btn"
            title="Copy full SHA"
            onClick={() => navigator.clipboard.writeText(details.sha)}
          >
            <Copy size={13} />
          </button>
          {details.parents.length > 0 && (
            <span className="parents">
              parent{details.parents.length > 1 ? 's' : ''}{' '}
              {details.parents.map((p) => (
                <button key={p} className="link-btn mono" onClick={() => onSelectSha(p)}>
                  {shortSha(p)}
                </button>
              ))}
            </span>
          )}
        </div>
        <h2 className="commit-subject">
          <CodeText text={details.subject} />
        </h2>
        {details.body && (
          <pre className="commit-body">
            <CodeText text={details.body} />
          </pre>
        )}
        <div className="commit-author">
          <Avatar name={details.author} src={avatars[details.email.toLowerCase()]} size={32} />
          <div>
            <div>
              {details.author} <span className="muted">&lt;{details.email}&gt;</span>
            </div>
            <div className="muted">authored {fullDate(details.date)}</div>
            {details.committer !== details.author && (
              <div className="muted">
                committed by {details.committer}, {fullDate(details.committerDate)}
              </div>
            )}
          </div>
        </div>
      </section>
      <section className="grow">
        <div className="section-title">
          <span>
            {details.files.length} file{details.files.length === 1 ? '' : 's'} changed
            {details.parents.length > 1 && <span className="muted"> (vs. first parent)</span>}
          </span>
        </div>
        <FileList
          files={details.files}
          activePath={
            activeFile?.kind === 'commit' && activeFile.sha === sha ? activeFile.file.path : null
          }
          onOpen={openCommitFile}
          onMenu={fileMenu}
        />
      </section>
      {menu}
    </div>
  )
})
