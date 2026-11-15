// Syntax highlighting for diffs with highlight.js core and a curated set of languages.
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { stripEol, type Segment } from './conflict'
import type { Hunk } from './diff'

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml
}

let registered = false
/** Registers the languages on first use, not at startup (they reference each other: all at once). */
function register(): void {
  if (registered) return
  registered = true
  for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang)
}

export type Language = keyof typeof LANGUAGES

const BY_EXTENSION: Record<string, Language> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  xaml: 'xml',
  csproj: 'xml',
  vue: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  pyw: 'python',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  php: 'php',
  rb: 'ruby',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  ini: 'ini',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  editorconfig: 'ini',
  gitconfig: 'ini',
  sql: 'sql',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  dockerfile: 'dockerfile'
}

const BY_NAME: Record<string, Language> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini'
}

/** The highlight.js language for a file path, or null when unknown. */
export function languageFor(path: string): Language | null {
  const name = path.split(/[\\/]/).pop()!.toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]
  if (name.startsWith('dockerfile.')) return 'dockerfile'
  const dot = name.lastIndexOf('.')
  return dot === -1 ? null : (BY_EXTENSION[name.slice(dot + 1)] ?? null)
}

const TOKEN_RE = /<span[^>]*>|<\/span>|\n|[^<\n]+/g

/**
 * Splits highlight.js HTML into one string per line, closing the spans still open at each line
 * end and reopening them on the next line, so every line is valid HTML on its own.
 */
export function splitHtmlLines(html: string): string[] {
  const lines: string[] = []
  const open: string[] = []
  let line = ''
  for (const [token] of html.matchAll(TOKEN_RE)) {
    if (token === '\n') {
      lines.push(line + '</span>'.repeat(open.length))
      line = open.join('')
    } else {
      if (token === '</span>') open.pop()
      else if (token.startsWith('<span')) open.push(token)
      line += token
    }
  }
  lines.push(line + '</span>'.repeat(open.length))
  return lines
}

/**
 * Highlighted HTML for each line of a continuous block, or null when it can't be done.
 * `fileStart`: the block starts at the file's first line (a leading U+FEFF is its BOM).
 */
export function highlightLines(
  lines: string[],
  language: Language,
  fileStart = false
): string[] | null {
  if (lines.length === 0) return []
  register()
  try {
    const html = hljs.highlight(lines.join('\n'), { language, ignoreIllegals: true }).value
    const out = splitHtmlLines(html)
    const bom = startsWithBom(lines[0], fileStart)
    return out.length === lines.length ? out.map((h, i) => markHiddenHtml(h, bom && i === 0)) : null
  } catch {
    return null
  }
}

/** Beyond this many lines a diff is shown without highlighting. */
export const MAX_HIGHLIGHT_LINES = 5000

/**
 * Highlighted HTML for each line of `hunk` (same indexes as `hunk.lines`, null for notes).
 * The old side (context + removed) and the new side (context + added) are highlighted as two
 * continuous blocks, so comments and strings spanning several lines come out right.
 */
export function highlightHunk(hunk: Hunk, language: Language): (string | null)[] | null {
  const oldIdx: number[] = []
  const newIdx: number[] = []
  hunk.lines.forEach((l, i) => {
    if (l.kind === 'ctx' || l.kind === 'del') oldIdx.push(i)
    if (l.kind === 'ctx' || l.kind === 'add') newIdx.push(i)
  })
  // A side that starts at line 1 starts at the top of the file (a leading U+FEFF is its BOM).
  const oldHtml = highlightLines(
    oldIdx.map((i) => hunk.lines[i].text),
    language,
    oldIdx.length > 0 && hunk.lines[oldIdx[0]].oldNo === 1
  )
  const newHtml = highlightLines(
    newIdx.map((i) => hunk.lines[i].text),
    language,
    newIdx.length > 0 && hunk.lines[newIdx[0]].newNo === 1
  )
  if (!oldHtml || !newHtml) return null
  const out: (string | null)[] = hunk.lines.map(() => null)
  // Context lines take the new side's rendering (both sides agree in the common case).
  oldIdx.forEach((i, k) => (out[i] = oldHtml[k]))
  newIdx.forEach((i, k) => (out[i] = newHtml[k]))
  return out
}

// ---------- hidden characters ----------
// Bidi controls reorder how a line is displayed (Trojan Source, CVE-2021-42574), and zero-width
// or control characters hide text: code views show each one as a visible marker instead.

const HIDDEN_NAMES: Record<number, string> = {
  0x061c: 'ARABIC LETTER MARK',
  0x200b: 'ZERO WIDTH SPACE',
  0x200e: 'LEFT-TO-RIGHT MARK',
  0x200f: 'RIGHT-TO-LEFT MARK',
  0x2028: 'LINE SEPARATOR',
  0x2029: 'PARAGRAPH SEPARATOR',
  0x202a: 'LEFT-TO-RIGHT EMBEDDING',
  0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING',
  0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2060: 'WORD JOINER',
  0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE'
}

/** Bidi controls, zero-width characters and control characters other than tab and newline. */
const HIDDEN_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g

/** The same set, without the global flag: test() keeps no position between calls. */
const HIDDEN_ONE = new RegExp(HIDDEN_RE.source)

/** True when `text` holds a character that code views mark (see HIDDEN_RE). */
export function hasHiddenChars(text: string): boolean {
  return HIDDEN_ONE.test(text)
}

const BOM = '\ufeff'

