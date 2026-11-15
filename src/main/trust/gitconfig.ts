// Reads git config files the way git does, without running git: GitDesk inspects a
// repository's own settings before it lets git near them (see inspect.ts).

/** One `key = value` line. Keys are canonical like git prints them: section and name in
 * lowercase, subsection as written. `value` is null for a bare key (boolean true). */
export interface ConfigEntry {
  key: string
  value: string | null
  /** The file it came from. */
  file: string
}

export interface ParsedConfig {
  entries: Omit<ConfigEntry, 'file'>[]
  /** git refuses to run with a malformed file; the entries before the error are kept. */
  error: string | null
}

// git's own isspace() (not C's): no vertical tab or form feed.
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\r'
const isAlpha = (c: string): boolean => /^[A-Za-z]$/.test(c)
const isKeyChar = (c: string): boolean => /^[A-Za-z0-9-]$/.test(c)

/** Parses the text of a git config file (git's config.c rules: quotes, escapes, comments, continuations). */
export function parseGitConfig(text: string): ParsedConfig {
  // git skips a UTF-8 BOM and reads CRLF as LF.
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  let i = 0
  const EOF = ''
  const next = (): string => (i < src.length ? src[i++] : EOF)
  const entries: ParsedConfig['entries'] = []
  let section = ''
  let comment = false

  const fail = (what: string): ParsedConfig => ({ entries, error: what })

  for (;;) {
    const c = next()
    if (c === EOF) return { entries, error: null }
    if (c === '\n') {
      comment = false
      continue
    }
    if (comment || isSpace(c)) continue
    if (c === '#' || c === ';') {
      comment = true
      continue
    }
    if (c === '[') {
      // [section] or [section "subsection"]; the deprecated [section.sub] is all lowercase.
      let name = ''
      for (;;) {
        const h = next()
        if (h === EOF || h === '\n') return fail('bad section header')
        if (h === ']') break
        if (isSpace(h)) {
          let q = next()
          while (isSpace(q)) q = next()
          if (q !== '"') return fail('bad section header')
          let sub = ''
          for (;;) {
            let s = next()
            if (s === EOF || s === '\n') return fail('bad section header')
            if (s === '"') break
            if (s === '\\') {
              s = next()
              if (s === EOF || s === '\n') return fail('bad section header')
            }
            sub += s
          }
          if (next() !== ']') return fail('bad section header')
          name += '.' + sub
          break
        }
        if (!isKeyChar(h) && h !== '.') return fail('bad section header')
        name += h.toLowerCase()
      }
      section = name
      continue
    }
    if (!isAlpha(c)) return fail('bad config line')
    let key = c.toLowerCase()
    let v = next()
    while (isKeyChar(v)) {
      key += v.toLowerCase()
      v = next()
    }
    while (isSpace(v)) v = next()
    if (!section) return fail('key outside a section')
    if (v === '\n' || v === EOF) {
      entries.push({ key: `${section}.${key}`, value: null })
      continue
    }
    if (v !== '=') return fail('bad config line')
    // The value: whitespace outside quotes collapses to spaces between words, quotes toggle,
    // "\" escapes \n \t \b \\ \" and continues a line.
    let value = ''
    let quote = false
    let inComment = false
    let spaces = 0
    for (;;) {
      let ch = next()
      if (ch === EOF || ch === '\n') {
        if (quote) return fail('unterminated quote')
        break
      }
      if (inComment) continue
      if (isSpace(ch) && !quote) {
        if (value) spaces++
        continue
      }
      if (!quote && (ch === ';' || ch === '#')) {
        inComment = true
        continue
      }
      value += ' '.repeat(spaces)
      spaces = 0
      if (ch === '\\') {
        ch = next()
        if (ch === '\n') continue
        const escaped: Record<string, string> = { t: '\t', b: '\b', n: '\n', '\\': '\\', '"': '"' }
        if (!(ch in escaped)) return fail('bad escape')
        value += escaped[ch]
        continue
      }
      if (ch === '"') {
        quote = !quote
        continue
      }
      value += ch
    }
    entries.push({ key: `${section}.${key}`, value })
  }
}

/** Section, subsection (null when none) and name of a canonical key. */
export function splitKey(key: string): { section: string; sub: string | null; name: string } {
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  if (first < 0) return { section: key, sub: null, name: '' }
  return {
    section: key.slice(0, first),
    sub: first === last ? null : key.slice(first + 1, last),
    name: key.slice(last + 1)
  }
}

/**
 * Parses `git config --list --show-scope -z` output: "scope NUL key LF value NUL", or
 * "scope NUL key NUL" for a bare key.
 */
export function parseConfigList(
  out: string
): { scope: string; key: string; value: string | null }[] {
  const parts = out.split('\0')
  const list: { scope: string; key: string; value: string | null }[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]
    const kv = parts[i + 1]
    const nl = kv.indexOf('\n')
    list.push(
      nl < 0
        ? { scope, key: kv, value: null }
        : { scope, key: kv.slice(0, nl), value: kv.slice(nl + 1) }
    )
  }
  return list
}
