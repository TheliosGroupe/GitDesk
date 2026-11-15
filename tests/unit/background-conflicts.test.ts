// Conflict warnings (src/main/gitextras/core.ts) on temporary repositories: what each call
// runs again. Everything happens in a temp folder.
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { parseStatusV2 } from '../../src/main/gitextras/parse'

vi.setConfig({ testTimeout: 60_000 })

const h = vi.hoisted(() => ({ commands: [] as string[], failMergeTree: false }))
vi.mock('../../src/main/git', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/git')>()
  return {
    ...real,
    git: (cwd: string, args: string[], opts?: object) => {
      h.commands.push(args[0])
      return real.git(cwd, args, opts)
    },
    runGit: (cwd: string, args: string[], opts?: object) => {
      h.commands.push(args[0])
      if (h.failMergeTree && args[0] === 'merge-tree') return Promise.reject(new Error('busy'))
      return real.runGit(cwd, args, opts)
    }
  }
})

const core = await import('../../src/main/gitextras/core')
const repoOps = await import('../../src/main/repo')
const { CONFLICT_RETRY_MS } = await import('../../src/shared/features/gitextras')

const root = mkdtempSync(join(tmpdir(), 'gitdesk-conflicts-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

describe('parseStatusV2', () => {
  it('reads HEAD, branch, upstream and every changed path', () => {
    const sha = 'a'.repeat(40)
    const out = [
      `# branch.oid ${sha}`,
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +1 -0',
      '1 .M N... 100644 100644 100644 aaa bbb a b.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt',
      'old.txt',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc both.txt',
      '? untracked.txt',
      ''
    ].join('\0')
    expect(parseStatusV2(out)).toEqual({
      headSha: sha,
      branch: 'feature/x',
      upstream: 'origin/feature/x',
      paths: ['a b.txt', 'new name.txt', 'old.txt', 'both.txt', 'untracked.txt']
    })
  })

  it('handles a detached HEAD and an unborn branch', () => {
    expect(parseStatusV2(`# branch.oid ${'b'.repeat(40)}\0# branch.head (detached)\0`)).toEqual({
      headSha: 'b'.repeat(40),
      branch: null,
      upstream: null,
      paths: []
    })
    expect(parseStatusV2('# branch.oid (initial)\0# branch.head main\0? x\0').headSha).toBeNull()
  })
})

describe('conflictWarnings', () => {
  const repo = join(root, 'repo')
  mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-q', '-m', 'init')
  for (const name of ['feature', 'other']) {
    sh(repo, 'switch', '-q', '-c', name, 'main')
    writeFileSync(join(repo, name === 'feature' ? 'a.txt' : 'b.txt'), `${name}\n`)
    sh(repo, 'commit', '-q', '-am', name)
  }
  sh(repo, 'switch', '-q', 'main')
  const count = (cmd: string): number => h.commands.filter((c) => c === cmd).length

  it('finds the branch that changes your file', async () => {
    writeFileSync(join(repo, 'a.txt'), 'mine\n')
    h.commands.length = 0
    const report = await core.conflictWarnings(repo)
    expect(report.warnings.map((w) => w.branch)).toEqual(['feature'])
    expect(report.myFiles).toBe(1)
    expect(count('merge-base')).toBe(2) // feature and other
  })

  it('runs only status and for-each-ref when nothing changed', async () => {
    h.commands.length = 0
    await core.conflictWarnings(repo)
    expect(h.commands.sort()).toEqual(['for-each-ref', 'status'])
  })

  it("reuses the status of the view's refresh that just ran", async () => {
    const before = await core.conflictWarnings(repo)
    await repoOps.snapshot(repo, 50, null)
    h.commands.length = 0
    expect(await core.conflictWarnings(repo)).toEqual(before)
    expect(h.commands).toEqual(['for-each-ref'])
    repoOps.forgetRepo(repo) // the next tests change the repository without a refresh
  })

  it('does not check the branches again when a file is staged', async () => {
    const before = await core.conflictWarnings(repo)
    sh(repo, 'add', 'a.txt')
    h.commands.length = 0
    const after = await core.conflictWarnings(repo)
    expect(after).toEqual(before)
    expect(h.commands.sort()).toEqual(['for-each-ref', 'status'])
  })

  it('reuses each branch when your files change, and tests a new overlap once', async () => {
    writeFileSync(join(repo, 'b.txt'), 'mine too\n')
    h.commands.length = 0
    const report = await core.conflictWarnings(repo)
    expect(report.warnings.map((w) => w.branch).sort()).toEqual(['feature', 'other'])
    expect(count('merge-base')).toBe(0)
    expect(count('diff')).toBe(0)
    // "feature" was tested before; "other" overlaps for the first time.
    expect(count('merge-tree')).toBeLessThanOrEqual(1)
  })

  it('checks the branches again after a commit', async () => {
    sh(repo, 'commit', '-q', '-m', 'work')
    h.commands.length = 0
    const report = await core.conflictWarnings(repo)
    expect(count('merge-base')).toBeGreaterThanOrEqual(2)
    // On main without an upstream, only uncommitted work counts: b.txt.
    expect(report.warnings.map((w) => w.branch)).toEqual(['other'])
  })
})

describe('conflictWarnings after a merge-tree failure', () => {
  // Intended behaviour (changed): a failed merge-tree is retried after CONFLICT_RETRY_MS,
  // not on every refresh, and the report says it is incomplete meanwhile.
  it('runs merge-tree again once the retry delay has passed', async () => {
    const repo = join(root, 'retry')
    mkdirSync(repo)
    sh(repo, 'init', '-q', '-b', 'main')
    sh(repo, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-q', '-m', 'init')
    sh(repo, 'switch', '-q', '-c', 'feature')
    writeFileSync(join(repo, 'a.txt'), 'feature\n')
    sh(repo, 'commit', '-q', '-am', 'feature')
    sh(repo, 'switch', '-q', 'main')
    writeFileSync(join(repo, 'a.txt'), 'mine\n')

    h.failMergeTree = true
    try {
      const failed = await core.conflictWarnings(repo)
      expect(failed.warnings.map((w) => w.status)).toEqual(['unknown'])
      expect(failed.incomplete).toBe(true)
      // Within the delay, a refresh does not run it again.
      h.commands.length = 0
      const again = await core.conflictWarnings(repo)
      expect(h.commands.filter((c) => c === 'merge-tree')).toHaveLength(0)
      expect(again.incomplete).toBe(true)
    } finally {
      h.failMergeTree = false
    }
    // Nothing changed in the repository: after the delay, the next check tries again.
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + CONFLICT_RETRY_MS + 1)
    try {
      h.commands.length = 0
      const report = await core.conflictWarnings(repo)
      expect(h.commands.filter((c) => c === 'merge-tree')).toHaveLength(1)
      expect(report.warnings.map((w) => w.status)).toEqual(['overlap']) // HEAD vs feature: no conflict
      expect(report.incomplete).toBeUndefined()
      // Once it succeeded, it is reused.
      h.commands.length = 0
      await core.conflictWarnings(repo)
      expect(h.commands.sort()).toEqual(['for-each-ref', 'status'])
    } finally {
      clock.mockRestore()
    }
  })
})