/**
 * A U+FEFF at the very start of a file is its UTF-8 byte order mark (Visual Studio,
 * PowerShell and many Windows editors write one; git passes it through as the start of line
 * 1). It neither reorders nor hides code: it is shown as a quiet "BOM" marker and does not
 * raise the hidden-characters banner. `fileStart`: `text` is the file's first line.
 */
export function startsWithBom(text: string, fileStart: boolean): boolean {
  return fileStart && text.startsWith(BOM)
}

/** hasHiddenChars, leaving out the file's byte order mark when `text` is its first line. */
export function hasHiddenCharsAt(text: string, fileStart: boolean): boolean {
  return hasHiddenChars(startsWithBom(text, fileStart) ? text.slice(1) : text)
}

const FSI = '\u2068'
const PDI = '\u2069'

/**
 * A name for a plain-text title, toast or menu item, wrapped in FSI…PDI so its bidi order
 * stays inside (UiText draws the run as a <bdi>). The name's own hidden characters are
 * written out ("[U+202E]"): an override, or a PDI of its own, can then neither act nor end
 * the isolate early.
 */
export function isolateText(text: string): string {
  return `${FSI}${text.replace(HIDDEN_RE, (ch) => `[${hiddenCharInfo(ch).code}]`)}${PDI}`
}

/**
 * A UI string cut for drawing (UiText): the runs isolateText wrapped, plain text, and every
 * other hidden character on its own (drawn as a marker, so it cannot act).
 */
export function splitUiText(
  text: string
): (string | { isolated: string } | { hidden: string; bom?: boolean })[] {
  const out: (string | { isolated: string } | { hidden: string; bom?: boolean })[] = []
  let plain = ''
  const flush = (): void => {
    if (plain) out.push(...splitHidden(plain))
    plain = ''
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] === FSI) {
      const end = text.indexOf(PDI, i + 1)
      const inner = end < 0 ? null : text.slice(i + 1, end)
      if (inner !== null && !hasHiddenChars(inner)) {
        flush()
        out.push({ isolated: inner })
        i = end
        continue
      }
    }
    plain += text[i]
  }
  flush()
  return out
}

/** True when a diff shows a hidden character: in its lines or in a header's function context. */
export function hunksHaveHiddenChars(hunks: Hunk[]): boolean {
  return hunks.some(
    (h) =>
      hasHiddenChars(h.header) ||
      h.lines.some((l) => hasHiddenCharsAt(l.text, l.oldNo === 1 || l.newNo === 1))
  )
}

/**
 * True when a conflicted file shows a hidden character. Lines are checked as drawn, without
 * their line ending: a CRLF file (core.autocrlf on Windows) is not flagged for its '\r'.
 */
export function conflictHasHiddenChars(segments: Segment[]): boolean {
  // The first segment's first line (each side's, for a conflict at the top) starts the file.
  const shown = (lines: string[] | null, fileStart: boolean): boolean =>
    !!lines?.some((l, i) => hasHiddenCharsAt(stripEol(l), fileStart && i === 0))
  return segments.some((s, i) =>
    s.kind === 'text'
      ? shown(s.lines, i === 0)
      : shown(s.current, i === 0) ||
        shown(s.base, i === 0) ||
        shown(s.incoming, i === 0) ||
        hasHiddenChars(s.currentLabel + s.baseLabel + s.incomingLabel)
  )
}

/** "U+202E" and the character's name, for a marker and its tooltip. */
export function hiddenCharInfo(ch: string): { code: string; name: string } {
  const n = ch.charCodeAt(0)
  return {
    code: `U+${n.toString(16).toUpperCase().padStart(4, '0')}`,
    name: HIDDEN_NAMES[n] ?? 'CONTROL CHARACTER'
  }
}

/** The quiet marker of a file's byte order mark (see startsWithBom). */
export const BOM_TITLE = 'U+FEFF BYTE ORDER MARK (the file starts with it)'

/**
 * Plain text cut around its hidden characters: strings, and { hidden } for each marker.
 * `bom`: the text starts the file, and its leading U+FEFF comes out as { hidden, bom: true }.
 */
export function splitHidden(
  text: string,
  bom = false
): (string | { hidden: string; bom?: boolean })[] {
  const out: (string | { hidden: string; bom?: boolean })[] = []
  let last = 0
  const leading = startsWithBom(text, bom)
  for (const m of text.matchAll(HIDDEN_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(leading && m.index === 0 ? { hidden: m[0], bom: true } : { hidden: m[0] })
    last = m.index + 1
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * Replaces the hidden characters of highlight.js HTML with escaped markers. Its markup is
 * plain ASCII tags, so these characters can only be in the (escaped) text.
 */
export function markHiddenHtml(html: string, bom = false): string {
  // With `bom`, the line's text starts with the file's BOM: the first marked character is it.
  let first = bom
  return html.replace(HIDDEN_RE, (ch) => {
    const quiet = first && ch === BOM
    first = false
    if (quiet) return `<span class="hidden-char bom" title="${BOM_TITLE}">BOM</span>`
    const { code, name } = hiddenCharInfo(ch)
    return `<span class="hidden-char" title="${code} ${name}">${code}</span>`
  })
}

/** The same text for an attribute (aria-label): isolates dropped, other characters named. */
export function uiLabel(text: string): string {
  return splitUiText(text)
    .map((part) =>
      typeof part === 'string'
        ? part
        : 'isolated' in part
          ? part.isolated
          : `[${hiddenCharInfo(part.hidden).code}]`
    )
    .join('')
}
