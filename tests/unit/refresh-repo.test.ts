// The repository view's refresh in repo.ts (snapshot, logPage, cached remotes and
// upstreams, ahead/behind only for moved branches), on temporary repositories. The git
// processes are counted. Everything happens in a temp folder.
import { execFileSync } from 'child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000 })

const spawned: string[][] = []
vi.mock('child_process', async (importOriginal) => {
  const cp = await importOriginal<typeof import('child_process')>()
  return {
    ...cp,
    spawn: (cmd: string, args: string[], opts: object) => {
      // GitDesk's own `-c` options come first: keep the subcommand and what follows.
      const at = args.findIndex((a, i) => !a.startsWith('-') && args[i - 1] !== '-c')
      spawned.push(args.slice(at))
      return cp.spawn(cmd, args, opts)
    }
  }
})
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, net: {}, shell: {} }))
vi.mock('../../src/main/trust/worktree', () => ({ assertSafeWorkTree: async () => {} }))

const repoOps = await import('../../src/main/repo')

const root = mkdtempSync(join(tmpdir(), 'gitdesk-refresh-'))
// Long on a busy Windows machine: one test writes and removes 3000 files.
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }), 60_000)

let counter = 0
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENTITY, '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function newRepo(): string {
  const dir = resolve(join(root, `r${counter++}`))
  mkdirSync(dir, { recursive: true })
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'first')
  return dir
}

function commit(dir: string, file: string, text: string): void {
  appendFileSync(join(dir, file), text)
  sh(dir, 'add', file)
  sh(dir, 'commit', '-q', '-m', `edit ${file}`)
}

const commands = (): string[] => spawned.map((a) => a[0])
beforeEach(() => {
  spawned.length = 0
})

