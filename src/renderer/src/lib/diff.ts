// Parser for the unified diff of a single file, as printed by `git diff`.

import type { DiffTarget } from '../../../shared/types'

export type LineKind = 'ctx' | 'add' | 'del' | 'note'

export interface DiffLine {
  kind: LineKind
  text: string
  oldNo: number | null
  newNo: number | null
}

export interface Hunk {
  header: string
  lines: DiffLine[]
  /** Original lines (including the @@ header) so the hunk can be re-applied as a patch. */
  raw: string[]
}

export interface ParsedDiff {
  /** "diff --git", "index", "---", "+++" ... lines before the first hunk. */
  header: string[]
  hunks: Hunk[]
  binary: boolean
  /** Combined diff (conflicted file): shown read-only. */
  combined: boolean
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseDiff(text: string): ParsedDiff {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  let i = lines.findIndex((l) => l.startsWith('diff '))
  if (i === -1) i = 0
  const header: string[] = []
  while (i < lines.length && !lines[i].startsWith('@@')) header.push(lines[i++])

  const result: ParsedDiff = {
    header,
    hunks: [],
    binary: header.some((l) => l.startsWith('Binary files') || l.startsWith('GIT binary patch')),
    combined: header.some((l) => l.startsWith('diff --cc') || l.startsWith('diff --combined'))
  }

  let hunk: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  for (; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (raw.startsWith('@@')) {
      const m = HUNK_RE.exec(raw)
      oldNo = m ? Number(m[1]) : 0
      newNo = m ? Number(m[2]) : 0
      hunk = { header: line, lines: [], raw: [raw] }
      result.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    hunk.raw.push(raw)
    if (result.combined) {
      // Two prefix columns; show as context unless either column marks a change.
      const prefix = line.slice(0, 2)
      const kind: LineKind = prefix.includes('+') ? 'add' : prefix.includes('-') ? 'del' : 'ctx'
      hunk.lines.push({ kind, text: line.slice(2), oldNo: null, newNo: null })
      continue
    }
    const sign = line[0]
    const body = line.slice(1)
    if (sign === '+') hunk.lines.push({ kind: 'add', text: body, oldNo: null, newNo: newNo++ })
    else if (sign === '-') hunk.lines.push({ kind: 'del', text: body, oldNo: oldNo++, newNo: null })
    else if (sign === '\\') hunk.lines.push({ kind: 'note', text: line, oldNo: null, newNo: null })
    else hunk.lines.push({ kind: 'ctx', text: body, oldNo: oldNo++, newNo: newNo++ })
  }
  return result
}

/** A patch containing only one hunk, for `git apply`. */
export function hunkPatch(diff: ParsedDiff, hunk: Hunk): string {
  return [...diff.header, ...hunk.raw].join('\n') + '\n'
}

export interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
}

/** Pairs removed and added lines side by side, like a two-column diff. */
export function toSplitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push({ left: dels[i] ?? null, right: adds[i] ?? null })
    }
    dels = []
    adds = []
  }
  for (const line of hunk.lines) {
    if (line.kind === 'del') dels.push(line)
    else if (line.kind === 'add') adds.push(line)
    else {
      flush()
      rows.push(line.kind === 'note' ? { left: line, right: null } : { left: line, right: line })
    }
  }
  flush()
  return rows
}

/** True for the lines that can be picked for line-level staging. */
export function isChange(line: DiffLine): boolean {
  return line.kind === 'add' || line.kind === 'del'
}

/** Changed lines of a hunk between two line indexes, both included (a Shift-click range). */
export function changedBetween(hunk: Hunk | undefined, a: number, b: number): number[] {
  const lines = hunk?.lines ?? []
  const out: number[] = []
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++)
    if (lines[i] && isChange(lines[i])) out.push(i)
  return out
}

const SHA_RE = /^[0-9a-f]{40,64}$/i

