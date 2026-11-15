import { Columns2, Minus, Plus, Rows2, TriangleAlert, Undo2, X } from 'lucide-react'
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { DiffTarget } from '../../../shared/types'
import '../assets/diff.css'
import {
  changedBetween,
  chunkRanges,
  hunkPatch,
  isChange,
  isImmutableTarget,
  lineNumberDigits,
  linesPatch,
  parseDiff,
  toSplitRows,
  type DiffLine,
  type Hunk,
  type ParsedDiff,
  type SplitRow
} from '../lib/diff'
import { errorMessage, shortSha } from '../lib/format'
import {
  hasHiddenChars,
  BOM_TITLE,
  hiddenCharInfo,
  highlightHunk,
  hunksHaveHiddenChars,
  languageFor,
  MAX_HIGHLIGHT_LINES,
  splitHidden,
  type Language
} from '../lib/highlight'
import { ConflictView } from './ConflictView'
import { KindBadge } from './ui'
import { useEscape } from './ui-context'

export type HunkAction = 'stage' | 'unstage' | 'discard'

interface Props {
  repo: string
  target: DiffTarget
  /** Changes whenever the repository changed, so the diff is re-read. */
  version: number
  onClose(): void
  onHunk(action: HunkAction, patch: string): void
  onFile(action: HunkAction): void
}

type Mode = 'unified' | 'split'

