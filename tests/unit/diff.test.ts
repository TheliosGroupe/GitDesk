import { describe, expect, it } from 'vitest'
import { hunkPatch, parseDiff, toSplitRows, type Hunk } from '../../src/renderer/src/lib/diff'

const lines = (...l: string[]): string => l.join('\n') + '\n'

const MODIFIED = lines(
  'diff --git a/f.txt b/f.txt',
  'index 1111111..2222222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,4 +1,4 @@ function x',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -10,3 +10,4 @@',
  ' ten',
  '+ten and a half',
  ' eleven',
  '\\ No newline at end of file'
)

describe('parseDiff', () => {
  it('parses a modified file with several hunks and line numbers', () => {
    const d = parseDiff(MODIFIED)
    expect(d.header).toEqual([
      'diff --git a/f.txt b/f.txt',
      'index 1111111..2222222 100644',
      '--- a/f.txt',
      '+++ b/f.txt'
    ])
    expect(d.binary).toBe(false)
    expect(d.combined).toBe(false)
    expect(d.hunks).toHaveLength(2)

    const [h1, h2] = d.hunks
    expect(h1.header).toBe('@@ -1,4 +1,4 @@ function x')
    expect(h1.lines).toEqual([
      { kind: 'ctx', text: 'one', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'two', oldNo: 2, newNo: null },
      { kind: 'add', text: 'TWO', oldNo: null, newNo: 2 },
      { kind: 'ctx', text: 'three', oldNo: 3, newNo: 3 }
    ])
    expect(h2.lines).toEqual([
      { kind: 'ctx', text: 'ten', oldNo: 10, newNo: 10 },
      { kind: 'add', text: 'ten and a half', oldNo: null, newNo: 11 },
      { kind: 'ctx', text: 'eleven', oldNo: 11, newNo: 12 },
      { kind: 'note', text: '\\ No newline at end of file', oldNo: null, newNo: null }
    ])
    // raw keeps the exact patch lines, @@ header included.
    expect(h1.raw).toEqual(['@@ -1,4 +1,4 @@ function x', ' one', '-two', '+TWO', ' three'])
  })

  it('parses a new file', () => {
    const d = parseDiff(
      lines(
        'diff --git a/new.txt b/new.txt',
        'new file mode 100644',
        'index 0000000..3333333',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1,2 @@',
        '+a',
        '+b'
      )
    )
    expect(d.header).toContain('new file mode 100644')
    expect(d.hunks).toHaveLength(1)
    expect(d.hunks[0].lines).toEqual([
      { kind: 'add', text: 'a', oldNo: null, newNo: 1 },
      { kind: 'add', text: 'b', oldNo: null, newNo: 2 }
    ])
  })

  it('parses a deleted file', () => {
    const d = parseDiff(
      lines(
        'diff --git a/old.txt b/old.txt',
        'deleted file mode 100644',
        'index 3333333..0000000',
        '--- a/old.txt',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-a',
        '-b'
      )
    )
    expect(d.hunks[0].lines).toEqual([
      { kind: 'del', text: 'a', oldNo: 1, newNo: null },
      { kind: 'del', text: 'b', oldNo: 2, newNo: null }
    ])
  })

  it('accepts hunk headers without line counts', () => {
    const d = parseDiff(lines('diff --git a/x b/x', '@@ -5 +7 @@', '-old', '+new'))
    expect(d.hunks[0].lines).toEqual([
      { kind: 'del', text: 'old', oldNo: 5, newNo: null },
      { kind: 'add', text: 'new', oldNo: null, newNo: 7 }
    ])
  })

  it('flags binary files (both git notations) and has no hunks', () => {
    const summary = parseDiff(
      lines(
        'diff --git a/img.png b/img.png',
        'index 1111111..2222222 100644',
        'Binary files a/img.png and b/img.png differ'
      )
    )
    expect(summary.binary).toBe(true)
    expect(summary.hunks).toEqual([])

    const patch = parseDiff(
      lines(
        'diff --git a/img.png b/img.png',
        'index 1111111..2222222 100644',
        'GIT binary patch',
        'literal 10',
        'Rcmd'
      )
    )
    expect(patch.binary).toBe(true)
    expect(patch.hunks).toEqual([])
  })

  it('parses a pure rename (no hunks) and a rename with changes', () => {
    const pure = parseDiff(
      lines(
        'diff --git a/a.txt b/b.txt',
        'similarity index 100%',
        'rename from a.txt',
        'rename to b.txt'
      )
    )
    expect(pure.hunks).toEqual([])
    expect(pure.binary).toBe(false)
    expect(pure.header).toEqual([
      'diff --git a/a.txt b/b.txt',
      'similarity index 100%',
      'rename from a.txt',
      'rename to b.txt'
    ])

    const edited = parseDiff(
      lines(
        'diff --git a/a.txt b/b.txt',
        'similarity index 80%',
        'rename from a.txt',
        'rename to b.txt',
        'index 1111111..2222222 100644',
        '--- a/a.txt',
        '+++ b/b.txt',
        '@@ -1,2 +1,2 @@',
        ' keep',
        '-x',
        '+y'
      )
    )
    expect(edited.header).toHaveLength(7)
    expect(edited.hunks[0].lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'add'])
  })

  it('parses a combined (conflict) diff as read-only lines without numbers', () => {
    const d = parseDiff(
      lines(
        'diff --cc f.txt',
        'index 1111111,2222222..0000000',
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@@ -1,2 -1,2 +1,6 @@@',
        '  common',
        '++<<<<<<< HEAD',
        ' +ours',
        '+ theirs',
        '- gone',
        ' -gone too'
      )
    )
    expect(d.combined).toBe(true)
    expect(d.hunks).toHaveLength(1)
    expect(d.hunks[0].header).toBe('@@@ -1,2 -1,2 +1,6 @@@')
    expect(d.hunks[0].lines).toEqual([
      { kind: 'ctx', text: 'common', oldNo: null, newNo: null },
      { kind: 'add', text: '<<<<<<< HEAD', oldNo: null, newNo: null },
      { kind: 'add', text: 'ours', oldNo: null, newNo: null },
      { kind: 'add', text: 'theirs', oldNo: null, newNo: null },
      { kind: 'del', text: 'gone', oldNo: null, newNo: null },
      { kind: 'del', text: 'gone too', oldNo: null, newNo: null }
    ])
  })

  it('recognises "diff --combined" too', () => {
    const d = parseDiff(lines('diff --combined f.txt', '@@@ -1 -1 +1 @@@', '++x'))
    expect(d.combined).toBe(true)
  })

  it('ignores text before the first "diff" line', () => {
    const d = parseDiff('warning: LF will be replaced by CRLF\n' + MODIFIED)
    expect(d.header[0]).toBe('diff --git a/f.txt b/f.txt')
    expect(d.hunks).toHaveLength(2)
  })

  it('strips CR from displayed text but keeps it in the raw patch', () => {
    const d = parseDiff('diff --git a/w b/w\n@@ -1 +1 @@\r\n-a\r\n+b\r\n')
    expect(d.hunks[0].header).toBe('@@ -1 +1 @@')
    expect(d.hunks[0].lines.map((l) => l.text)).toEqual(['a', 'b'])
    expect(d.hunks[0].raw).toEqual(['@@ -1 +1 @@\r', '-a\r', '+b\r'])
  })

  it('treats an empty line inside a hunk as empty context', () => {
    const d = parseDiff('diff --git a/x b/x\n@@ -1,2 +1,2 @@\n\n-a\n+b\n')
    expect(d.hunks[0].lines[0]).toEqual({ kind: 'ctx', text: '', oldNo: 1, newNo: 1 })
    expect(d.hunks[0].lines[1].oldNo).toBe(2)
  })

  it('returns an empty result for empty input', () => {
    expect(parseDiff('')).toEqual({ header: [], hunks: [], binary: false, combined: false })
  })
})

