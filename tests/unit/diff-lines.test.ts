import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { linesPatch, parseDiff, type DiffLine, type Hunk } from '../../src/renderer/src/lib/diff'
import { highlightHunk, languageFor, splitHtmlLines } from '../../src/renderer/src/lib/highlight'

/** Indexes of the changed lines of `hunk` matching `sign + text` (e.g. '+X', '-b'). */
function pick(hunk: Hunk, ...wanted: string[]): Set<number> {
  const sign = (l: DiffLine): string => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ')
  const set = new Set<number>()
  for (const w of wanted) {
    const i = hunk.lines.findIndex((l, j) => !set.has(j) && sign(l) + l.text === w)
    if (i === -1) throw new Error(`no line ${w}`)
    set.add(i)
  }
  return set
}

describe('linesPatch (pure)', () => {
  const diff = parseDiff(
    [
      'diff --git a/f.txt b/f.txt',
      'index 1111111..2222222 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,4 +1,4 @@ ctx',
      ' a',
      '-b',
      '+B',
      ' c',
      '-d',
      '+D',
      ''
    ].join('\n')
  )
  const hunk = diff.hunks[0]

  it('returns null when no change is selected', () => {
    expect(linesPatch(diff, hunk, new Set(), false)).toBeNull()
    expect(linesPatch(diff, hunk, new Set([0]), false)).toBeNull()
  })

  it('returns the whole hunk when every change is selected', () => {
    const all = pick(hunk, '-b', '+B', '-d', '+D')
    expect(linesPatch(diff, hunk, all, false)).toBe([...diff.header, ...hunk.raw].join('\n') + '\n')
  })

  it('forward: drops unselected additions, keeps unselected removals as context', () => {
    expect(linesPatch(diff, hunk, pick(hunk, '-b', '+B'), false)).toBe(
      [...diff.header, '@@ -1,4 +1,4 @@ ctx', ' a', '-b', '+B', ' c', ' d', ''].join('\n')
    )
    expect(linesPatch(diff, hunk, pick(hunk, '+D'), false)).toBe(
      [...diff.header, '@@ -1,4 +1,5 @@ ctx', ' a', ' b', ' c', ' d', '+D', ''].join('\n')
    )
  })

  it('reverse: drops unselected removals, keeps unselected additions as context', () => {
    expect(linesPatch(diff, hunk, pick(hunk, '-d'), true)).toBe(
      [...diff.header, '@@ -1,5 +1,4 @@ ctx', ' a', ' B', ' c', '-d', ' D', ''].join('\n')
    )
  })

  it('splits a context line whose final newline changes', () => {
    const d = parseDiff(
      [
        'diff --git a/f b/f',
        '--- a/f',
        '+++ b/f',
        '@@ -1,2 +1,3 @@',
        ' a',
        '-b',
        '\\ No newline at end of file',
        '+c',
        '+d',
        '\\ No newline at end of file',
        ''
      ].join('\n')
    )
    const h = d.hunks[0]
    expect(linesPatch(d, h, pick(h, '+c'), false)).toBe(
      [
        ...d.header,
        '@@ -1,2 +1,3 @@',
        ' a',
        '-b',
        '\\ No newline at end of file',
        '+b',
        '+c',
        ''
      ].join('\n')
    )
  })
})

// ---- end to end against real git -------------------------------------------

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