describe('snapshot', () => {
  it('a refresh with nothing moved runs status and for-each-ref only', async () => {
    const dir = newRepo()
    const first = await repoOps.snapshot(dir, 100, null)
    expect(first.refs?.branches.map((b) => b.name)).toEqual(['main'])
    expect(first.log).toHaveLength(1)
    expect(first.stashes).toEqual([])

    spawned.length = 0
    const again = await repoOps.snapshot(dir, 100, first)
    expect(again.refs).toBeNull()
    expect(again.log).toBeNull()
    expect(again.stashes).toBeNull()
    expect(commands().sort()).toEqual(['for-each-ref', 'status'])

    // A working-copy edit: still two processes, the status shows it.
    appendFileSync(join(dir, 'a.txt'), 'more\n')
    spawned.length = 0
    const edited = await repoOps.snapshot(dir, 100, again)
    expect(edited.status.unstaged.map((f) => f.path)).toEqual(['a.txt'])
    expect(edited.refs).toBeNull()
    expect(edited.log).toBeNull()
    expect(commands().sort()).toEqual(['for-each-ref', 'status'])
  })

  it('reads refs and log again when a ref moves, and the stash list when it changes', async () => {
    const dir = newRepo()
    const first = await repoOps.snapshot(dir, 100, null)
    commit(dir, 'a.txt', 'two\n')
    const moved = await repoOps.snapshot(dir, 100, first)
    expect(moved.log?.map((c) => c.subject)).toEqual(['edit a.txt', 'first'])
    expect(moved.refs?.headSha).toBe(sh(dir, 'rev-parse', 'HEAD'))
    expect(moved.stashes).toBeNull()

    appendFileSync(join(dir, 'a.txt'), 'wip 1\n')
    sh(dir, 'stash', 'push', '-q', '-m', 'one')
    appendFileSync(join(dir, 'a.txt'), 'wip 2\n')
    sh(dir, 'stash', 'push', '-q', '-m', 'two')
    const stashed = await repoOps.snapshot(dir, 100, moved)
    expect(stashed.stashes?.map((s) => s.message)).toEqual(['On main: two', 'On main: one'])
    expect(stashed.log).toBeNull() // the stash is not in the graph

    // Dropping the older stash only rewrites the stash's reflog, not refs/stash.
    sh(dir, 'stash', 'drop', '-q', 'stash@{1}')
    const dropped = await repoOps.snapshot(dir, 100, stashed)
    expect(dropped.stashes?.map((s) => s.message)).toEqual(['On main: two'])
  })

  it('reads the log again when "Load more" asks for more commits', async () => {
    const dir = newRepo()
    const first = await repoOps.snapshot(dir, 1, null)
    commit(dir, 'a.txt', '2\n')
    const s1 = await repoOps.snapshot(dir, 1, first)
    expect(s1.log).toHaveLength(1)
    const s2 = await repoOps.snapshot(dir, 5, s1)
    expect(s2.log).toHaveLength(2)
    expect(s2.refs).toBeNull()
  })

  it('sees an upstream set in the config, and a new remote', async () => {
    const dir = newRepo()
    sh(dir, 'branch', 'feature')
    const first = await repoOps.snapshot(dir, 10, null)
    expect(first.refs?.branches.find((b) => b.name === 'feature')?.upstream).toBeNull()
    sh(dir, 'branch', '--set-upstream-to=main', 'feature')
    commit(dir, 'a.txt', 'ahead\n')
    const next = await repoOps.snapshot(dir, 10, first)
    const feature = next.refs?.branches.find((b) => b.name === 'feature')
    expect(feature).toMatchObject({ upstream: 'main', behind: 1, ahead: 0 })

    sh(dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
    const withRemote = await repoOps.snapshot(dir, 10, next)
    expect(withRemote.refs?.remotes).toEqual(['origin'])
  })

  it('computes ahead/behind again only for the branches that moved', async () => {
    const dir = newRepo()
    for (const name of ['one', 'two', 'three']) {
      sh(dir, 'branch', name)
      sh(dir, 'branch', `--set-upstream-to=main`, name)
    }
    commit(dir, 'a.txt', 'main moves\n')
    const first = await repoOps.snapshot(dir, 10, null)
    expect(first.refs?.branches.find((b) => b.name === 'two')?.behind).toBe(1)

    sh(dir, 'switch', '-q', 'two')
    commit(dir, 'b.txt', 'two moves\n')
    spawned.length = 0
    const next = await repoOps.snapshot(dir, 10, first)
    const track = spawned.filter((a) => a.some((x) => x.includes('upstream:track')))
    expect(track).toHaveLength(1)
    expect(track[0].slice(2)).toEqual(['refs/heads/two'])
    expect(next.refs?.branches.find((b) => b.name === 'two')).toMatchObject({
      ahead: 1,
      behind: 1,
      isHead: true
    })
    expect(next.refs?.branches.find((b) => b.name === 'one')?.behind).toBe(1)
    expect(next.refs?.headBranch).toBe('two')
  })

  it('reports a detached HEAD and an unborn branch like git does', async () => {
    const dir = newRepo()
    commit(dir, 'a.txt', 'two\n')
    sh(dir, 'switch', '-q', '--detach', 'HEAD~1')
    const detached = await repoOps.snapshot(dir, 10, null)
    expect(detached.refs?.headBranch).toBeNull()
    expect(detached.refs?.headSha).toBe(sh(dir, 'rev-parse', 'HEAD'))

    const empty = resolve(join(root, `empty${counter++}`))
    mkdirSync(empty)
    sh(empty, 'init', '-q', '-b', 'trunk')
    const unborn = await repoOps.snapshot(empty, 10, null)
    expect(unborn.refs?.headBranch).toBe('trunk')
    expect(unborn.refs?.headSha).toBeNull()
    expect(unborn.log).toEqual([])
  })

  it('works in a linked worktree (refs, config and stash live in the main repository)', async () => {
    const dir = newRepo()
    const wt = resolve(join(root, `wt${counter++}`))
    sh(dir, 'worktree', 'add', '-q', '-b', 'side', wt)
    const first = await repoOps.snapshot(wt, 10, null)
    expect(first.refs?.headBranch).toBe('side')
    sh(dir, 'remote', 'add', 'upstream', 'https://example.com/x.git')
    const next = await repoOps.snapshot(wt, 10, first)
    expect(next.refs?.remotes).toEqual(['upstream'])
  })
})

describe('logPage', () => {
  it('continues the log in the same order, and refuses once a ref moved', async () => {
    const dir = newRepo()
    for (let i = 0; i < 5; i++) commit(dir, 'a.txt', `${i}\n`)
    const all = await repoOps.log(dir, 10)
    const first = await repoOps.snapshot(dir, 3, null)
    spawned.length = 0
    const page = await repoOps.logPage(dir, 3, 3, first.refsKey)
    expect(commands().sort()).toEqual(['for-each-ref', 'log'])
    expect([...first.log!, ...page!.commits].map((c) => c.sha)).toEqual(all.map((c) => c.sha))
    // The view's next snapshot with the grown list reads no log.
    const next = await repoOps.snapshot(dir, 6, { ...first, logKey: page!.logKey })
    expect(next.log).toBeNull()

    commit(dir, 'a.txt', 'moved\n')
    expect(await repoOps.logPage(dir, 6, 3, first.refsKey)).toBeNull()
  })
})

describe('cached lookups', () => {
  it('resolves the git folder once for callers starting together', async () => {
    const dir = newRepo()
    await Promise.all([repoOps.currentOperation(dir), repoOps.gitDir(dir), repoOps.gitDir(dir)])
    expect(spawned.filter((a) => a[0] === 'rev-parse')).toHaveLength(1)
  })

  it("reads origin's URL again only when the config changes", async () => {
    const dir = newRepo()
    sh(dir, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git')
    expect(await repoOps.originSlug(dir)).toBe('owner/repo')
    spawned.length = 0
    expect(await repoOps.originSlug(dir)).toBe('owner/repo')
    expect(spawned).toHaveLength(0)
    sh(dir, 'remote', 'set-url', 'origin', 'https://gitlab.com/g/r.git')
    expect(await repoOps.originSlug(dir)).toBeNull()
    expect(await repoOps.originUrl(dir)).toBe('https://gitlab.com/g/r.git')
  })

  it('a dashboard summary runs three git processes once warm', async () => {
    const dir = newRepo()
    await repoOps.summary(dir)
    spawned.length = 0
    const s = await repoOps.summary(dir)
    expect(commands().sort()).toEqual(['for-each-ref', 'log', 'status'])
    expect(s.lastCommit?.subject).toBe('first')
    expect(s.activity.reduce((a, b) => a + b, 0)).toBe(1)
    expect(s.branchCount).toBe(1)
  })

  it('a summary still shows the last commit when it is older than 30 days', async () => {
    const dir = resolve(join(root, `old${counter++}`))
    mkdirSync(dir)
    sh(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    sh(dir, 'add', '.')
    const old = '2001-01-01T00:00:00Z'
    execFileSync('git', [...IDENTITY, 'commit', '-q', '-m', 'ancient'], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old }
    })
    await repoOps.summary(dir)
    spawned.length = 0
    const s = await repoOps.summary(dir)
    expect(s.lastCommit?.subject).toBe('ancient')
    expect(s.activity.every((n) => n === 0)).toBe(true)
    // No fourth process for what is older than the activity window.
    expect(commands().sort()).toEqual(['for-each-ref', 'log', 'status'])
  })

  it("a summary's last commit is the newest branch tip, remote ones included, like log -1 --all", async () => {
    const dir = newRepo()
    const at = (date: string, ...args: string[]): void => {
      execFileSync('git', [...IDENTITY, ...args], {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      })
    }
    sh(dir, 'checkout', '-q', '-b', 'side')
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    sh(dir, 'add', 'b.txt')
    at('2030-01-01T00:00:00Z', 'commit', '-q', '-m', 'on side')
    // Only on a remote-tracking branch, and the newest of all.
    sh(dir, 'checkout', '-q', '--detach')
    writeFileSync(join(dir, 'c.txt'), 'c\n')
    sh(dir, 'add', 'c.txt')
    at('2031-01-01T00:00:00Z', 'commit', '-q', '-m', 'fetched')
    sh(dir, 'update-ref', 'refs/remotes/origin/feature', 'HEAD')
    sh(dir, 'checkout', '-q', 'main')

    const s = await repoOps.summary(dir)
    const [sha, author, email, date, subject] = sh(
      dir,
      'log',
      '-1',
      '--all',
      '--format=%H%x00%aN%x00%aE%x00%at%x00%s'
    ).split('\0')
    expect(s.lastCommit).toEqual({ sha, author, email, date: Number(date), subject })
    expect(s.lastCommit?.subject).toBe('fetched')
    expect(s.branchCount).toBe(2) // local branches only
  })

  it("a summary's last commit author follows .mailmap, like log -1 --all", async () => {
    const dir = resolve(join(root, `mailmap${counter++}`))
    mkdirSync(dir)
    sh(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    sh(dir, 'add', '.')
    execFileSync(
      'git',
      ['-c', 'user.name=old', '-c', 'user.email=old@x.io', 'commit', '-q', '-m', 'm'],
      {
        cwd: dir
      }
    )
    writeFileSync(join(dir, '.mailmap'), 'New Name <new@x.io> <old@x.io>\n')
    const s = await repoOps.summary(dir)
    const [author, email] = sh(dir, 'log', '-1', '--all', '--format=%aN%x00%aE').split('\0')
    expect([author, email]).toEqual(['New Name', 'new@x.io'])
    expect(s.lastCommit).toMatchObject({ author, email })
  })
})

describe('parseTips', () => {
  it('counts the local branches and takes the first well-formed tip', () => {
    const sha = 'a'.repeat(40)
    const rec = (ref: string, s: string, date: string): string =>
      [ref, s, 'Ann', '<ann@example.com>', date, 'subject', ''].join('\0') + '\n'
    const out =
      rec('refs/remotes/origin/x', 'nope', '5') +
      rec('refs/remotes/origin/y', sha, '4') +
      rec('refs/heads/main', 'b'.repeat(40), '3') +
      rec('refs/heads/dev', 'c'.repeat(40), '2')
    expect(repoOps.parseTips(out)).toEqual({
      branchCount: 2,
      lastCommit: { sha, author: 'Ann', email: 'ann@example.com', date: 4, subject: 'subject' }
    })
    expect(repoOps.parseTips('')).toEqual({ branchCount: 0, lastCommit: null })
  })
})

describe('fetchAll and commit-graphs', () => {
  const graphKeys =
    '^(fetch\\.writecommitgraph|core\\.commitgraph|gc\\.writecommitgraph|maintenance\\.commit-graph\\.enabled)$'
  /** Whether git's own config (global, system) says something about commit-graphs. */
  const configured = (dir: string): boolean => {
    try {
      return sh(dir, 'config', '--get-regexp', graphKeys) !== ''
    } catch {
      return false // exit code 1: nothing set
    }
  }

  it("leaves the user's commit-graph settings alone", async () => {
    for (const [key, value] of [
      ['fetch.writeCommitGraph', 'false'],
      ['core.commitGraph', 'false'],
      ['gc.writeCommitGraph', 'false']
    ]) {
      const dir = newRepo()
      sh(dir, 'config', key, value)
      expect(await repoOps.commitGraphFlag(dir)).toEqual([])
    }
  })

  it('writes one when nothing is configured, and follows fetch.writeCommitGraph=false', async () => {
    const upstream = newRepo()
    const dir = newRepo()
    sh(dir, 'remote', 'add', 'origin', upstream)
    if (!configured(dir)) {
      expect(await repoOps.commitGraphFlag(dir)).toEqual(['--write-commit-graph'])
      spawned.length = 0
      await repoOps.fetchAll(dir)
      expect(spawned.find((a) => a[0] === 'fetch')).toContain('--write-commit-graph')
    }

    commit(upstream, 'a.txt', 'more\n')
    sh(dir, 'config', 'fetch.writeCommitGraph', 'false')
    spawned.length = 0
    await repoOps.fetchAll(dir)
    expect(spawned.find((a) => a[0] === 'fetch')).not.toContain('--write-commit-graph')
    expect(sh(dir, 'rev-parse', 'origin/main')).toBe(sh(upstream, 'rev-parse', 'HEAD'))
  })
})

describe('commit-graph after a clone', () => {
  it("writes one unless the user's config turns commit-graphs off", async () => {
    const dir = newRepo()
    expect(await repoOps.commitGraphConfig(dir)).not.toBe('off')
    spawned.length = 0
    expect(await repoOps.writeCommitGraphAfterClone(dir)).toBe(true)
    expect(spawned.some((a) => a[0] === 'commit-graph')).toBe(true)
    for (const [key, value] of [
      ['core.commitGraph', 'false'],
      ['fetch.writeCommitGraph', 'no'],
      ['gc.writeCommitGraph', '0']
    ]) {
      const off = newRepo()
      sh(off, 'config', key, value)
      expect(await repoOps.commitGraphConfig(off)).toBe('off')
      spawned.length = 0
      expect(await repoOps.writeCommitGraphAfterClone(off)).toBe(false)
      expect(spawned.some((a) => a[0] === 'commit-graph')).toBe(false)
    }
    // Turned on explicitly: the user decides, and fetch adds no flag of its own.
    const on = newRepo()
    sh(on, 'config', 'fetch.writeCommitGraph', 'true')
    expect(await repoOps.commitGraphConfig(on)).toBe('on')
    expect(await repoOps.commitGraphFlag(on)).toEqual([])
  })
})

describe('snapshot in a reftable repository', () => {
  it('sees an older stash dropped (its reflog lives in the tables)', async (ctx) => {
    const dir = resolve(join(root, `reftable${counter++}`))
    try {
      execFileSync('git', ['init', '-q', '--ref-format=reftable', '-b', 'main', dir], {
        stdio: 'ignore'
      })
    } catch {
      ctx.skip() // git before 2.45
    }
    sh(dir, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    sh(dir, 'add', '.')
    sh(dir, 'commit', '-q', '-m', 'first')
    appendFileSync(join(dir, 'a.txt'), 'wip 1\n')
    sh(dir, 'stash', 'push', '-q', '-m', 'one')
    appendFileSync(join(dir, 'a.txt'), 'wip 2\n')
    sh(dir, 'stash', 'push', '-q', '-m', 'two')
    const stashed = await repoOps.snapshot(dir, 100, null)
    expect(stashed.stashes?.map((s) => s.message)).toEqual(['On main: two', 'On main: one'])
    expect(stashed.refs?.headBranch).toBe('main')
    sh(dir, 'stash', 'drop', '-q', 'stash@{1}')
    const dropped = await repoOps.snapshot(dir, 100, stashed)
    expect(dropped.stashes?.map((s) => s.message)).toEqual(['On main: two'])
  })
})

describe('many paths at once (Stage all, Discard all)', () => {
  it('splits a long path list into commands that fit a command line', async () => {
    expect(repoOps.pathBatches([])).toEqual([])
    expect(repoOps.pathBatches(['a', 'b', 'c'], 8)).toEqual([['a', 'b'], ['c']])
    expect(repoOps.pathBatches(['a-very-long-name'], 4)).toEqual([['a-very-long-name']])
    const dir = newRepo()
    mkdirSync(join(dir, 'many'))
    const names = Array.from({ length: 3000 }, (_, i) => `many/file-number-${i}.txt`)
    for (const n of names) writeFileSync(join(dir, n), 'x\n')
    // Names stay literal, never patterns: "a[1].txt" does not stage "a1.txt".
    writeFileSync(join(dir, 'many', 'a[1].txt'), 'x\n')
    writeFileSync(join(dir, 'many', 'a1.txt'), 'x\n')
    spawned.length = 0
    await repoOps.stage(dir, [...names, 'many/a[1].txt'])
    const staged = sh(dir, 'diff', '--cached', '--name-only').split('\n')
    expect(staged).toHaveLength(3001)
    expect(staged).toContain('many/a[1].txt')
    expect(staged).not.toContain('many/a1.txt')
    // One command with git 2.26 or later (paths on stdin), several before.
    const adds = spawned.filter((a) => a[0] === 'add').length
    const version = await repoOps.gitVersion(dir)
    const modern = !!version && (version[0] > 2 || (version[0] === 2 && version[1] >= 26))
    if (modern) expect(adds).toBe(1)
    else expect(adds).toBeGreaterThan(1)
    names.push('many/a[1].txt')
    await repoOps.unstage(dir, names)
    expect(sh(dir, 'diff', '--cached', '--name-only')).toBe('')
    await repoOps.discard(
      dir,
      names.map((path) => ({ path, kind: '?' as const }))
    )
    expect(sh(dir, 'status', '--porcelain', '-uall')).toBe('?? many/a1.txt')
    // 3000 files written, staged, unstaged and deleted: disk-bound (antivirus scans each
    // new file on Windows), so it gets more time than the other tests when the machine is busy.
  }, 90_000)
})

describe('recentSnapshot', () => {
  it("is the view's last status, until a write or the watcher says something changed", async () => {
    const dir = newRepo()
    await repoOps.snapshot(dir, 10, null)
    expect(repoOps.recentSnapshot(dir, 3000)?.status.branch).toBe('main')
    expect(repoOps.recentSnapshot(dir, -1)).toBeNull() // too old
    await new Promise((r) => setTimeout(r, 5))
    repoOps.noteChanged(dir)
    expect(repoOps.recentSnapshot(dir, 3000)).toBeNull()
    await new Promise((r) => setTimeout(r, 5))
    await repoOps.snapshot(dir, 10, null)
    expect(repoOps.recentSnapshot(dir, 3000)).not.toBeNull()
  })
})

describe('readConflict size cap', () => {
  it('does not read a conflicted file over CONFLICT_MAX_BYTES', async () => {
    const dir = newRepo()
    const big = (fill: string): string =>
      (fill.repeat(79) + '\n').repeat(Math.ceil((repoOps.CONFLICT_MAX_BYTES + 1) / 80))
    writeFileSync(join(dir, 'big.txt'), 'base\n')
    sh(dir, 'add', '.')
    sh(dir, 'commit', '-q', '-m', 'base')
    sh(dir, 'checkout', '-q', '-b', 'other')
    writeFileSync(join(dir, 'big.txt'), big('o'))
    sh(dir, 'commit', '-q', '-am', 'other')
    sh(dir, 'checkout', '-q', 'main')
    writeFileSync(join(dir, 'big.txt'), big('m'))
    sh(dir, 'commit', '-q', '-am', 'main')
    try {
      sh(dir, 'merge', '-q', 'other')
    } catch {
      /* conflict expected */
    }
    const file = await repoOps.readConflict(dir, 'big.txt')
    expect(file).toEqual({ content: null, binary: false, encodingProblem: false, tooLarge: true })
    // It can still be taken whole from one side.
    await repoOps.resolveConflictSide(dir, 'big.txt', 'theirs')
    expect(sh(dir, 'diff', '--cached', '--name-only', '--diff-filter=U')).toBe('')
  })
})

describe('githubComSlug (the hosting parser, for every github.com remote form)', () => {
  it.each([
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['https://user@github.com/owner/repo', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
    ['ssh://git@github.com:22/owner/repo.git', 'owner/repo'],
    ['https://www.github.com/owner/repo/pull/1', 'owner/repo'],
    ['https://gitlab.com/group/repo.git', null],
    ['https://github.example.com/owner/repo.git', null],
    ['https://github.com/../repo', null],
    ['C:\\repos\\local', null]
  ])('%s -> %s', (url, slug) => {
    expect(repoOps.githubComSlug(url)).toBe(slug)
  })
})