describe('hunkPatch', () => {
  it('reproduces a single-hunk diff exactly', () => {
    const text = lines(
      'diff --git a/f b/f',
      'index 1..2 100644',
      '--- a/f',
      '+++ b/f',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+c'
    )
    const d = parseDiff(text)
    expect(hunkPatch(d, d.hunks[0])).toBe(text)
  })

  it('builds a standalone patch for one hunk of many', () => {
    const d = parseDiff(MODIFIED)
    const patch = hunkPatch(d, d.hunks[1])
    expect(patch).toBe(
      lines(
        'diff --git a/f.txt b/f.txt',
        'index 1111111..2222222 100644',
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -10,3 +10,4 @@',
        ' ten',
        '+ten and a half',
        ' eleven',
        '\\ No newline at end of file'
      )
    )
    // The patch parses back to the same hunk.
    const again = parseDiff(patch)
    expect(again.header).toEqual(d.header)
    expect(again.hunks).toEqual([d.hunks[1]])
  })

  it('keeps the CRLF line endings of the original lines', () => {
    const text = 'diff --git a/w b/w\n@@ -1 +1 @@\r\n-a\r\n+b\r\n'
    const d = parseDiff(text)
    expect(hunkPatch(d, d.hunks[0])).toBe(text)
  })
})

