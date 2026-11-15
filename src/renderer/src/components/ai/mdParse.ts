// A small Markdown parser for model answers: headings, paragraphs, lists (nested by indent),
// block quotes, fenced code, rules; inline code, bold, italic and links (kept as text).
// It produces a tree that Markdown.tsx renders as React elements: no HTML is ever injected.
// Model output is untrusted: parsing is linear in the input and nesting (quotes, lists,
// inline markup) is capped at MAX_DEPTH, deeper markers stay plain text.

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; children: Inline[]; href: string }

export interface ListItem {
  children: Inline[]
  /** Nested list under this item, if any. */
  sub: ListBlock | null
}

export interface ListBlock {
  type: 'list'
  ordered: boolean
  start: number
  items: ListItem[]
}

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | ListBlock
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'hr' }

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/

/** Nesting depth kept for quotes, lists and inline markup. */
export const MAX_DEPTH = 8

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  return parseBlocks(lines, 0)
}

/** "## Title ##" → "Title" (a closing run of '#' only after a space, as in CommonMark). */
function headingText(rest: string): string {
  const t = rest.trimEnd()
  let end = t.length
  while (end > 0 && t[end - 1] === '#') end--
  return (end === 0 || /\s/.test(t[end - 1]) ? t.slice(0, end) : t).trim()
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = []
  let i = 0
  let para: string[] = []
  const flush = (): void => {
    if (para.length) blocks.push({ type: 'paragraph', children: parseInline(para.join(' ')) })
    para = []
  }
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line)
    if (fence) {
      flush()
      const marker = fence[1]
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++])
      i++ // closing fence (or end)
      blocks.push({ type: 'code', lang: fence[2], text: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      flush()
      i++
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(headingText(heading[2]))
      })
      i++
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      blocks.push({ type: 'hr' })
      i++
      continue
    }
    // Past MAX_DEPTH, quote markers are kept as paragraph text.
    if (depth < MAX_DEPTH && /^\s{0,3}>/.test(line)) {
      flush()
      const quoted: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]))
        quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ''))
      blocks.push({ type: 'quote', children: parseBlocks(quoted, depth + 1) })
      continue
    }
    if (LIST_RE.test(line)) {
      flush()
      const start = i
      const baseIndent = indentOf(line)
      const ordered = /\d/.test(LIST_RE.exec(line)![2])
      const sameList = (l: string): boolean => {
        const m = LIST_RE.exec(l)
        if (!m) return /^\s+\S/.test(l)
        // A list of the other kind at the same level starts a new list.
        return indentOf(l) > baseIndent || /\d/.test(m[2]) === ordered
      }
      i++
      while (i < lines.length && lines[i].trim() && sameList(lines[i])) i++
      blocks.push(parseList(lines.slice(start, i), depth))
      continue
    }
    para.push(line.trim())
    i++
  }
  flush()
  return blocks
}

function indentOf(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length
}

function parseList(lines: string[], depth: number): ListBlock {
  const first = LIST_RE.exec(lines[0])!
  const base = indentOf(lines[0])
  const ordered = /\d/.test(first[2])
  const list: ListBlock = {
    type: 'list',
    ordered,
    start: ordered ? parseInt(first[2], 10) : 1,
    items: []
  }
  let i = 0
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i])
    if (!m || indentOf(lines[i]) > base) {
      // Continuation text of the previous item.
      const last = list.items[list.items.length - 1]
      if (last) last.children.push({ type: 'text', text: ' ' }, ...parseInline(lines[i].trim()))
      i++
      continue
    }
    const text = [m[3]]
    i++
    const nested: string[] = []
    // Past MAX_DEPTH, deeper items are kept as text of this one.
    const nestOk = depth + 1 < MAX_DEPTH
    while (i < lines.length && indentOf(lines[i]) > base) {
      if (nestOk && (LIST_RE.test(lines[i]) || nested.length)) nested.push(lines[i])
      else text.push(lines[i].trim())
      i++
    }
    list.items.push({
      children: parseInline(text.join(' ')),
      sub: nested.length ? parseList(nested, depth + 1) : null
    })
  }
  return list
}

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c)

/**
 * The first position >= `from` where `delim` starts and `valid` holds, or -1. Queries come
 * with growing `from`, and the last answer is reused while it is still ahead: each kind of
 * delimiter scans the text once, so an opener without a closer does not cost a rescan.
 */
function closerFinder(
  text: string,
  delim: string,
  valid: (at: number) => boolean
): (from: number) => number {
  let askedFrom = -1
  let answer = -1
  return (from) => {
    if (askedFrom !== -1 && from >= askedFrom && (answer === -1 || answer >= from)) return answer
    let at = text.indexOf(delim, from)
    while (at !== -1 && !valid(at)) at = text.indexOf(delim, at + 1)
    askedFrom = from
    answer = at
    return answer
  }
}