/** A commit, or a comparison of two shas, never changes: its diff is read once. */
export function isImmutableTarget(target: DiffTarget): boolean {
  return (
    target.kind === 'commit' ||
    (target.kind === 'compare' && SHA_RE.test(target.from) && SHA_RE.test(target.to))
  )
}

const NO_NEWLINE = '\\ No newline at end of file'

interface PatchLine {
  text: string
  onOld: boolean
  onNew: boolean
  /** Original line came from that side (so its "no newline" flag applies). */
  fromOld: boolean
  fromNew: boolean
  oldNoNl: boolean
  newNoNl: boolean
}

/**
 * A patch with only the `selected` changed lines of `hunk` (indexes into `hunk.lines`).
 *
 * `reverse: false` → for `git apply` forward (stage from the unstaged diff): the old side must
 * match the target, so unselected '-' lines become context and unselected '+' lines are dropped.
 * `reverse: true` → for `git apply --reverse` (unstage from the staged diff, discard from the
 * unstaged diff): the new side must match the target, so unselected '+' lines become context and
 * unselected '-' lines are dropped. Returns null when nothing selected is a change.
 */
export function linesPatch(
  diff: ParsedDiff,
  hunk: Hunk,
  selected: ReadonlySet<number>,
  reverse: boolean
): string | null {
  const changes = hunk.lines.flatMap((l, i) => (isChange(l) ? [i] : []))
  const picked = changes.filter((i) => selected.has(i))
  if (picked.length === 0) return null
  if (picked.length === changes.length) return hunkPatch(diff, hunk)

  // Raw bodies keep any '\r' that parseDiff strips for display.
  const bodies = hunk.raw.slice(1).map((r) => r.slice(1))
  const marker =
    hunk.raw
      .slice(1)
      .find((r) => r.startsWith('\\'))
      ?.replace(/\r$/, '') ?? NO_NEWLINE
  const out: PatchLine[] = []
  let prev: PatchLine | null = null // what the previous original line became, if kept
  hunk.lines.forEach((l, i) => {
    if (l.kind === 'note') {
      // Applies to the previous original line, on the side(s) it belonged to.
      const orig = hunk.lines[i - 1]
      if (prev && orig) {
        if (orig.kind !== 'add') prev.oldNoNl = true
        if (orig.kind !== 'del') prev.newNoNl = true
      }
      return
    }
    const before = out.length
    const sel = selected.has(i)
    const base = { text: bodies[i], oldNoNl: false, newNoNl: false }
    if (l.kind === 'ctx') {
      out.push({ ...base, onOld: true, onNew: true, fromOld: true, fromNew: true })
    } else if (l.kind === 'del') {
      if (sel) out.push({ ...base, onOld: true, onNew: false, fromOld: true, fromNew: false })
      else if (!reverse)
        out.push({ ...base, onOld: true, onNew: true, fromOld: true, fromNew: false })
    } else {
      if (sel) out.push({ ...base, onOld: false, onNew: true, fromOld: false, fromNew: true })
      else if (reverse)
        out.push({ ...base, onOld: true, onNew: true, fromOld: false, fromNew: true })
    }
    prev = out.length > before ? out[out.length - 1] : null
  })

  // The side being rebuilt keeps "no newline" only on its last line, inherited from whichever
  // original side that line came from (a dropped line can't leave it on a line that isn't last).
  const lastOld = out.findLastIndex((p) => p.onOld)
  const lastNew = out.findLastIndex((p) => p.onNew)
  out.forEach((p, i) => {
    if (reverse) {
      p.oldNoNl = i === lastOld && (p.fromOld ? p.oldNoNl : p.newNoNl)
      if (!p.onNew) p.newNoNl = false
    } else {
      p.newNoNl = i === lastNew && (p.fromNew ? p.newNoNl : p.oldNoNl)
      if (!p.onOld) p.oldNoNl = false
    }
  })

  const body: string[] = []
  const emit = (sign: string, p: PatchLine, noNl: boolean): void => {
    body.push(sign + p.text)
    if (noNl) body.push(marker)
  }
  for (const p of out) {
    if (p.onOld && p.onNew && p.oldNoNl === p.newNoNl) emit(' ', p, p.oldNoNl)
    else {
      // A context line whose final newline differs between the sides is a change.
      if (p.onOld) emit('-', p, p.oldNoNl)
      if (p.onNew) emit('+', p, p.newNoNl)
    }
  }

  const oldCount = out.filter((p) => p.onOld).length
  const newCount = out.filter((p) => p.onNew).length
  const m = HUNK_COUNTS_RE.exec(hunk.header)
  if (!m) return null
  const start = (s: string, was: string | undefined, now: number): number => {
    // An empty side is numbered from the line before it ("-0,0" for a new file).
    const n = Number(s)
    const before = was === undefined ? 1 : Number(was)
    if (before === 0 && now > 0) return n + 1
    if (before > 0 && now === 0) return n - 1
    return n
  }
  const header =
    `@@ -${start(m[1], m[2], oldCount)},${oldCount} +${start(m[3], m[4], newCount)},${newCount} @@` +
    m[5]
  return [...fileHeader(diff, reverse, oldCount, newCount), header, ...body].join('\n') + '\n'
}

