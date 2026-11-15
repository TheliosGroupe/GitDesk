// Parser for a file with git conflict markers, and the merge of the chosen sides.

export interface TextSegment {
  kind: 'text'
  /** Lines with their line endings, so the file can be rebuilt byte for byte. */
  lines: string[]
}

export interface ConflictBlock {
  kind: 'conflict'
  /** Position among the file's conflicts (0-based). */
  index: number
  current: string[]
  /** Common ancestor's lines, with merge.conflictStyle diff3 / zdiff3 only. */
  base: string[] | null
  incoming: string[]
  /** Labels after the markers ("HEAD", a branch, a commit…), '' when absent. */
  currentLabel: string
  baseLabel: string
  incomingLabel: string
  /** The block as written, markers included (kept when it is left unresolved). */
  raw: string[]
}

export type Segment = TextSegment | ConflictBlock

/** 'ai': the block's AI suggestion (its text is passed separately, see mergeConflicts). */
export type Choice = 'current' | 'incoming' | 'both' | 'ai'

/** Splits text into lines that keep their '\n' (and '\r\n'). */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** A line without its line ending. */
export function stripEol(line: string): string {
  return line.replace(/\r?\n$/, '')
}

/** The label after a 7-character marker, or null when the line isn't that marker. */
function marker(line: string, char: string): string | null {
  const text = stripEol(line)
  const m = new RegExp(`^\\${char}{7}(?:[ \\t](.*))?$`).exec(text)
  return m ? (m[1] ?? '').trim() : null
}

export function parseConflicts(content: string): Segment[] {
  const segments: Segment[] = []
  let text: string[] = []
  let block: ConflictBlock | null = null
  let part: 'current' | 'base' | 'incoming' = 'current'
  let count = 0

  const flushText = (): void => {
    if (text.length) segments.push({ kind: 'text', lines: text })
    text = []
  }

  for (const line of splitLines(content)) {
    if (!block) {
      const label = marker(line, '<')
      if (label === null) {
        text.push(line)
        continue
      }
      flushText()
      block = {
        kind: 'conflict',
        index: count,
        current: [],
        base: null,
        incoming: [],
        currentLabel: label,
        baseLabel: '',
        incomingLabel: '',
        raw: [line]
      }
      part = 'current'
      continue
    }
    block.raw.push(line)
    const base = part === 'current' ? marker(line, '|') : null
    if (base !== null) {
      block.base = []
      block.baseLabel = base
      part = 'base'
    } else if (part !== 'incoming' && marker(line, '=') !== null) {
      part = 'incoming'
    } else if (part === 'incoming' && marker(line, '>') !== null) {
      block.incomingLabel = marker(line, '>') ?? ''
      segments.push(block)
      count++
      block = null
    } else if (part === 'base') block.base!.push(line)
    else block[part].push(line)
  }
  // An unterminated block isn't a conflict: keep it as plain text.
  if (block) text.push(...block.raw)
  flushText()
  return segments
}

/** The lines a choice keeps for one block ('ai' takes `custom`, the suggestion's lines). */
export function resolveBlock(
  block: ConflictBlock,
  choice: Choice | undefined,
  custom?: string[]
): string[] {
  if (choice === 'current') return block.current
  if (choice === 'incoming') return block.incoming
  if (choice === 'both') return [...block.current, ...block.incoming]
  if (choice === 'ai' && custom) return custom
  return block.raw
}

/**
 * The file content with each block replaced by its choice (unchosen blocks keep their
 * markers). `custom[index]` holds the lines of an 'ai' choice.
 */
export function mergeConflicts(
  segments: Segment[],
  choices: ReadonlyArray<Choice | undefined>,
  custom: ReadonlyArray<string[] | undefined> = []
): string {
  return segments
    .map((s) =>
      (s.kind === 'text' ? s.lines : resolveBlock(s, choices[s.index], custom[s.index])).join('')
    )
    .join('')
}

export function conflictCount(segments: Segment[]): number {
  return segments.filter((s) => s.kind === 'conflict').length
}

/** The line ending a block uses ('\r\n' when its first marker line does). */
export function blockEol(block: ConflictBlock): string {
  return block.raw[0]?.endsWith('\r\n') ? '\r\n' : '\n'
}

/**
 * Lines for a block from free text (an AI suggestion or an edit), with the block's line
 * ending. The last line has none only when the block ended the file without one.
 * '' gives no lines (the block is removed).
 */
export function textToBlockLines(text: string, block: ConflictBlock): string[] {
  if (text === '') return []
  const eol = blockEol(block)
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const lastRaw = block.raw[block.raw.length - 1] ?? ''
  const endsWithEol = lastRaw.endsWith('\n')
  return lines.map((l, i) => (i < lines.length - 1 || endsWithEol ? l + eol : l))
}

/** The text of block lines, for editing (line endings normalized to '\n', no final one). */
export function blockLinesToText(lines: string[]): string {
  return lines.join('').replace(/\r\n/g, '\n').replace(/\n$/, '')
}

export type LineOrigin = 'current' | 'incoming' | 'both' | 'base' | 'new' | 'blank'

export interface Provenance {
  /** Each line of the resolution and where it comes from ('new': on neither side, nor base). */
  lines: { text: string; origin: LineOrigin }[]
  /** Non-blank lines found on neither side (nor the common ancestor). */
  added: number
  /** Lines of each side that the resolution does not keep (counted with repeats). */
  dropped: { current: number; incoming: number }
  /** Line count of each side. */
  total: { current: number; incoming: number }
}

function countLines(lines: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
  return m
}

function missing(side: Map<string, number>, kept: Map<string, number>): number {
  let n = 0
  for (const [line, count] of side) n += Math.max(0, count - (kept.get(line) ?? 0))
  return n
}

/**
 * Where the lines of a proposed resolution come from, compared line by line (exactly) with
 * the block's sides: what it adds that neither side has, and what it drops from each side.
 * Linear in the size of the block. For showing a model's suggestion, never for trusting it.
 */
export function classifyResolution(text: string, block: ConflictBlock): Provenance {
  const current = block.current.map(stripEol)
  const incoming = block.incoming.map(stripEol)
  const cur = countLines(current)
  const inc = countLines(incoming)
  const base = new Set((block.base ?? []).map(stripEol))
  const res = text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  let added = 0
  const lines = res.map((line) => {
    const inCur = cur.has(line)
    const inInc = inc.has(line)
    let origin: LineOrigin
    if (inCur && inInc) origin = 'both'
    else if (inCur) origin = 'current'
    else if (inInc) origin = 'incoming'
    else if (!line.trim()) origin = 'blank'
    else if (base.has(line)) origin = 'base'
    else origin = 'new'
    if (origin === 'new') added++
    return { text: line, origin }
  })
  const kept = countLines(res)
  return {
    lines,
    added,
    dropped: { current: missing(cur, kept), incoming: missing(inc, kept) },
    total: { current: current.length, incoming: incoming.length }
  }
}

/** True when the text still contains a conflict marker line. */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7}|\|{7})(\s|$)/m.test(text)
}