function loadMode(): Mode {
  try {
    return localStorage.getItem('gitdesk.diffMode') === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

function saveMode(mode: Mode): void {
  try {
    localStorage.setItem('gitdesk.diffMode', mode)
  } catch {
    /* preference only */
  }
}

const SIGN = { add: '+', del: '-', ctx: ' ', note: '' }

/** A ref of a comparison as shown in the header (shas shortened). */
function compareRef(ref: string): string {
  return /^[0-9a-f]{40,64}$/i.test(ref) ? shortSha(ref) : ref
}

/** A stable function that always calls the latest `fn` (for memoized children). */
function useLatest<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}

// ---------------------------------------------------------------------------
// Hidden characters: bidi controls and invisible characters are shown as markers.

function HiddenChar({ ch }: { ch: string }): React.JSX.Element {
  const { code, name } = hiddenCharInfo(ch)
  return (
    <span className="hidden-char" title={`${code} ${name}`}>
      {code}
    </span>
  )
}

/**
 * Repository text, its bidi controls and invisible characters shown as markers (U+202E…).
 * `fileStart`: the text is the file's first line, whose leading U+FEFF is a quiet BOM marker.
 */
export function CodeText({
  text,
  fileStart = false
}: {
  text: string
  fileStart?: boolean
}): React.ReactNode {
  if (!hasHiddenChars(text)) return text
  return splitHidden(text, fileStart).map((part, i) =>
    typeof part === 'string' ? (
      part
    ) : part.bom ? (
      <span key={i} className="hidden-char bom" title={BOM_TITLE}>
        BOM
      </span>
    ) : (
      <HiddenChar key={i} ch={part.hidden} />
    )
  )
}

/** A path or ref name inside a sentence: isolated from its bidi order, hidden characters marked. */
export function Isolated({ text }: { text: string }): React.JSX.Element {
  return (
    <bdi>
      <CodeText text={text} />
    </bdi>
  )
}

/** Shown above code that holds such characters (like GitHub's bidirectional text warning). */
export function HiddenCharsBanner(): React.JSX.Element {
  return (
    <div className="hidden-chars-banner" role="note">
      <TriangleAlert size={14} />
      <span>
        This file contains hidden or bidirectional Unicode characters, shown as markers such as{' '}
        <span className="hidden-char">U+202E</span>. They can make code read differently from what
        it does.
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Long lists are drawn in chunks: a chunk far from the visible part of its scroll box is an
// empty block of the same height, so a 60,000-line diff costs as much as a few screens.

/** Rows per chunk. */
const CHUNK_ROWS = 100
/** Rows drawn at once, before the scroll box tells which chunks are in view. */
const FIRST_ROWS = 200
/** A chunk closer than this to the visible part is drawn. */
const NEAR = '1200px 0px'
/** Height of a code row (line-height of .diff-body), the size of a chunk not drawn yet. */
const ROW_H = 20

interface LazyRoot {
  /** Calls `onNear` whenever `el` comes near the visible part or leaves it; returns the stop. */
  watch(el: Element, onNear: (near: boolean) => void): () => void
}

const LazyContext = createContext<LazyRoot | null>(null)

/** The element that scrolls `el`, or null for the window. */
function scrollParent(el: Element): Element | null {
  for (let e = el.parentElement; e; e = e.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(e).overflowY)) return e
  }
  return null
}

function lazyRoot(): LazyRoot {
  let observer: IntersectionObserver | null = null
  const handlers = new Map<Element, (near: boolean) => void>()
  return {
    watch(el, onNear) {
      // The chunks of one scope share their scroll box: the first one finds it.
      observer ??= new IntersectionObserver(
        (entries) => {
          for (const e of entries) handlers.get(e.target)?.(e.isIntersecting)
        },
        { root: scrollParent(el), rootMargin: NEAR }
      )
      handlers.set(el, onNear)
      observer.observe(el)
      return () => {
        handlers.delete(el)
        observer?.unobserve(el)
      }
    }
  }
}

/**
 * Chunks inside draw only near the visible part of their scroll box (all inside one box);
 * without a scope they all draw.
 */
export function LazyScope({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [root] = useState(lazyRoot)
  return <LazyContext.Provider value={root}>{children}</LazyContext.Provider>
}

/** `rows` rows drawn by `children` while near the visible part, else an empty block. */
export function LazyRows({
  rows,
  eager,
  className,
  children
}: {
  rows: number
  /** Drawn at once (the first rows of a view). */
  eager: boolean
  className: string
  children: React.ReactNode
}): React.JSX.Element {
  const lazy = useContext(LazyContext)
  const [near, setNear] = useState(eager || !lazy)
  /** Height the rows took when drawn (wrapped lines make it more than rows × ROW_H). */
  const [height, setHeight] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!lazy || !el) return
    return lazy.watch(el, setNear)
  }, [lazy])
  useEffect(() => {
    const el = ref.current
    if (!lazy || !near || !el) return
    // 0 while hidden (another tab shown): keeps the last real height.
    const observer = new ResizeObserver(() => el.offsetHeight > 0 && setHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [lazy, near])
  // The same element either way, so the observer keeps watching it.
  return near ? (
    <div ref={ref} className={className}>
      {children}
    </div>
  ) : (
    <div ref={ref} className="lazy-rows" style={{ height: height ?? rows * ROW_H }} />
  )
}

// ---------------------------------------------------------------------------
// Hunks

/** Line selection of one hunk, for staging single lines. Null = read-only hunk. */
export interface LinePicker {
  /** Mouse down on a line's gutter (starts a drag; Shift selects a range). */
  down(line: number, e: React.MouseEvent): void
  /** Pointer entered a line's gutter (extends a drag). */
  enter(line: number): void
  /** Space / Enter on a focused gutter. */
  key(line: number, e: React.KeyboardEvent): void
}

export interface HunkProps {
  hunk: Hunk
  /** Highlighted HTML per line (same indexes as hunk.lines), or null for plain text. */
  html: (string | null)[] | null
  picker: LinePicker | null
  /** Picked lines (indexes in hunk.lines). */
  selected?: ReadonlySet<number>
  /** Rows of the diff before this hunk: the first rows of a diff are drawn at once. */
  offset?: number
}

const NONE: ReadonlySet<number> = new Set()

function Code({
  html,
  text,
  fileStart
}: {
  html: string | null | undefined
  text: string
  /** The file's first line (see CodeText). */
  fileStart: boolean
}): React.ReactNode {
  // highlight.js escapes the source text (and hidden characters are markers), so its HTML is
  // safe to inject.
  return html != null ? (
    <span dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <CodeText text={text} fileStart={fileStart} />
  )
}

const isFileStart = (line: DiffLine): boolean => line.oldNo === 1 || line.newNo === 1

/** Props that make a gutter cell pick its line. */
function gutter(
  picker: LinePicker | null,
  line: DiffLine,
  index: number,
  on: boolean,
  focusable: boolean
): React.HTMLAttributes<HTMLSpanElement> {
  if (!picker || !isChange(line)) return {}
  return {
    onMouseDown: (e) => picker.down(index, e),
    onMouseEnter: () => picker.enter(index),
    ...(focusable && {
      role: 'checkbox',
      tabIndex: 0,
      'aria-checked': on,
      'aria-label': `${line.kind === 'add' ? 'Added' : 'Removed'} line ${
        (line.kind === 'add' ? line.newNo : line.oldNo) ?? ''
      }`,
      title: 'Select this line (Shift: range, drag: several)',
      onKeyDown: (e: React.KeyboardEvent) => picker.key(index, e)
    })
  }
}

/** Fixed gutter width, the same in every chunk of a hunk. */
function gutterStyle(hunk: Hunk): React.CSSProperties {
  return { '--ln-w': `max(4ch, calc(${lineNumberDigits([hunk])}ch + 16px))` } as React.CSSProperties
}

interface RowProps {
  line: DiffLine
  index: number
  html: string | null | undefined
  on: boolean
  picker: LinePicker | null
}

/** One line in unified mode: re-rendered only when its own props change. */
const UnifiedRow = memo(function UnifiedRow({
  line,
  index,
  html,
  on,
  picker
}: RowProps): React.JSX.Element {
  const sel = on ? ' selected' : ''
  const pick = picker && isChange(line) ? ' pick' : ''
  return (
    <>
      <span className={`ln ${line.kind}${sel}${pick}`} {...gutter(picker, line, index, on, true)}>
        {line.oldNo ?? ''}
      </span>
      <span className={`ln ${line.kind}${sel}${pick}`} {...gutter(picker, line, index, on, false)}>
        {line.newNo ?? ''}
      </span>
      <span className={`code ${line.kind}${sel}`}>
        <span className="sign">{SIGN[line.kind]}</span>
        <Code html={html} text={line.text} fileStart={isFileStart(line)} />
      </span>
    </>
  )
})

interface ChunkProps {
  hunk: Hunk
  from: number
  to: number
  html: (string | null)[] | null
  picker: LinePicker | null
  selected: ReadonlySet<number>
}

const UnifiedChunk = memo(function UnifiedChunk({
  hunk,
  from,
  to,
  html,
  picker,
  selected
}: ChunkProps): React.JSX.Element {
  const rows: React.JSX.Element[] = []
  for (let i = from; i < to; i++) {
    rows.push(
      <UnifiedRow
        key={i}
        line={hunk.lines[i]}
        index={i}
        html={html?.[i]}
        on={selected.has(i)}
        picker={picker}
      />
    )
  }
  return <>{rows}</>
})

/** One hunk, unified; read-only with a null picker (also used by the line history view). */
export const UnifiedHunk = memo(function UnifiedHunk({
  hunk,
  html,
  picker,
  selected = NONE,
  offset = 0
}: HunkProps): React.JSX.Element {
  return (
    <div
      className={`diff-lines unified chunked${picker ? ' pickable' : ''}`}
      style={gutterStyle(hunk)}
    >
      {chunkRanges(hunk.lines.length, CHUNK_ROWS).map(([from, to]) => (
        <LazyRows
          key={from}
          rows={to - from}
          eager={offset + from < FIRST_ROWS}
          className="diff-chunk"
        >
          <UnifiedChunk
            hunk={hunk}
            from={from}
            to={to}
            html={html}
            picker={picker}
            selected={selected}
          />
        </LazyRows>
      ))}
    </div>
  )
})

const SplitSide = memo(function SplitSide({
  line,
  index,
  side,
  html,
  on,
  picker
}: Omit<RowProps, 'line'> & { line: DiffLine | null; side: 'left' | 'right' }): React.JSX.Element {
  if (!line) {
    return (
      <>
        <span className="ln empty" />
        <span className="code empty" />
      </>
    )
  }
  const no = side === 'left' ? line.oldNo : line.newNo
  // Context lines appear on both sides; only changed lines can be picked.
  const sel = on && isChange(line) ? ' selected' : ''
  const pick = picker && isChange(line) ? ' pick' : ''
  return (
    <>
      <span className={`ln ${line.kind}${sel}${pick}`} {...gutter(picker, line, index, on, true)}>
        {no ?? ''}
      </span>
      <span className={`code ${line.kind}${sel}`}>
        <Code html={html} text={line.text} fileStart={isFileStart(line)} />
      </span>
    </>
  )
})

const SplitChunk = memo(function SplitChunk({
  rows,
  indexOf,
  from,
  to,
  html,
  picker,
  selected
}: Omit<ChunkProps, 'hunk'> & {
  rows: SplitRow[]
  indexOf: Map<DiffLine, number>
}): React.JSX.Element {
  const at = (l: DiffLine | null): number => (l ? (indexOf.get(l) ?? -1) : -1)
  const out: React.JSX.Element[] = []
  for (let i = from; i < to; i++) {
    for (const side of ['left', 'right'] as const) {
      const index = at(rows[i][side])
      out.push(
        <SplitSide
          key={`${i}${side}`}
          line={rows[i][side]}
          index={index}
          side={side}
          html={html?.[index]}
          on={selected.has(index)}
          picker={picker}
        />
      )
    }
  }
  return <>{out}</>
})

function SplitHunk({
  hunk,
  html,
  picker,
  selected = NONE,
  offset = 0
}: HunkProps): React.JSX.Element {
  const rows = useMemo(() => toSplitRows(hunk), [hunk])
  const indexOf = useMemo(() => new Map(hunk.lines.map((l, i) => [l, i])), [hunk])
  return (
    <div
      className={`diff-lines split chunked${picker ? ' pickable' : ''}`}
      style={gutterStyle(hunk)}
    >
      {chunkRanges(rows.length, CHUNK_ROWS).map(([from, to]) => (
        <LazyRows
          key={from}
          rows={to - from}
          eager={offset + from < FIRST_ROWS}
          className="diff-chunk"
        >
          <SplitChunk
            rows={rows}
            indexOf={indexOf}
            from={from}
            to={to}
            html={html}
            picker={picker}
            selected={selected}
          />
        </LazyRows>
      ))}
    </div>
  )
}

/** What a hunk's header buttons do; stable, so hunks stay memoized. */
interface HunkActions {
  lines(action: HunkAction, hunk: Hunk, lines: ReadonlySet<number>): void
  hunk(action: HunkAction, hunk: Hunk): void
  clear(): void
}

/** A hunk with its header: re-rendered only when its own selection or content changes. */
const HunkBlock = memo(function HunkBlock({
  hunk,
  offset,
  mode,
  html,
  picker,
  selected,
  editable,
  actions
}: Required<HunkProps> & {
  mode: Mode
  /** The working-copy side the hunk can be staged from, or null when read-only. */
  editable: 'staged' | 'unstaged' | null
  actions: HunkActions
}): React.JSX.Element {
  const picked = selected.size
  return (
    <div className="hunk">
      <div className="hunk-header">
        <code>
          <CodeText text={hunk.header} />
        </code>
        <span className="spacer" />
        {editable && picked > 0 && (
          <>
            <span className="hunk-picked">
              {picked} line{picked > 1 ? 's' : ''} selected
            </span>
            <button
              className="icon-btn small"
              onClick={actions.clear}
              title="Clear the selection (Esc)"
              aria-label="Clear the line selection"
            >
              <X size={13} />
            </button>
          </>
        )}
        {editable === 'unstaged' && picked > 0 && (
          <>
            <button className="btn small" onClick={() => actions.lines('discard', hunk, selected)}>
              Discard selected lines
            </button>
            <button
              className="btn small primary"
              onClick={() => actions.lines('stage', hunk, selected)}
            >
              Stage selected lines
            </button>
          </>
        )}
        {editable === 'staged' && picked > 0 && (
          <button className="btn small" onClick={() => actions.lines('unstage', hunk, selected)}>
            Unstage selected lines
          </button>
        )}
        {editable === 'unstaged' && picked === 0 && (
          <>
            <button className="btn small" onClick={() => actions.hunk('discard', hunk)}>
              Discard hunk
            </button>
            <button className="btn small primary" onClick={() => actions.hunk('stage', hunk)}>
              Stage hunk
            </button>
          </>
        )}
        {editable === 'staged' && picked === 0 && (
          <button className="btn small" onClick={() => actions.hunk('unstage', hunk)}>
            Unstage hunk
          </button>
        )}
      </div>
      {mode === 'split' ? (
        <SplitHunk hunk={hunk} html={html} picker={picker} selected={selected} offset={offset} />
      ) : (
        <UnifiedHunk hunk={hunk} html={html} picker={picker} selected={selected} offset={offset} />
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------

interface Selection {
  /** Diff the selection belongs to: a re-read diff with other text starts with nothing. */
  diff: ParsedDiff
  hunk: number
  lines: Set<number>
  /** Last line clicked, start of a Shift-click range. */
  anchor: number
}

/** Beyond this many lines highlighting runs after the plain diff is shown. */
const SYNC_HIGHLIGHT_LINES = 1000

type Highlighted = ((string | null)[] | null)[]

function highlightDiff(diff: ParsedDiff, language: Language): Highlighted {
  return diff.hunks.map((h) => highlightHunk(h, language))
}

// Memoized: RepoView passes stable handlers, so a refresh that changed nothing (or a click
// in the graph behind it) leaves the diff as it is.
export const DiffView = memo(function DiffView({
  repo,
  target,
  version,
  onClose,
  onHunk,
  onFile
}: Props): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(loadMode)
  const [result, setResult] = useState<{ key: string; text: string | null; error: string | null }>()
  const key = JSON.stringify(target)
  const { file } = target
  const conflicted = target.kind === 'unstaged' && file.kind === 'U'
  // History never changes: a refresh of the repository does not re-read it.
  const refresh = isImmutableTarget(target) ? 0 : version
  // Read by key: an equal target in a new object is not a reason to read the diff again.
  const targetRef = useRef(target)
  useLayoutEffect(() => {
    targetRef.current = target
  })

  useEffect(() => {
    if (conflicted) return
    let cancelled = false
    // The same text again keeps the same state: nothing is parsed or drawn again.
    const set = (text: string | null, error: string | null): void =>
      setResult((r) =>
        r?.key === key && r.text === text && r.error === error ? r : { key, text, error }
      )
    window.api.diff(repo, targetRef.current).then(
      (text) => !cancelled && set(text, null),
      (e) => !cancelled && set(null, errorMessage(e))
    )
    return () => {
      cancelled = true
    }
  }, [repo, key, refresh, conflicted])

  // A result for another file is stale: show "Loading" until this file's diff arrives.
  const current = result?.key === key ? result : undefined
  const text = current?.text ?? null
  const error = current?.error ?? null

  const parsed = useMemo(() => (text === null ? null : parseDiff(text)), [text])
  // Commits and comparisons are history: shown read-only.
  const editable =
    (target.kind === 'staged' || target.kind === 'unstaged') &&
    file.kind !== '?' &&
    !!parsed &&
    !parsed.binary &&
    !parsed.combined
      ? target.kind
      : null
  const hidden = useMemo(() => !!parsed && hunksHaveHiddenChars(parsed.hunks), [parsed])

  // Highlight each hunk once per diff; skipped for unknown languages and huge diffs. A long
  // diff is shown plain first and highlighted just after.
  const language = languageFor(file.path)
  const total = useMemo(() => parsed?.hunks.reduce((n, h) => n + h.lines.length, 0) ?? 0, [parsed])
  const highlight = !!parsed && !!language && !parsed.binary && total <= MAX_HIGHLIGHT_LINES
  const deferred = total > SYNC_HIGHLIGHT_LINES
  const syncHtml = useMemo(
    () => (parsed && language && highlight && !deferred ? highlightDiff(parsed, language) : null),
    [parsed, language, highlight, deferred]
  )
  const [lateHtml, setLateHtml] = useState<{
    diff: ParsedDiff
    language: Language
    html: Highlighted
  }>()
  useEffect(() => {
    if (!parsed || !language || !highlight || !deferred) return
    let timer = 0
    // After the plain rows are painted.
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() =>
        setLateHtml({ diff: parsed, language, html: highlightDiff(parsed, language) })
      )
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [parsed, language, highlight, deferred])
  const highlighted =
    syncHtml ??
    (lateHtml && lateHtml.diff === parsed && lateHtml.language === language ? lateHtml.html : null)

  // ---- line selection -----------------------------------------------------

  const [selState, setSelection] = useState<Selection | null>(null)
  const selection = selState && selState.diff === parsed ? selState : null
  const selRef = useRef(selection)
  useLayoutEffect(() => {
    selRef.current = selection
  })
  const drag = useRef<{ hunk: number; value: boolean } | null>(null)

  useEffect(() => {
    const up = (): void => {
      drag.current = null
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // One stable picker per hunk: the selection is read when an event comes, so a click only
  // re-renders the rows whose state changed.
  const pickers = useMemo((): LinePicker[] => {
    if (!parsed || !editable) return []
    const setLines = (hunk: number, lines: number[], value: boolean, anchor?: number): void =>
      setSelection((s) => {
        const same = s && s.diff === parsed && s.hunk === hunk
        const next = new Set(same ? s.lines : [])
        for (const l of lines) {
          if (value) next.add(l)
          else next.delete(l)
        }
        return {
          diff: parsed,
          hunk,
          lines: next,
          anchor: anchor ?? (same ? s.anchor : lines[0])
        }
      })
    return parsed.hunks.map((h, hi) => {
      const click = (line: number, shift: boolean): boolean => {
        const s = selRef.current
        if (shift && s?.hunk === hi) {
          setLines(hi, changedBetween(h, s.anchor, line), true, s.anchor)
          return true
        }
        const value = !(s?.hunk === hi && s.lines.has(line))
        setLines(hi, [line], value, line)
        return value
      }
      return {
        down: (line, e) => {
          if (e.button !== 0) return
          e.preventDefault() // no text selection while dragging over gutters
          const value = click(line, e.shiftKey)
          drag.current = e.shiftKey ? null : { hunk: hi, value }
        },
        enter: (line) => {
          if (drag.current?.hunk === hi) setLines(hi, [line], drag.current.value)
        },
        key: (line, e) => {
          if (e.key !== ' ' && e.key !== 'Enter') return
          e.preventDefault()
          click(line, e.shiftKey)
        }
      }
    })
  }, [parsed, editable])

  const clearSelection = useCallback(() => setSelection(null), [])

  // Esc first clears a line selection, then closes the diff.
  const rootRef = useRef<HTMLDivElement>(null)
  const onEscape = useCallback(() => {
    if (selection && selection.lines.size > 0) clearSelection()
    else onClose()
  }, [onClose, selection, clearSelection])
  useEscape(rootRef, onEscape)

  /** Sends the selected lines of a hunk; stage applies forward, unstage/discard in reverse. */
  const sendLines = useLatest((action: HunkAction, hunk: Hunk, lines: ReadonlySet<number>) => {
    if (!parsed) return
    const patch = linesPatch(parsed, hunk, lines, action !== 'stage')
    if (patch) onHunk(action, patch)
  })
  const sendHunk = useLatest((action: HunkAction, hunk: Hunk) => {
    if (parsed) onHunk(action, hunkPatch(parsed, hunk))
  })
  const actions = useMemo<HunkActions>(
    () => ({ lines: sendLines, hunk: sendHunk, clear: clearSelection }),
    [sendLines, sendHunk, clearSelection]
  )

  const context =
    target.kind === 'commit'
      ? `Commit ${shortSha(target.sha)}`
      : target.kind === 'compare'
        ? `${compareRef(target.from)}${target.threeDot ? '...' : '..'}${compareRef(target.to)}`
        : target.kind === 'staged'
          ? 'Staged'
          : conflicted
            ? 'Conflict'
            : 'Unstaged'

  const changeMode = (m: Mode): void => {
    setMode(m)
    saveMode(m)
  }

  // Rows before each hunk, so the first screen of the diff is drawn at once.
  const offsets = useMemo(() => {
    const out: number[] = []
    let n = 0
    for (const h of parsed?.hunks ?? []) {
      out.push(n)
      n += h.lines.length + 1
    }
    return out
  }, [parsed])

  return (
    <div className="diff-view" ref={rootRef} data-escape>
      <div className="diff-header">
        <KindBadge kind={file.kind} />
        <bdi className="diff-path" title={file.path}>
          <CodeText text={file.origPath ? `${file.origPath} → ${file.path}` : file.path} />
        </bdi>
        <span className="diff-context">{context}</span>
        <span className="spacer" />
        {target.kind === 'unstaged' && !conflicted && (
          <>
            <button className="btn small" onClick={() => onFile('discard')}>
              <Undo2 size={14} /> Discard file
            </button>
            <button className="btn small primary" onClick={() => onFile('stage')}>
              <Plus size={14} /> Stage file
            </button>
          </>
        )}
        {target.kind === 'staged' && (
          <button className="btn small" onClick={() => onFile('unstage')}>
            <Minus size={14} /> Unstage file
          </button>
        )}
        {!conflicted && (
          <div className="segmented" role="group" aria-label="Diff layout">
            <button
              className={mode === 'unified' ? 'active' : ''}
              onClick={() => changeMode('unified')}
              title="Unified"
              aria-pressed={mode === 'unified'}
            >
              <Rows2 size={14} />
            </button>
            <button
              className={mode === 'split' ? 'active' : ''}
              onClick={() => changeMode('split')}
              title="Split"
              aria-pressed={mode === 'split'}
            >
              <Columns2 size={14} />
            </button>
          </div>
        )}
        <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close diff">
          <X size={16} />
        </button>
      </div>

      {conflicted ? (
        <ConflictView repo={repo} path={file.path} version={version} onClose={onClose} />
      ) : (
        <>
          {!error && hidden && <HiddenCharsBanner />}
          <div className="diff-body">
            {error && <div className="empty-state error">{error}</div>}
            {!error && parsed === null && <div className="empty-state">Loading…</div>}
            {!error && parsed && parsed.binary && (
              <div className="empty-state">Binary file — no text diff to show.</div>
            )}
            {!error && parsed && !parsed.binary && parsed.hunks.length === 0 && (
              <div className="empty-state">
                No {target.kind === 'staged' || target.kind === 'unstaged' ? target.kind + ' ' : ''}
                changes in this file.
              </div>
            )}
            {!error && parsed && (
              <LazyScope>
                {parsed.hunks.map((hunk, i) => (
                  <HunkBlock
                    key={i}
                    hunk={hunk}
                    offset={offsets[i]}
                    mode={mode}
                    html={highlighted?.[i] ?? null}
                    picker={pickers[i] ?? null}
                    selected={selection?.hunk === i ? selection.lines : NONE}
                    editable={editable}
                    actions={actions}
                  />
                ))}
              </LazyScope>
            )}
          </div>
        </>
      )}
    </div>
  )
})
