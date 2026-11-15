import { describe, expect, it } from 'vitest'
import {
  applyHunks,
  changeUnits,
  hunkIsComplete,
  repairPlan,
  splitFilePatches,
  unquoteGitPath,
  validatePlan
} from '../../src/shared/features/ai-patch'

const OLD = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve'
]
  .map((l) => l + '\n')
  .join('')

// `git diff -U1` of OLD -> NEW where NEW changes "two" and "eleven" and adds a line after "six".
const DIFF = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -6,2 +6,3 @@
 six
+six and a half
 seven
@@ -10,3 +11,3 @@
 ten
-eleven
+ELEVEN
 twelve
diff --git a/new.bin b/new.bin
new file mode 100644
index 0000000..3333333
Binary files /dev/null and b/new.bin differ
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4444444..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
index 5555555..6666666 100644
--- "a/caf\\303\\251.txt"
+++ "b/caf\\303\\251.txt"
@@ -1 +1 @@
-x
+y
`

describe('splitFilePatches', () => {
  it('splits files, statuses, hunks and quoted paths', () => {
    const files = splitFilePatches(DIFF)
    expect(files.map((f) => [f.path, f.status, f.hunks.length])).toEqual([
      ['f.txt', 'M', 3],
      ['new.bin', 'B', 0],
      ['gone.txt', 'D', 1],
      ['café.txt', 'M', 1]
    ])
    expect(files[0].hunks[1]).toMatchObject({ oldStart: 6, oldCount: 2, newStart: 6, newCount: 3 })
    expect(files[0].text.startsWith('diff --git a/f.txt')).toBe(true)
  })

  it('unquotes C-style paths', () => {
    expect(unquoteGitPath('"a/caf\\303\\251 \\"x\\".txt"')).toBe('a/café "x".txt')
    expect(unquoteGitPath('plain')).toBe('plain')
  })
})

describe('applyHunks', () => {
  const hunks = splitFilePatches(DIFF)[0].hunks
  const NEW = OLD.replace('two', 'TWO')
    .replace('six\n', 'six\nsix and a half\n')
    .replace('eleven', 'ELEVEN')

  it('applies all, none, or any subset by line number', () => {
    expect(applyHunks(OLD, hunks)).toBe(NEW)
    expect(applyHunks(OLD, [])).toBe(OLD)
    expect(applyHunks(OLD, [hunks[2]])).toBe(OLD.replace('eleven', 'ELEVEN'))
    expect(applyHunks(OLD, [hunks[2], hunks[0]])).toBe(
      OLD.replace('two', 'TWO').replace('eleven', 'ELEVEN')
    )
    expect(applyHunks(OLD, [hunks[1]])).toBe(OLD.replace('six\n', 'six\nsix and a half\n'))
  })

  it('refuses a hunk that does not match', () => {
    expect(() => applyHunks(OLD.replace('two', 'deux'), [hunks[0]])).toThrow(/does not match/)
  })

  it('handles "No newline at end of file" on both sides', () => {
    const old = 'a\nb'
    const patch = splitFilePatches(`diff --git a/x b/x
--- a/x
+++ b/x
@@ -1,2 +1,2 @@
 a
-b
\\ No newline at end of file
+c
\\ No newline at end of file
`)[0].hunks
    expect(applyHunks(old, patch)).toBe('a\nc')
    const addEol = splitFilePatches(`diff --git a/x b/x
--- a/x
+++ b/x
@@ -1,2 +1,2 @@
 a