/** A repository whose HEAD has `head` as f.txt (or nothing when null). */
function repo(head: string | null): void {
  dir = mkdtempSync(join(tmpdir(), 'gitdesk-lines-'))
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  if (head !== null) {
    write(head)
    git('add', 'f.txt')
  } else writeFileSync(join(dir, 'other'), 'x\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
}
const write = (text: string): void => writeFileSync(join(dir, 'f.txt'), text)
const worktree = (): string => readFileSync(join(dir, 'f.txt'), 'utf8')
const index = (): string => git('show', ':f.txt')

/** Builds the patch for `action` exactly like DiffView and applies it like RepoView. */
function apply(
  action: 'stage' | 'unstage' | 'discard',
  hunkIndex: number,
  ...wanted: string[]
): void {
  const base = ['diff', '--no-color', '--no-ext-diff', '-M']
  const text = git(...base, ...(action === 'unstage' ? ['--cached'] : []), '--', 'f.txt')
  const diff = parseDiff(text)
  const hunk = diff.hunks[hunkIndex]
  const patch = linesPatch(diff, hunk, pick(hunk, ...wanted), action !== 'stage')
  expect(patch).not.toBeNull()
  const args = ['apply', '--whitespace=nowarn']
  if (action !== 'discard') args.push('--cached')
  if (action !== 'stage') args.push('--reverse')
  execFileSync('git', [...args, '-'], { cwd: dir, input: patch!, stdio: ['pipe', 'pipe', 'pipe'] })
}

const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.runIf(hasGit)('linesPatch with git apply', () => {
  it('stages one added line', () => {
    repo('a\nb\nc\n')
    write('a\nX\nb\nY\nc\n')
    apply('stage', 0, '+X')
    expect(index()).toBe('a\nX\nb\nc\n')
    expect(worktree()).toBe('a\nX\nb\nY\nc\n')
  })

  it('stages one removed line', () => {
    repo('1\n2\n3\n4\n5\n6\n')
    write('1\n2\n4\n6\n')
    apply('stage', 0, '-3')
    expect(index()).toBe('1\n2\n4\n5\n6\n')
  })

  it('stages a modified pair, or only its new line', () => {
    repo('a\nb\nc\nd\n')
    write('a\nB\nc\nD\n')
    apply('stage', 0, '-b', '+B')
    expect(index()).toBe('a\nB\nc\nd\n')
    // Then just the addition of the remaining pair: the old line stays.
    apply('stage', 0, '+D')
    expect(index()).toBe('a\nB\nc\nd\nD\n')
  })

  it('handles lines at the end of a file without a trailing newline', () => {
    repo('a\nb')
    write('a\nc\nd')
    apply('stage', 0, '+c')
    expect(index()).toBe('a\nb\nc\n')
    git('reset', '-q')
    apply('stage', 0, '+d')
    expect(index()).toBe('a\nb\nd')
    git('reset', '-q')
    apply('stage', 0, '-b', '+c')
    expect(index()).toBe('a\nc\n')
    git('reset', '-q')
    apply('stage', 0, '-b')
    expect(index()).toBe('a\n')
  })

  it('discards lines at the end of a file without a trailing newline', () => {
    repo('a\nb')
    write('a\nc\nd')
    apply('discard', 0, '+d')
    expect(worktree()).toBe('a\nc\n')
    write('a\nc\nd')
    apply('discard', 0, '-b')
    expect(worktree()).toBe('a\nb\nc\nd')
    expect(index()).toBe('a\nb')
  })

  it('unstages a subset of the staged lines', () => {
    repo('a\nb\nc\nd\n')
    write('a\nX\nb\nY\nd\n')
    git('add', 'f.txt')
    // c was replaced by Y: unstaging only "+Y" keeps the removal of c staged.
    apply('unstage', 0, '+Y')
    expect(index()).toBe('a\nX\nb\nd\n')
    apply('unstage', 0, '-c')
    expect(index()).toBe('a\nX\nb\nc\nd\n')
    // The working copy is never touched by unstaging.
    expect(worktree()).toBe('a\nX\nb\nY\nd\n')
  })

  it('unstages lines at the end of a file without a trailing newline', () => {
    repo('a\nb\n')
    write('a\nb\nc')
    git('add', 'f.txt')
    // "-b +b" (newline change) and "+c": unstage only c.
    apply('unstage', 0, '+c')
    expect(index()).toBe('a\nb\n')
  })

  it('unstages some lines of a new file, keeping it added', () => {
    repo(null)
    write('a\nb\nc\n')
    git('add', 'f.txt')
    apply('unstage', 0, '+b')
    expect(index()).toBe('a\nc\n')
  })

  it('stages some removed lines of a deleted file', () => {
    repo('a\nb\nc\n')
    unlinkSync(join(dir, 'f.txt'))
    apply('stage', 0, '-b')
    expect(index()).toBe('a\nc\n')
  })

  it('discards one line of the second hunk only', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`)
    repo(lines.join('\n') + '\n')
    const changed = [...lines]
    changed[1] = 'L2'
    changed.splice(25, 0, 'n1', 'n2')
    write(changed.join('\n') + '\n')
    apply('discard', 1, '+n2')
    const expected = [...lines]
    expected[1] = 'L2'
    expected.splice(25, 0, 'n1')
    expect(worktree()).toBe(expected.join('\n') + '\n')
  })

  it('keeps CRLF line endings', () => {
    repo('a\r\nb\r\n')
    write('a\r\nX\r\nb\r\nY\r\n')
    apply('stage', 0, '+X')
    expect(index()).toBe('a\r\nX\r\nb\r\n')
  })
})

describe('highlighting', () => {
  it('finds the language from the file name', () => {
    expect(languageFor('src/a/App.tsx')).toBe('typescript')
    expect(languageFor('C:\\x\\Dockerfile')).toBe('dockerfile')
    expect(languageFor('Cargo.toml')).toBe('ini')
    expect(languageFor('notes.unknownext')).toBeNull()
    expect(languageFor('LICENSE')).toBeNull()
  })

  it('splits HTML into lines with balanced spans', () => {
    expect(splitHtmlLines('<span class="a">x\ny<span class="b">z\nw</span></span>v')).toEqual([
      '<span class="a">x</span>',
      '<span class="a">y<span class="b">z</span></span>',
      '<span class="a"><span class="b">w</span></span>v'
    ])
  })

  it('highlights each side as a block, so multi-line comments stay comments', () => {
    const diff = parseDiff(
      ['@@ -1,3 +1,3 @@', ' /* start', '-old', '+new', ' end */', ' const x = 1', ''].join('\n')
    )
    const html = highlightHunk(diff.hunks[0], 'javascript')!
    expect(html).toHaveLength(5)
    expect(html[1]).toContain('hljs-comment')
    expect(html[2]).toContain('hljs-comment')
    expect(html[4]).toContain('hljs-keyword')
    // highlight.js escapes the text it is given.
    const esc = parseDiff(['@@ -1 +1 @@', '-<b>&', '+x', ''].join('\n'))
    expect(highlightHunk(esc.hunks[0], 'javascript')![0]).toContain('&lt;b&gt;&amp;')
  })
})
