import { ExternalLink, History, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AvatarMap,
  BlameLine,
  Commit,
  CommitDetails,
  DiffTarget,
  FileChange
} from '../../../shared/types'
import { errorMessage, fileName, fullDate, relativeTime, shortSha } from '../lib/format'
import { hasHiddenCharsAt } from '../lib/highlight'
import { CodeText, DiffView, HiddenCharsBanner } from './DiffView'
import { LineHistoryView } from './gitextras/LineHistoryView'
import { Avatar } from './ui'
import { useEscape, useOpenFile } from './ui-context'
import '../assets/features.css'
import '../assets/gitextras.css'

interface Props {
  repo: string
  path: string
  onClose(): void
  onSelectSha(sha: string): void
  avatars: AvatarMap
  showAvatars: boolean
}

type Mode = 'history' | 'blame'

const HISTORY_LIMIT = 300
const BLAME_ROW_H = 20
const NOT_COMMITTED = /^0+$/

const noop = (): void => {}

export function FileHistoryView({
  repo,
  path,
  onClose,
  onSelectSha,
  avatars,
  showAvatars
}: Props): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('history')
  /** Range picked in Blame whose history is shown (git log -L). */
  const [lineRange, setLineRange] = useState<{ path: string; start: number; end: number } | null>(
    null
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const openFile = useOpenFile()
  useEscape(rootRef, onClose)
  const closeLines = useCallback(() => setLineRange(null), [])
  const range = lineRange?.path === path ? lineRange : null

  return (
    <div className="file-history" ref={rootRef} data-escape>
      <div className="diff-header">
        <History size={15} className="muted" />
        <bdi className="diff-path" title={path}>
          <CodeText text={path} />
        </bdi>
        <button
          className="icon-btn"
          title="Open in editor"
          aria-label="Open in editor"
          onClick={() => openFile(repo, path)}
        >
          <ExternalLink size={14} />
        </button>
        <span className="spacer" />
        <div className="segmented fh-tabs" role="tablist" aria-label="File view">
          <button
            role="tab"
            aria-selected={mode === 'history'}
            className={mode === 'history' ? 'active' : ''}
            onClick={() => {
              setMode('history')
              closeLines()
            }}
          >
            History
          </button>
          <button
            role="tab"
            aria-selected={mode === 'blame'}
            className={mode === 'blame' ? 'active' : ''}
            onClick={() => {
              setMode('blame')
              closeLines()
            }}
          >
            Blame
          </button>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <X size={16} />
        </button>
      </div>
      {range ? (
        <LineHistoryView
          repo={repo}
          path={path}
          startLine={range.start}
          endLine={range.end}
          onClose={closeLines}
          onSelectSha={onSelectSha}
        />
      ) : mode === 'history' ? (
        <HistoryPane
          key={path}
          repo={repo}
          path={path}
          onSelectSha={onSelectSha}
          avatars={avatars}
          showAvatars={showAvatars}
        />
      ) : (
        <BlamePane
          key={path}
          repo={repo}
          path={path}
          onSelectSha={onSelectSha}
          avatars={avatars}
          showAvatars={showAvatars}
          onLineHistory={(start, end) => setLineRange({ path, start, end })}
        />
      )}
    </div>
  )
}

type PaneProps = Omit<Props, 'onClose'>

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** The commit's entry for this file: exact path, or a moved file with the same name. */
function findFile(details: CommitDetails, path: string): FileChange | null {
  const exact = details.files.find((f) => f.path === path || f.origPath === path)
  if (exact) return exact
  const name = fileName(path)
  const moved = details.files.filter((f) => fileName(f.path) === name)
  return moved.length === 1 ? moved[0] : null
}

