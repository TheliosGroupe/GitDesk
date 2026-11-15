import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// compose.ts reaches repo.ts, which imports electron (for github.ts): not needed here.
vi.mock('electron', () => ({ net: {}, app: {}, BrowserWindow: { getAllWindows: () => [] } }))

const { applyComposition, collectChanges, COMPOSE_MAX_UNITS } =
  await import('../../src/main/ai/compose')
const { diffStat, diffText, emptyTree } = await import('../../src/main/ai/context')
const { hunkIsComplete, splitFilePatches } = await import('../../src/shared/features/ai-patch')

let repo: string

function g(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

const lines = (n: number, tag = ''): string =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}\n`).join('')

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gitdesk-ai-'))
  g('init', '-q', '-b', 'main')
  g('config', 'user.name', 'Test')
  g('config', 'user.email', 'test@example.com')
  g('config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'a.txt'), lines(40))
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  writeFileSync(join(repo, 'gone.txt'), 'bye\n')
  g('add', '.')
  g('commit', '-q', '-m', 'initial')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('compose on a real repository', () => {
  it('commits hunks of one file in separate commits, plus whole files', async () => {
    const a = lines(40)
      .replace('line 2\n', 'line 2 changed\n')
      .replace('line 35\n', 'line 35 changed\n')
    writeFileSync(join(repo, 'a.txt'), a)
    writeFileSync(join(repo, 'b.txt'), 'b\nmore\n')
    writeFileSync(join(repo, 'new.txt'), 'brand new\n')
    rmSync(join(repo, 'gone.txt'))
    g('add', 'b.txt') // something staged: the plan covers staged and unstaged alike

    const changes = await collectChanges(repo)
    const units = changes.set.units
    expect(units.map((u) => `${u.id}:${u.path}`)).toEqual([
      'h1:a.txt',
      'h2:a.txt',
      'f1:b.txt',
      'f2:gone.txt',
      'f3:new.txt'
    ])

    const plan = {
      fingerprint: changes.fingerprint,
      units,
      level: 'hunk' as const,
      truncated: false,
      withheld: [],
      commits: [
        { message: 'Change line 2 and b', units: ['h1', 'f1'], files: [] },
        { message: 'Add new, remove gone', units: ['f3', 'f2'], files: [] },
        { message: 'Change line 35\n\nWith a body.', units: ['h2'], files: [] }
      ]
    }
    expect(await applyComposition(repo, plan)).toEqual({ commits: 3 })

    expect(g('log', '--format=%s', '-4').trim().split('\n')).toEqual([
      'Change line 35',
      'Add new, remove gone',
      'Change line 2 and b',
      'initial'
    ])
    // First commit: only the first hunk of a.txt.
    expect(g('show', 'HEAD~2:a.txt')).toBe(lines(40).replace('line 2\n', 'line 2 changed\n'))
    expect(g('show', '--name-only', '--format=', 'HEAD~1').trim().split('\n').sort()).toEqual([
      'gone.txt',
      'new.txt'
    ])
    expect(g('show', 'HEAD:a.txt')).toBe(a)
    expect(g('log', '-1', '--format=%b').trim()).toBe('With a body.')
    // Everything committed; the working copy is untouched.
    expect(g('status', '--porcelain')).toBe('')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe(a)
  })

  it('refuses a plan once the working copy changed', async () => {
    writeFileSync(join(repo, 'b.txt'), 'b\nchanged\n')
    const changes = await collectChanges(repo)
    writeFileSync(join(repo, 'b.txt'), 'b\nchanged again\n')
    await expect(
      applyComposition(repo, {
        fingerprint: changes.fingerprint,
        units: changes.set.units,
        level: 'file',
        truncated: false,
        withheld: [],
        commits: [{ message: 'x', units: ['f1'], files: [] }]
      })
    ).rejects.toThrow(/changed since this plan/)
  })

  it('refuses a plan that leaves out changes', async () => {
    writeFileSync(join(repo, 'b.txt'), 'b2\n')
    writeFileSync(join(repo, 'c.txt'), 'c\n')
    const changes = await collectChanges(repo)
    await expect(
      applyComposition(repo, {
        fingerprint: changes.fingerprint,
        units: changes.set.units,
        level: 'file',
        truncated: false,
        withheld: [],
        commits: [{ message: 'only b', units: ['f1'], files: [] }]
      })
    ).rejects.toThrow(/leaves out 1 change/)
    expect(g('log', '--format=%s').trim()).toBe('initial')
  })

  it('rolls back when a commit fails midway, restoring HEAD and the index', async () => {
    writeFileSync(join(repo, 'b.txt'), 'b2\n')
    writeFileSync(join(repo, 'c.txt'), 'c\n')
    g('add', 'b.txt')
    const indexBefore = g('diff', '--cached', '--name-status')
    const head = g('rev-parse', 'HEAD').trim()
    // A hook that rejects the second commit.
    writeFileSync(
      join(repo, '.git', 'hooks', 'commit-msg'),
      '#!/bin/sh\ngrep -q fail "$1" && exit 1\nexit 0\n',
      { mode: 0o755 }
    )
    const changes = await collectChanges(repo)
    await expect(
      applyComposition(repo, {
        fingerprint: changes.fingerprint,
        units: changes.set.units,
        level: 'file',
        truncated: false,
        withheld: [],
        commits: [
          { message: 'first', units: ['f1'], files: [] },
          { message: 'please fail', units: ['f2'], files: [] }
        ]
      })
    ).rejects.toThrow(/Nothing was committed/)
    expect(g('rev-parse', 'HEAD').trim()).toBe(head)
    expect(g('diff', '--cached', '--name-status')).toBe(indexBefore)
    expect(g('status', '--porcelain')).toBe('M  b.txt\n?? c.txt\n')
  })
})

describe('reading diffs for the AI', () => {
  it('reports a cut diff, drops the partial file and names the unread ones', async () => {
    writeFileSync(join(repo, 'a.txt'), lines(40, ' changed'))
    writeFileSync(join(repo, 'b.txt'), 'b2\n')
    const full = await diffText(repo, ['HEAD'])
    expect(full).toMatchObject({ truncated: false, unread: [] })
    const cut = await diffText(repo, ['HEAD'], 300)
    expect(cut.truncated).toBe(true)
    // What is kept is whole files only; every other changed file is named.
    const shown = splitFilePatches(cut.text)
    expect(shown.every((p) => p.hunks.every(hunkIsComplete))).toBe(true)
    expect(cut.unread).toContain('b.txt')
    expect([...shown.map((p) => p.path), ...cut.unread].sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('refuses to compose a diff over the cap instead of cutting it', async () => {
    const big = Array.from({ length: 90_000 }, (_, i) => `${'x'.repeat(40)} ${i}\n`).join('')
    writeFileSync(join(repo, 'big.txt'), big)
    g('add', 'big.txt')
    g('commit', '-q', '-m', 'big')
    writeFileSync(join(repo, 'big.txt'), big.replace(/x/g, 'y'))
    await expect(collectChanges(repo)).rejects.toThrow(/too large to compose/)
  }, 60_000)

  it('refuses too many changes before reading them', async () => {
    for (let i = 0; i <= COMPOSE_MAX_UNITS; i++) writeFileSync(join(repo, `n${i}.txt`), 'x\n')
    await expect(collectChanges(repo)).rejects.toThrow(/too many changes to compose/)
  })

  it('diffs a root commit against the empty tree, without conversion programs', async () => {
    // A conversion program configured for *.txt: it must never run (it would leave a marker).
    writeFileSync(join(repo, '.gitattributes'), '*.txt diff=marker\n')
    g('config', 'diff.marker.textconv', 'touch textconv-ran; cat')
    const root = g('rev-list', '--max-parents=0', 'HEAD').trim()
    const empty = await emptyTree(repo)
    const read = await diffText(repo, ['-M', empty, root])
    expect(read.truncated).toBe(false)
    expect(read.text).toContain('+++ b/a.txt')
    expect(read.text).toContain('+line 40')
    expect(await diffStat(repo, empty, root)).toContain('3 files changed')
    expect(existsSync(join(repo, 'textconv-ran'))).toBe(false)
  })
})