const HUNK_COUNTS_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/**
 * The file header for a partial patch. Picking some lines of a new file (when unstaging or
 * discarding) or of a deleted file (when staging) is no longer a creation/deletion, so the
 * header turns into a plain modification.
 */
function fileHeader(
  diff: ParsedDiff,
  reverse: boolean,
  oldCount: number,
  newCount: number
): string[] {
  const minus = diff.header.find((l) => l.startsWith('--- '))
  const plus = diff.header.find((l) => l.startsWith('+++ '))
  const swap = (path: string, from: string, to: string): string =>
    path.replace(new RegExp(`^("?)${from}/`), `$1${to}/`)
  const strip = (l: string): string => l.replace(/\r$/, '').slice(4)
  if (reverse && oldCount > 0 && minus && strip(minus) === '/dev/null' && plus) {
    const path = swap(strip(plus), 'b', 'a')
    return diff.header
      .filter((l) => !l.startsWith('new file mode') && !l.startsWith('index '))
      .map((l) => (l === minus ? `--- ${path}` : l))
  }
  if (!reverse && newCount > 0 && plus && strip(plus) === '/dev/null' && minus) {
    const path = swap(strip(minus), 'a', 'b')
    return diff.header
      .filter((l) => !l.startsWith('deleted file mode') && !l.startsWith('index '))
      .map((l) => (l === plus ? `+++ ${path}` : l))
  }
  return diff.header
}

/** [start, end) ranges of `size` items covering `count` items, for drawing long lists in chunks. */
export function chunkRanges(count: number, size: number): [number, number][] {
  const out: [number, number][] = []
  for (let start = 0; start < count; start += size) out.push([start, Math.min(count, start + size)])
  return out
}

/**
 * Rows [first, last) of a list of `count` rows of `rowHeight` px to draw when its scroll box
 * shows `height` px from `top` px below the list's first row, with `overscan` rows each side.
 */
export function visibleRange(
  top: number,
  height: number,
  count: number,
  rowHeight: number,
  overscan: number
): [number, number] {
  const first = Math.min(count, Math.max(0, Math.floor(top / rowHeight) - overscan))
  const last = Math.min(count, Math.max(first, Math.ceil((top + height) / rowHeight) + overscan))
  return [first, last]
}

/** Digits of the largest line number of some hunks, to give their gutters one fixed width. */
export function lineNumberDigits(hunks: Hunk[]): number {
  let max = 0
  for (const h of hunks) for (const l of h.lines) max = Math.max(max, l.oldNo ?? 0, l.newNo ?? 0)
  return String(max).length
}