/** The first position >= `from` whose character matches, or text.length; reused like closerFinder. */
function scanFinder(text: string, stop: (ch: string) => boolean): (from: number) => number {
  let askedFrom = -1
  let answer = -1
  return (from) => {
    if (askedFrom !== -1 && from >= askedFrom && answer >= from) return answer
    let k = from
    while (k < text.length && !stop(text[k])) k++
    askedFrom = from
    answer = k
    return answer
  }
}

/** Longest backtick run that can open a code span (longer runs are plain text). */
const MAX_TICKS = 16

/** Inline markup of one paragraph (or heading, list item). Linear in the text. */
export function parseInline(text: string, depth = 0): Inline[] {
  if (depth >= MAX_DEPTH) return text ? [{ type: 'text', text }] : []
  const out: Inline[] = []
  let plain = ''
  const pushText = (): void => {
    if (plain) out.push({ type: 'text', text: plain })
    plain = ''
  }
  // Closers: "**x**" and "__x__" end after a non-space; "*x*" and "_x_" too, and are not
  // followed by a word character or '*'.
  const strong = {
    '*': closerFinder(text, '**', (j) => !isSpace(text[j - 1])),
    _: closerFinder(text, '__', (j) => !isSpace(text[j - 1]))
  }
  const emValid = (j: number): boolean => !isSpace(text[j - 1]) && !/[\w*]/.test(text[j + 1] ?? '')
  const em = { '*': closerFinder(text, '*', emValid), _: closerFinder(text, '_', emValid) }
  const bracket = closerFinder(text, ']', () => true)
  const ticks = new Map<number, (from: number) => number>()
  /** Start of the next run of exactly n backticks at or after `from`, or -1. */
  const tickRun = (n: number): ((from: number) => number) => {
    let f = ticks.get(n)
    if (!f) {
      const run = '`'.repeat(n)
      f = closerFinder(text, run, (j) => text[j - 1] !== '`' && text[j + n] !== '`')
      ticks.set(n, f)
    }
    return f
  }
  // '(href)' or '(href "title")' after the "]" at j. Every scan is shared or cached, so many
  // "[" without a link stay linear.
  const hrefEnd = scanFinder(text, (ch) => ch === ')' || isSpace(ch))
  const quote = closerFinder(text, '"', () => true)
  const titleEnds = new Map<number, number>()
  const titleEnd = (k: number): number => {
    let end = titleEnds.get(k)
    if (end === undefined) {
      end = -1
      let m = k
      while (m < text.length && isSpace(text[m])) m++
      if (text[m] === '"') {
        const q = quote(m + 1)
        if (q !== -1 && text[q + 1] === ')') end = q + 2
      }
      titleEnds.set(k, end)
    }
    return end
  }
  const linkTails = new Map<number, { end: number; href: string }>()
  const linkTail = (j: number): { end: number; href: string } => {
    let r = linkTails.get(j)
    if (!r) {
      r = { end: -1, href: '' }
      if (text[j + 1] === '(') {
        const k = hrefEnd(j + 2)
        const end = text[k] === ')' ? k + 1 : k < text.length ? titleEnd(k) : -1
        if (end !== -1) r = { end, href: text.slice(j + 2, k) }
      }
      linkTails.set(j, r)
    }
    return r
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '`') {
      let n = 1
      while (text[i + n] === '`') n++
      const close = n <= MAX_TICKS ? tickRun(n)(i + n) : -1
      if (close !== -1) {
        pushText()
        out.push({ type: 'code', text: text.slice(i + n, close).replace(/^ (.*) $/, '$1') })
        i = close + n
      } else {
        plain += text.slice(i, i + n)
        i += n
      }
      continue
    }
    if ((c === '*' || c === '_') && text[i + 1] === c && !isSpace(text[i + 2])) {
      const close = strong[c](i + 3)
      if (close !== -1) {
        pushText()
        out.push({ type: 'strong', children: parseInline(text.slice(i + 2, close), depth + 1) })
        i = close + 2
        continue
      }
    }
    if (
      (c === '*' || (c === '_' && !/\w/.test(i > 0 ? text[i - 1] : ' '))) &&
      !isSpace(text[i + 1])
    ) {
      const close = em[c](i + 2)
      if (close !== -1) {
        pushText()
        out.push({ type: 'em', children: parseInline(text.slice(i + 1, close), depth + 1) })
        i = close + 1
        continue
      }
    }
    if (c === '[') {
      const j = bracket(i + 1)
      if (j > i + 1) {
        const tail = linkTail(j)
        if (tail.end !== -1) {
          pushText()
          out.push({
            type: 'link',
            children: parseInline(text.slice(i + 1, j), depth + 1),
            href: tail.href
          })
          i = tail.end
          continue
        }
      }
    }
    if (c === '\\' && i + 1 < text.length && /[\\`*_[\]()#+\-.!]/.test(text[i + 1])) {
      plain += text[i + 1]
      i += 2
      continue
    }
    plain += c
    i++
  }
  pushText()
  return out
}