function HistoryPane({
  repo,
  path,
  onSelectSha,
  avatars,
  showAvatars
}: PaneProps): React.JSX.Element {
  const key = `${repo}\0${path}`
  const [result, setResult] = useState<{
    key: string
    commits: Commit[] | null
    error: string | null
  }>()
  // undefined = newest commit by default, null = diff closed.
  const [selected, setSelected] = useState<string | null | undefined>(undefined)
  const [details, setDetails] = useState<{ sha: string; file: FileChange | null; error: boolean }>()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    window.api.fileHistory(repo, path, HISTORY_LIMIT).then(
      (commits) => !cancelled && setResult({ key, commits, error: null }),
      (e) => !cancelled && setResult({ key, commits: null, error: errorMessage(e) })
    )
    return () => {
      cancelled = true
    }
  }, [repo, path, key])

  const current = result?.key === key ? result : undefined
  const commits = current?.commits ?? null
  const selectedSha = selected === undefined ? (commits?.[0]?.sha ?? null) : selected
  const commit = commits?.find((c) => c.sha === selectedSha) ?? null

  // The commit's file list tells the change kind (added, renamed…) and the path at that time.
  useEffect(() => {
    if (!selectedSha) return
    let cancelled = false
    window.api.commitDetails(repo, selectedSha).then(
      (d) => !cancelled && setDetails({ sha: selectedSha, file: findFile(d, path), error: false }),
      () => !cancelled && setDetails({ sha: selectedSha, file: null, error: true })
    )
    return () => {
      cancelled = true
    }
  }, [repo, path, selectedSha])

  const currentDetails = details?.sha === selectedSha ? details : undefined
  const target = useMemo<DiffTarget | null>(() => {
    if (!commit || !currentDetails) return null
    const file = currentDetails.error ? { path, kind: 'M' as const } : currentDetails.file
    if (!file) return null
    return { kind: 'commit', sha: commit.sha, parent: commit.parents[0] ?? null, file }
  }, [commit, currentDetails, path])

  const pick = (sha: string): void => {
    setSelected(sha)
    onSelectSha(sha)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!commits?.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
    e.preventDefault()
    const index = commits.findIndex((c) => c.sha === selectedSha)
    const next = Math.max(0, Math.min(commits.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))
    pick(commits[next].sha)
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${next}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  if (current?.error) return <div className="empty-state error">{current.error}</div>
  if (!commits) return <div className="empty-state">Loading history…</div>
  if (!commits.length) {
    return <div className="empty-state">No commits touch this file yet.</div>
  }

  return (
    <div className="fh-split">
      <div
        className={selectedSha ? 'fh-list' : 'fh-list full'}
        ref={listRef}
        tabIndex={0}
        role="listbox"
        aria-label="Commits that changed this file"
        onKeyDown={onKeyDown}
      >
        {commits.map((c, i) => (
          <div
            key={c.sha}
            data-index={i}
            role="option"
            aria-selected={c.sha === selectedSha}
            className={c.sha === selectedSha ? 'fh-row selected' : 'fh-row'}
            onClick={() => pick(c.sha)}
            title={`${c.subject}\n${c.author}, ${fullDate(c.date)}`}
          >
            {showAvatars && (
              <Avatar name={c.author} src={avatars[c.email.toLowerCase()]} size={18} />
            )}
            <span className="fh-subject">{c.subject}</span>
            <span className="fh-author">{c.author}</span>
            <span className="fh-date">{relativeTime(c.date)}</span>
            <span className="fh-sha mono">{shortSha(c.sha)}</span>
          </div>
        ))}
        {commits.length >= HISTORY_LIMIT && (
          <div className="fh-more muted">Showing the {HISTORY_LIMIT} most recent commits.</div>
        )}
      </div>
      {selectedSha && (
        <div className="fh-diff">
          {target ? (
            <DiffView
              repo={repo}
              target={target}
              version={0}
              onClose={() => setSelected(null)}
              onHunk={noop}
              onFile={noop}
            />
          ) : currentDetails ? (
            <div className="empty-state">
              This commit changed the file under an earlier name (history follows renames), so there
              is no diff for {fileName(path)} here. Open the commit to see all its files.
            </div>
          ) : (
            <div className="empty-state">Loading…</div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Blame
// ---------------------------------------------------------------------------

interface BlameInfo {
  lines: BlameLine[]
  /** Index of the first line of the run each line belongs to. */
  runStart: number[]
  /** Run number of each line (for alternating bands). */
  runIndex: number[]
  minDate: number
  maxDate: number
}

function analyse(lines: BlameLine[]): BlameInfo {
  const runStart: number[] = []
  const runIndex: number[] = []
  let run = -1
  let minDate = Infinity
  let maxDate = -Infinity
  lines.forEach((l, i) => {
    if (i === 0 || lines[i - 1].sha !== l.sha) run++
    runIndex.push(run)
    runStart.push(i > 0 && runIndex[i - 1] === run ? runStart[i - 1] : i)
    if (!NOT_COMMITTED.test(l.sha)) {
      minDate = Math.min(minDate, l.date)
      maxDate = Math.max(maxDate, l.date)
    }
  })
  return { lines, runStart, runIndex, minDate, maxDate }
}

/** Newer lines get a stronger accent stripe. */
function ageColor(info: BlameInfo, line: BlameLine): string {
  if (NOT_COMMITTED.test(line.sha)) return 'var(--warn)'
  const span = info.maxDate - info.minDate
  const t = span > 0 ? (line.date - info.minDate) / span : 1
  return `color-mix(in srgb, var(--accent) ${Math.round(12 + 88 * t)}%, var(--border))`
}

/** Lines picked in the blame gutter (1-based, as shown). */
interface LineSelection {
  anchor: number
  end: number
}

function BlamePane({
  repo,
  path,
  onSelectSha,
  avatars,
  showAvatars,
  onLineHistory
}: PaneProps & { onLineHistory(start: number, end: number): void }): React.JSX.Element {
  const key = `${repo}\0${path}`
  const [result, setResult] = useState<{
    key: string
    info: BlameInfo | null
    error: string | null
  }>()
  const [hoverRun, setHoverRun] = useState<number | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(600)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState<LineSelection | null>(null)
  const dragging = useRef(false)

  useEffect(() => {
    const up = (): void => {
      dragging.current = false
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.blame(repo, path, null).then(
      (lines) => !cancelled && setResult({ key, info: analyse(lines), error: null }),
      (e) => !cancelled && setResult({ key, info: null, error: errorMessage(e) })
    )
    return () => {
      cancelled = true
    }
  }, [repo, path, key])

  const current = result?.key === key ? result : undefined
  const info = current?.info ?? null
  // Line 1's leading U+FEFF is the file's byte order mark, not a hidden character.
  const hidden = useMemo(
    () => !!info?.lines.some((l) => hasHiddenCharsAt(l.text, l.line === 1)),
    [info]
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [info])

  if (current?.error) return <div className="empty-state error">{current.error}</div>
  if (!info) return <div className="empty-state">Loading blame…</div>
  if (!info.lines.length) return <div className="empty-state">This file is empty.</div>

  const { lines } = info
  const first = Math.max(0, Math.floor(scrollTop / BLAME_ROW_H) - 20)
  const last = Math.min(lines.length, Math.ceil((scrollTop + viewHeight) / BLAME_ROW_H) + 20)
  const digits = String(lines[lines.length - 1].line).length

  const open = (line: BlameLine): void => {
    if (NOT_COMMITTED.test(line.sha)) return
    // Selecting code to copy it is not a click on the commit.
    if (window.getSelection()?.toString()) return
    setPicked(line.sha)
    onSelectSha(line.sha)
  }

  const selStart = sel ? Math.min(sel.anchor, sel.end) : 0
  const selEnd = sel ? Math.max(sel.anchor, sel.end) : 0
  const hasUncommitted = lines.some((l) => NOT_COMMITTED.test(l.sha))

  /** Click: one line (again: clear), Shift-click: extend, drag: range. */
  const lineDown = (n: number, e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    if (e.shiftKey && sel) setSel({ anchor: sel.anchor, end: n })
    else if (sel && selStart === n && selEnd === n) setSel(null)
    else setSel({ anchor: n, end: n })
    dragging.current = !e.shiftKey
  }
  const lineEnter = (n: number): void => {
    if (dragging.current) setSel((s) => (s ? { anchor: s.anchor, end: n } : s))
  }

  const rows: React.JSX.Element[] = []
  for (let i = first; i < last; i++) {
    const line = lines[i]
    const run = info.runIndex[i]
    const uncommitted = NOT_COMMITTED.test(line.sha)
    // Show the commit on the first line of each run, and on the first visible line.
    const showInfo = info.runStart[i] === i || i === first
    const classes = ['bl-row']
    if (run % 2) classes.push('odd')
    if (info.runStart[i] === i) classes.push('run-start')
    if (hoverRun === run && !uncommitted) classes.push('hover')
    if (picked === line.sha && !uncommitted) classes.push('picked')
    if (uncommitted) classes.push('uncommitted')
    if (sel && line.line >= selStart && line.line <= selEnd) classes.push('line-sel')
    rows.push(
      <div
        key={i}
        className={classes.join(' ')}
        title={
          uncommitted
            ? 'Not committed yet'
            : `${shortSha(line.sha)} ${line.summary}\n${line.author}, ${fullDate(line.date)}`
        }
        onMouseEnter={() => setHoverRun(run)}
        onClick={() => open(line)}
      >
        <span className="bl-gutter" style={{ borderLeftColor: ageColor(info, line) }}>
          {showInfo &&
            (uncommitted ? (
              <span className="bl-author muted">Not committed yet</span>
            ) : (
              <>
                {showAvatars && (
                  <Avatar name={line.author} src={avatars[line.email.toLowerCase()]} size={14} />
                )}
                <span className="bl-author">{line.author}</span>
                <span className="bl-date">{relativeTime(line.date)}</span>
                <span className="bl-sha mono">{shortSha(line.sha)}</span>
              </>
            ))}
        </span>
        <span
          className="bl-ln pick"
          style={{ width: `calc(${digits}ch + 16px)` }}
          title="Select lines for their history (Shift: range, drag: several)"
          onMouseDown={(e) => lineDown(line.line, e)}
          onMouseEnter={() => lineEnter(line.line)}
          onClick={(e) => e.stopPropagation()}
        >
          {line.line}
        </span>
        <span className="bl-code">
          <CodeText text={line.text} fileStart={line.line === 1} />
        </span>
      </div>
    )
  }

  return (
    <>
      {hidden && <HiddenCharsBanner />}
      <div className="bl-select-bar">
        {sel ? (
          <>
            <span>
              {selStart === selEnd ? `Line ${selStart}` : `Lines ${selStart}–${selEnd}`} selected
            </span>
            <button className="btn small primary" onClick={() => onLineHistory(selStart, selEnd)}>
              <History size={13} /> Line history
            </button>
            <button
              className="icon-btn small"
              onClick={() => setSel(null)}
              title="Clear the selection"
              aria-label="Clear the line selection"
            >
              <X size={13} />
            </button>
            {hasUncommitted && (
              <span className="muted">
                This file has uncommitted changes: the history uses the line numbers of the last
                commit.
              </span>
            )}
          </>
        ) : (
          <span className="muted">
            Click or drag line numbers to see the history of those lines.
          </span>
        )}
      </div>
      <div
        className="blame-scroll"
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onMouseLeave={() => setHoverRun(null)}
      >
        <div className="bl-sizer" style={{ height: lines.length * BLAME_ROW_H }}>
          <div className="bl-lines" style={{ top: first * BLAME_ROW_H }}>
            {rows}
          </div>
        </div>
      </div>
    </>
  )
}
