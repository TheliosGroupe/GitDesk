import { describe, expect, it } from 'vitest'
import { parseConflicts } from '../../src/renderer/src/lib/conflict'
import { parseDiff } from '../../src/renderer/src/lib/diff'
import {
  conflictHasHiddenChars,
  hasHiddenChars,
  hasHiddenCharsAt,
  hiddenCharInfo,
  highlightHunk,
  highlightLines,
  hunksHaveHiddenChars,
  isolateText,
  markHiddenHtml,
  splitHidden,
  splitUiText,
  uiLabel
} from '../../src/renderer/src/lib/highlight'

// Written as escapes: the characters themselves would be invisible in this file too.
const RLO = '\u202e'
const LRI = '\u2066'
const PDI = '\u2069'
const ZWSP = '\u200b'
const BOM = '\ufeff'

/** No character left that the code views are meant to mark. */
const clean = (s: string): boolean => !hasHiddenChars(s)

describe('hidden characters in code views', () => {
  it('detects bidi controls, zero-width and control characters', () => {
    for (const ch of [
      RLO,
      LRI,
      PDI,
      ZWSP,
      '\u200e',
      '\u200f',
      '\u061c',
      '\ufeff',
      '\u0000',
      '\u0007',
      '\u007f',
      '\u2028'
    ])
      expect(hasHiddenChars(`a${ch}b`), ch.charCodeAt(0).toString(16)).toBe(true)
    // Tabs, plain text, right-to-left letters and emoji joiners are ordinary text.
    for (const text of ['\tx = 1', 'const a = "b"', 'שלום', 'مرحبا', '👨\u200d👩\u200d👧', ''])
      expect(hasHiddenChars(text)).toBe(false)
    // The global regex keeps no state between calls.
    expect(hasHiddenChars(`x${RLO}`)).toBe(true)
    expect(hasHiddenChars(`x${RLO}`)).toBe(true)
  })

  it('names each character', () => {
    expect(hiddenCharInfo(RLO)).toEqual({ code: 'U+202E', name: 'RIGHT-TO-LEFT OVERRIDE' })
    expect(hiddenCharInfo(LRI)).toEqual({ code: 'U+2066', name: 'LEFT-TO-RIGHT ISOLATE' })
    expect(hiddenCharInfo('\u0007')).toEqual({ code: 'U+0007', name: 'CONTROL CHARACTER' })
  })

  it('cuts plain text around the characters', () => {
    expect(splitHidden(`a${RLO}b${LRI}${PDI}`)).toEqual([
      'a',
      { hidden: RLO },
      'b',
      { hidden: LRI },
      { hidden: PDI }
    ])
    expect(splitHidden('plain')).toEqual(['plain'])
    expect(splitHidden('')).toEqual([])
  })

  it('replaces them in highlighted HTML with escaped markers', () => {
    const html = markHiddenHtml(`<span class="hljs-string">"a${RLO}b"</span>`)
    expect(clean(html)).toBe(true)
    expect(html).toBe(
      '<span class="hljs-string">"a<span class="hidden-char" title="U+202E RIGHT-TO-LEFT OVERRIDE">U+202E</span>b"</span>'
    )
  })

  it('marks them in highlighted lines and diff hunks (diff, conflict and line history views)', () => {
    const lines = [`const access = "user${RLO} ${LRI}// admin${PDI} ${ZWSP}"`, 'if (x < 1) {}']
    const html = highlightLines(lines, 'javascript')!
    expect(html).toHaveLength(2)
    expect(html.every(clean)).toBe(true)
    expect(html[0]).toContain('title="U+202E RIGHT-TO-LEFT OVERRIDE">U+202E</span>')
    expect(html[0]).toContain('U+2066')
    expect(html[0]).toContain('U+2069')
    expect(html[0]).toContain('U+200B')
    // Still escaped by highlight.js.
    expect(html[1]).toContain('&lt;')

    const diff = parseDiff(
      [
        'diff --git a/a.js b/a.js',
        '--- a/a.js',
        '+++ b/a.js',
        '@@ -1,1 +1,1 @@',
        `-const ok = true`,
        `+const ok = "${RLO}eurt"`
      ].join('\n')
    )
    const hunk = highlightHunk(diff.hunks[0], 'javascript')!
    expect(hunk.every((h) => h === null || clean(h))).toBe(true)
    expect(hunk[1]).toContain('U+202E')
  })

  it('flags a conflicted file by its drawn lines: CRLF endings are not hidden characters', () => {
    const crlf = 'a\r\n<<<<<<< HEAD\r\nb\r\n=======\r\nc\r\n>>>>>>> other\r\nd\r\n'
    expect(conflictHasHiddenChars(parseConflicts(crlf))).toBe(false)
    expect(conflictHasHiddenChars(parseConflicts(crlf.replace(/\r\n/g, '\n')))).toBe(false)
    // Wherever it is: context, either side, the common ancestor or a marker's label.
    for (const spoofed of [
      crlf.replace('a\r\n', `a${RLO}\r\n`),
      crlf.replace('b\r\n', `b${RLO}\r\n`),
      crlf.replace('c\r\n', `c${ZWSP}\r\n`),
      crlf.replace('other', `oth${RLO}er`),
      `x\n<<<<<<< HEAD\nb\n||||||| base\ny${LRI}\n=======\nc\n>>>>>>> o\n`
    ])
      expect(conflictHasHiddenChars(parseConflicts(spoofed))).toBe(true)
    // A lone carriage return inside a line is drawn as a marker, so it is flagged.
    expect(conflictHasHiddenChars(parseConflicts('a\rb\n'))).toBe(true)
  })

  it('flags a diff whose hunk header context holds a hidden character', () => {
    const diff = (header: string): string =>
      ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', header, ' ctx', '-a', '+b'].join(
        '\n'
      )
    const plain = parseDiff(diff('@@ -10,3 +10,3 @@ function ok()')).hunks
    expect(hunksHaveHiddenChars(plain)).toBe(false)
    const spoofed = parseDiff(diff(`@@ -10,3 +10,3 @@ function ok${RLO}()`)).hunks
    expect(spoofed[0].lines.some((l) => hasHiddenChars(l.text))).toBe(false)
    expect(hunksHaveHiddenChars(spoofed)).toBe(true)
    expect(splitHidden(spoofed[0].header)).toContainEqual({ hidden: RLO })
  })

  it("does not flag a file's leading byte order mark, only a U+FEFF elsewhere", () => {
    const diff = (from: number, lines: string[]): string =>
      [
        'diff --git a/a.cs b/a.cs',
        '--- a/a.cs',
        '+++ b/a.cs',
        `@@ -${from},2 +${from},2 @@`,
        ...lines
      ].join('\n')
    // A UTF-8-with-BOM file changed near its top: line 1 starts with the BOM.
    const top = parseDiff(diff(1, [` ${BOM}using System;`, '-a', '+b'])).hunks
    expect(hunksHaveHiddenChars(top)).toBe(false)
    expect(highlightHunk(top[0], 'csharp')![0]).toContain('class="hidden-char bom"')
    expect(splitHidden(top[0].lines[0].text, true)[0]).toEqual({ hidden: BOM, bom: true })
    // The same character anywhere else is still a hidden character.
    const later = parseDiff(diff(5, [` ${BOM}using System;`, '-a', '+b'])).hunks
    expect(hunksHaveHiddenChars(later)).toBe(true)
    expect(highlightHunk(later[0], 'csharp')![0]).toContain('U+FEFF')
    expect(hasHiddenCharsAt(`a${BOM}b`, true)).toBe(true)
    expect(hasHiddenCharsAt(`${BOM}${BOM}`, true)).toBe(true)
    expect(hasHiddenCharsAt(`${BOM}x`, true)).toBe(false)
    expect(hasHiddenCharsAt(`${BOM}x${RLO}`, true)).toBe(true)
    // Conflicts: the file's first line only (each side's, for a conflict at the top).
    const conflict = (text: string): boolean => conflictHasHiddenChars(parseConflicts(text))
    expect(conflict(`${BOM}a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> o\n`)).toBe(false)
    expect(conflict(`<<<<<<< HEAD\n${BOM}b\n=======\n${BOM}c\n>>>>>>> o\n`)).toBe(false)
    expect(conflict(`a\n<<<<<<< HEAD\n${BOM}b\n=======\nc\n>>>>>>> o\n`)).toBe(true)
  })

  it('isolates a name inside a plain-text title', () => {
    expect(isolateText('main')).toBe('\u2068main\u2069')
    // A name's own controls are written out: they can neither act nor close the isolate.
    expect(isolateText(`a${PDI}${RLO}b`)).toBe('\u2068a[U+2069][U+202E]b\u2069')
  })

  it('draws UI strings with isolated names and every other control as a marker', () => {
    const title = `Delete ${isolateText('feature/x')}?`
    expect(splitUiText(title)).toEqual(['Delete ', { isolated: 'feature/x' }, '?'])
    expect(uiLabel(title)).toBe('Delete feature/x?')
    // Not wrapped (an error message, a name from elsewhere): the override is a marker.
    expect(splitUiText(`Switched to ${RLO}main`)).toEqual(['Switched to ', { hidden: RLO }, 'main'])
    expect(uiLabel(`x${LRI}y`)).toBe('x[U+2066]y')
    // An unmatched isolate opener is not an isolate either.
    expect(splitUiText(`a\u2068b`)).toEqual(['a', { hidden: '\u2068' }, 'b'])
    expect(splitUiText('plain')).toEqual(['plain'])
  })
})