describe('toSplitRows', () => {
  const hunkOf = (...body: string[]): Hunk =>
    parseDiff(lines('diff --git a/x b/x', '@@ -1,9 +1,9 @@', ...body)).hunks[0]
  const texts = (hunk: Hunk): (string | null)[][] =>
    toSplitRows(hunk).map((r) => [r.left?.text ?? null, r.right?.text ?? null])

  it('pairs a deletion with the addition that replaces it', () => {
    const hunk = hunkOf(' one', '-two', '+TWO', ' three')
    expect(texts(hunk)).toEqual([
      ['one', 'one'],
      ['two', 'TWO'],
      ['three', 'three']
    ])
    // Context lines are the same line on both sides.
    const rows = toSplitRows(hunk)
    expect(rows[0].left).toBe(rows[0].right)
  })

  it('pads the shorter side when counts differ', () => {
    expect(texts(hunkOf('-a', '-b', '-c', '+x'))).toEqual([
      ['a', 'x'],
      ['b', null],
      ['c', null]
    ])
    expect(texts(hunkOf('-a', '+x', '+y'))).toEqual([
      ['a', 'x'],
      [null, 'y']
    ])
  })

  it('puts pure additions on the right and pure deletions on the left', () => {
    const kinds = (hunk: Hunk): (string | undefined)[][] =>
      toSplitRows(hunk).map((r) => [r.left?.kind, r.right?.kind])
    expect(kinds(hunkOf(' a', '+b'))).toEqual([
      ['ctx', 'ctx'],
      [undefined, 'add']
    ])
    expect(kinds(hunkOf('-a', ' b'))).toEqual([
      ['del', undefined],
      ['ctx', 'ctx']
    ])
  })

  it('does not pair changes across a context line', () => {
    expect(texts(hunkOf('-a', ' b', '+c'))).toEqual([
      ['a', null],
      ['b', 'b'],
      [null, 'c']
    ])
  })

  it('shows "no newline" notes on the left only, after the pending changes', () => {
    const rows = toSplitRows(hunkOf('-a', '+b', '\\ No newline at end of file'))
    expect(rows).toHaveLength(2)
    expect(rows[0].left?.text).toBe('a')
    expect(rows[0].right?.text).toBe('b')
    expect(rows[1]).toEqual({
      left: { kind: 'note', text: '\\ No newline at end of file', oldNo: null, newNo: null },
      right: null
    })
  })

  it('returns no rows for an empty hunk', () => {
    expect(toSplitRows({ header: '@@ -0,0 +0,0 @@', lines: [], raw: [] })).toEqual([])
  })
})