-b
\\ No newline at end of file
+b
`)[0].hunks
    expect(applyHunks(old, addEol)).toBe('a\nb\n')
  })

  it('refuses a hunk whose body does not match its header (a diff cut short)', () => {
    // DIFF cut in the middle of the last hunk's "+" line, as an output cap would.
    const cut = DIFF.slice(0, DIFF.indexOf('+ELEVEN') + 4)
    const last = splitFilePatches(cut)[0].hunks[2]
    expect(last.lines.at(-1)).toBe('+ELE')
    expect(hunkIsComplete(last)).toBe(false)
    expect(hunks.every(hunkIsComplete)).toBe(true)
    expect(() => applyHunks(OLD, [hunks[0], last])).toThrow(/incomplete/)
    // Such a file is never split into hunks.
    expect(changeUnits(cut, []).units[0]).toMatchObject({ kind: 'file', path: 'f.txt' })
  })

  it('keeps CRLF content', () => {
    const old = 'a\r\nb\r\n'
    const h = splitFilePatches(
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n'
    )[0].hunks
    expect(applyHunks(old, h)).toBe('a\r\nc\r\n')
  })
})

describe('changeUnits', () => {
  it('splits text files into hunks and keeps others whole', () => {
    const set = changeUnits(DIFF, [
      { path: 'notes.md', content: 'hello\n' },
      { path: 'img.png', content: null }
    ])
    expect(set.level).toBe('hunk')
    expect(set.units.map((u) => `${u.id}:${u.kind}:${u.path}:${u.status}`)).toEqual([
      'h1:hunk:f.txt:M',
      'h2:hunk:f.txt:M',
      'h3:hunk:f.txt:M',
      'f1:file:new.bin:B',
      'f2:file:gone.txt:D',
      'f3:file:café.txt:M',
      'f4:file:notes.md:A',
      'f5:file:img.png:B'
    ])
    expect(set.hunksByPath.get('f.txt')).toEqual(['h1', 'h2', 'h3'])
    expect(set.units[0]).toMatchObject({ added: 1, removed: 1 })
  })

  it('falls back to files when asked, when too many hunks, or when a file cannot be split', () => {
    expect(changeUnits(DIFF, [], { fileLevel: true }).units.every((u) => u.kind === 'file')).toBe(
      true
    )
    expect(changeUnits(DIFF, [], { maxHunks: 2 }).level).toBe('file')
    const set = changeUnits(DIFF, [], { splittable: (p) => p !== 'f.txt' })
    expect(set.units[0]).toMatchObject({
      kind: 'file',
      path: 'f.txt',
      header: 'Modified (3 hunks)'
    })
  })
})

describe('plan validation', () => {
  const units = changeUnits(DIFF, []).units

  it('accepts a plan using every change once', () => {
    const plan = [
      { message: 'one', units: ['h1', 'f1', 'f2'] },
      { message: 'two', units: ['h2', 'h3', 'f3'] }
    ]
    expect(validatePlan(plan, units)).toHaveLength(2)
  })

  it('rejects missing, duplicated and unknown changes, and missing messages', () => {
    expect(() => validatePlan([{ message: 'x', units: ['h1'] }], units)).toThrow(/leaves out 5/)
    expect(() =>
      validatePlan(
        [
          { message: 'a', units: ['h1', 'h2', 'h3', 'f1', 'f2', 'f3'] },
          { message: 'b', units: ['h1'] }
        ],
        units
      )
    ).toThrow(/twice/)
    expect(() => validatePlan([{ message: 'a', units: ['zzz'] }], units)).toThrow(/unknown/)
    expect(() =>
      validatePlan([{ message: ' ', units: ['h1', 'h2', 'h3', 'f1', 'f2', 'f3'] }], units)
    ).toThrow(/no message/)
    expect(() => validatePlan([], units)).toThrow(/no commits/)
  })

  it('repairs what a model proposes', () => {
    const repaired = repairPlan(
      [
        { message: 'Fix f', units: ['h1', 'h1', 'nope'] },
        { message: '', units: ['f1'] },
        { message: 'empty', units: [] }
      ],
      units
    )
    // h2, h3 join the commit holding f.txt's other hunk; f2, f3 get a final commit.
    expect(repaired.map((c) => [c.message, c.units])).toEqual([
      ['Fix f', ['h1', 'h2', 'h3']],
      ['Commit 2', ['f1']],
      ['Update remaining files', ['f2', 'f3']]
    ])
    expect(repaired[0].files).toEqual(['f.txt'])
    expect(() => validatePlan(repaired, units)).not.toThrow()
  })
})
