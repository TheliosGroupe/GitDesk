// Integration tests of repo.ts, undo.ts and worktrees.ts on temporary repositories.
// Everything happens in a temp folder; nothing outside it is touched.
import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000 }) // several git processes per test

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, net: {}, shell: {} }))
// The work-tree pinning check (trust cluster) is tested on its own.
vi.mock('../../src/main/trust/worktree', () => ({ assertSafeWorkTree: async () => {} }))
vi.mock('../../src/main/store', () => ({
  requireRepo: (p: string) => resolve(p),
  loadState: () => ({ repos: [], settings: {}, worktreeParents: {} }),
  removeRepo: () => ({ repos: [] }),
  addRepos: () => ({ repos: [] }),
  saveState: (s: unknown) => s,
  samePath: (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
}))
vi.mock('../../src/main/watcher', () => ({ unwatchRepo: () => {} }))
vi.mock('../../src/main/terminal/pty', () => ({ killTerminalsIn: () => {} }))

const repoOps = await import('../../src/main/repo')
const undoOps = await import('../../src/main/undo')
const worktrees = await import('../../src/main/terminal/worktrees')

const root = mkdtempSync(join(tmpdir(), 'gitdesk-repo-ops-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENTITY, '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

/** A new repository with one commit on main. */
function newRepo(name = `r${counter++}`): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'Test')
  sh(dir, 'config', 'user.email', 'test@example.com')
  sh(dir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'first')
  return dir
}

function commitFile(dir: string, file: string, text: string, message = file): string {
  writeFileSync(join(dir, file), text)
  sh(dir, 'add', '--', file)
  sh(dir, 'commit', '-q', '-m', message)
  return sh(dir, 'rev-parse', 'HEAD')
}

/** A bare remote, `me` (a clone of it) and `other` (a colleague's clone). */
function withRemote(): { remote: string; me: string; other: string } {
  const base = newRepo()
  const remote = join(root, `remote${counter++}.git`)
  sh(root, 'clone', '-q', '--bare', base, remote)
  const clone = (name: string): string => {
    const dir = join(root, `${name}${counter++}`)
    sh(root, 'clone', '-q', remote, dir)
    sh(dir, 'config', 'user.name', 'Test')
    sh(dir, 'config', 'user.email', 'test@example.com')
    sh(dir, 'config', 'core.autocrlf', 'false')
    return dir
  }
  return { remote, me: clone('me'), other: clone('other') }
}

function linkFolder(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Ignores a node_modules link made by linkFolder. Without a trailing slash: on macOS and
 * Linux the link is a symlink, which git does not treat as a folder, so `node_modules/`
 * would leave it untracked (a change).
 */
const NODE_MODULES_IGNORED = 'node_modules\n'

describe('log parsers (PERF-05)', () => {
  it('keeps commits whole when messages and names hold separator bytes', async () => {
    const dir = newRepo()
    const fake = `x\x1e${'b'.repeat(40)}\x1f\x1fEvil\x1fe@x\x1f1\x1fFake`
    writeFileSync(join(dir, 'b.txt'), 'b')
    sh(dir, 'add', '.')
    execFileSync(
      'git',
      ['-c', 'user.name=Na\x1fme', '-c', 'user.email=m\x1e@x', 'commit', '-q', '-m', fake],
      { cwd: dir }
    )
    const log = await repoOps.log(dir, 10)
    expect(log).toHaveLength(2)
    expect(log[0].subject).toBe(fake)
    expect(log[0].author).toBe('Na\x1fme')
    expect(log[0].email).toBe('m\x1e@x')
    expect(log.every((c) => /^[0-9a-f]{40}$/.test(c.sha) && Number.isFinite(c.date))).toBe(true)

    const details = await repoOps.commitDetails(dir, log[0].sha)
    expect(details.subject).toBe(fake)
    expect(details.files.map((f) => f.path)).toEqual(['b.txt'])

    const activity = await repoOps.activityCommits(dir, Date.now() / 1000 - 86400)
    expect(activity.map((c) => c.subject)).toEqual([fake, 'first'])
    expect((await repoOps.summary(dir)).lastCommit?.subject).toBe(fake)
  })

  it('drops malformed records instead of passing them on', () => {
    const good = `${'a'.repeat(40)}\x00\x00Ann\x00a@x\x00100\x00ok\x00\n`
    const bad = `nothex\x00\x00Bob\x00b@x\x00x\x00bad\x00\n`
    expect(repoOps.parseLog(good + bad).map((c) => c.subject)).toEqual(['ok'])
    expect(repoOps.parseLog('')).toEqual([])
  })

  it('reads stashes whose message holds separator bytes', async () => {
    const dir = newRepo()
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    sh(dir, 'stash', 'push', '-q', '-m', 'one\x1ftwo\x1ethree')
    const list = await repoOps.stashes(dir)
    expect(list).toHaveLength(1)
    expect(list[0].ref).toBe('stash@{0}')
    expect(list[0].message).toContain('one\x1ftwo\x1ethree')
  })
})

describe('stash identity (PERF-12)', () => {
  it('drops the stash that was listed even if the list moved, and refuses a gone one', async () => {
    const dir = newRepo()
    const push = (text: string): void => {
      writeFileSync(join(dir, 'a.txt'), `${text}\n`)
      sh(dir, 'stash', 'push', '-q', '-m', text)
    }
    push('old')
    push('valuable')
    const listed = await repoOps.stashes(dir) // valuable = 0, old = 1
    const old = listed.find((s) => s.message.endsWith('old'))!
    push('agent') // elsewhere, meanwhile: old is now stash@{2}
    await repoOps.stashDrop(dir, old.index, old.sha)
    const left = (await repoOps.stashes(dir)).map((s) => s.message.split(': ').pop())
    expect(left).toEqual(['agent', 'valuable'])
    await expect(repoOps.stashDrop(dir, old.index, old.sha)).rejects.toThrow(/no longer exists/)
    expect(await repoOps.stashes(dir)).toHaveLength(2)
  })
})

describe('push (PERF-01)', () => {
  it('refuses a force push over commits fetched in the background', async () => {
    const { me, other } = withRemote()
    commitFile(other, 'c.txt', 'colleague\n')
    sh(other, 'push', '-q')
    const seen = sh(me, 'rev-parse', 'origin/main') // what the user saw
    sh(me, 'fetch', '-q', '--all', '--prune') // background fetch brings the colleague's commit
    commitFile(me, 'mine.txt', 'mine\n')
    sh(me, 'commit', '-q', '--amend', '-m', 'rewritten')
    const colleague = sh(me, 'rev-parse', 'origin/main')

    await expect(repoOps.push(me, true, { 'origin/main': seen })).rejects.toThrow(
      /changed since you last saw it/
    )
    await expect(repoOps.push(me, true)).rejects.toThrow() // --force-if-includes
    expect(sh(other, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]).toBe(colleague)

    // Once the user has seen it (and chose to overwrite it), the force push goes through.
    await repoOps.push(me, true, { 'origin/main': colleague })
    expect(sh(me, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]).toBe(
      sh(me, 'rev-parse', 'HEAD')
    )
  })

  it('pushes only the current branch, even with push.default=matching', async () => {
    const { me, other } = withRemote()
    sh(other, 'switch', '-q', '-c', 'release')
    sh(other, 'push', '-q', '-u', 'origin', 'release')
    sh(me, 'fetch', '-q')
    sh(me, 'branch', '-q', 'release', 'origin/release') // a stale local copy
    sh(other, 'switch', '-q', 'release')
    const fix = commitFile(other, 'fix.txt', 'fix\n')
    sh(other, 'push', '-q')
    sh(me, 'config', 'push.default', 'matching')
    sh(me, 'commit', '-q', '--amend', '-m', 'rewritten main')

    await repoOps.push(me, true, { 'origin/main': sh(me, 'rev-parse', 'origin/main') })
    expect(sh(me, 'ls-remote', 'origin', 'refs/heads/release').split('\t')[0]).toBe(fix)

    commitFile(me, 'more.txt', 'more\n')
    await repoOps.push(me, false)
    expect(sh(me, 'ls-remote', 'origin', 'refs/heads/release').split('\t')[0]).toBe(fix)
    expect(sh(me, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]).toBe(
      sh(me, 'rev-parse', 'HEAD')
    )
  })

  it('pushes a new branch and sets its upstream', async () => {
    const { me } = withRemote()
    sh(me, 'switch', '-q', '-c', 'feature')
    commitFile(me, 'f.txt', 'f\n')
    await repoOps.push(me, false)
    expect(sh(me, 'rev-parse', '--abbrev-ref', 'feature@{upstream}')).toBe('origin/feature')
    await expect(repoOps.push(me, true, { 'origin/feature': 'not-a-sha' })).rejects.toThrow(
      /Invalid commit id/
    )
    await expect(repoOps.push(me, true, [] as never)).rejects.toThrow(/Invalid remote branch list/)
  })
})

describe('push target (PERF-01)', () => {
  /** A second remote, "fork", holding the same history. */
  function addFork(me: string, remote: string): string {
    const fork = join(root, `fork${counter++}.git`)
    sh(root, 'clone', '-q', '--bare', remote, fork)
    sh(me, 'remote', 'add', 'fork', fork)
    sh(me, 'fetch', '-q', 'fork')
    return fork
  }
  const tip = (dir: string, remote: string, ref: string): string =>
    sh(dir, 'ls-remote', remote, ref).split('\t')[0]

  it('pushes to the push remote of a fork workflow (pushDefault, pushRemote)', async () => {
    const { me, remote } = withRemote()
    addFork(me, remote)
    const upstreamTip = tip(me, 'origin', 'refs/heads/main')
    sh(me, 'config', 'remote.pushDefault', 'fork')
    commitFile(me, 'one.txt', '1\n')
    await repoOps.push(me, false)
    expect(tip(me, 'fork', 'refs/heads/main')).toBe(sh(me, 'rev-parse', 'HEAD'))
    expect(tip(me, 'origin', 'refs/heads/main')).toBe(upstreamTip)

    // A force push is leased on the fork's branch as shown, not on the upstream's.
    sh(me, 'config', '--unset', 'remote.pushDefault')
    sh(me, 'config', 'branch.main.pushRemote', 'fork')
    sh(me, 'fetch', '-q', 'fork')
    sh(me, 'commit', '-q', '--amend', '-m', 'rewritten')
    const shown = { 'origin/main': upstreamTip, 'fork/main': sh(me, 'rev-parse', 'fork/main') }
    await expect(repoOps.push(me, true, { ...shown, 'fork/main': upstreamTip })).rejects.toThrow(
      /changed since you last saw it/
    )
    await repoOps.push(me, true, shown)
    expect(tip(me, 'fork', 'refs/heads/main')).toBe(sh(me, 'rev-parse', 'HEAD'))
    expect(tip(me, 'origin', 'refs/heads/main')).toBe(upstreamTip)
  })

  it('follows a remote.<name>.push mapping (review refs)', async () => {
    const { me } = withRemote()
    const before = tip(me, 'origin', 'refs/heads/main')
    sh(me, 'config', 'remote.origin.push', 'refs/heads/main:refs/for/main')
    commitFile(me, 'review.txt', 'r\n')
    await repoOps.push(me, false)
    expect(tip(me, 'origin', 'refs/for/main')).toBe(sh(me, 'rev-parse', 'HEAD'))
    expect(tip(me, 'origin', 'refs/heads/main')).toBe(before)
  })

  it('never pushes a branch onto an upstream of another name (push.default simple)', async () => {
    const { me } = withRemote()
    const mainTip = tip(me, 'origin', 'refs/heads/main')
    // What `git switch -c fix origin/main` does in a terminal: fix tracks origin/main.
    sh(me, 'switch', '-q', '-c', 'fix', '--track', 'origin/main')
    commitFile(me, 'fix.txt', 'f')
    await expect(repoOps.push(me, false)).rejects.toThrow(/another name/)
    const shown = { 'origin/main': mainTip }
    await expect(repoOps.push(me, true, shown)).rejects.toThrow(/another name/)
    expect(tip(me, 'origin', 'refs/heads/main')).toBe(mainTip)
    expect(tip(me, 'origin', 'refs/heads/fix')).toBe('')

    // Asked for in so many words: push.default=upstream lands on main.
    sh(me, 'config', 'push.default', 'upstream')
    await repoOps.push(me, false)
    expect(tip(me, 'origin', 'refs/heads/main')).toBe(sh(me, 'rev-parse', 'HEAD'))
  })

  it('keeps a local upstream (".") instead of replacing it on push', async () => {
    const { me } = withRemote()
    sh(me, 'switch', '-q', '-c', 'topic', '--track', 'main')
    commitFile(me, 'topic.txt', 't')
    await repoOps.push(me, false)
    expect(tip(me, 'origin', 'refs/heads/topic')).toBe(sh(me, 'rev-parse', 'HEAD'))
    expect(sh(me, 'config', 'branch.topic.remote').trim()).toBe('.')
    expect(sh(me, 'config', 'branch.topic.merge').trim()).toBe('refs/heads/main')
  })

  it('passes refusals from the server through unchanged', async () => {
    const { me, remote } = withRemote()
    // A harmless hook in the test's own bare remote: it only refuses the push.
    writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho protected >&2\nexit 1\n', {
      mode: 0o755
    })
    sh(me, 'commit', '-q', '--amend', '-m', 'rewritten')
    const error = await repoOps
      .push(me, true, { 'origin/main': sh(me, 'rev-parse', 'origin/main') })
      .catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toMatch(/changed since you last saw it/)
    expect((error as Error).message).toMatch(/protected|declined|rejected/i)
  })
})

describe('delete on remote (PERF-41)', () => {
  it('refuses when the remote branch moved since the last fetch, else deletes it', async () => {
    const { me, other } = withRemote()
    sh(other, 'switch', '-q', '-c', 'feature')
    commitFile(other, 'f.txt', 'f\n')
    sh(other, 'push', '-q', '-u', 'origin', 'feature')
    sh(me, 'fetch', '-q')
    commitFile(other, 'g.txt', 'g\n')
    sh(other, 'push', '-q') // after my last fetch

    await expect(repoOps.deleteRemoteBranch(me, 'origin/feature')).rejects.toThrow(/new commits/)
    expect(sh(me, 'ls-remote', 'origin', 'refs/heads/feature')).not.toBe('')

    sh(me, 'fetch', '-q')
    await repoOps.deleteRemoteBranch(me, 'origin/feature', sh(me, 'rev-parse', 'origin/feature'))
    expect(sh(me, 'ls-remote', 'origin', 'refs/heads/feature')).toBe('')
  })

  it('forgets our copy when the branch is already gone on the remote', async () => {
    const { me, other } = withRemote()
    sh(other, 'push', '-q', 'origin', 'HEAD:refs/heads/gone')
    sh(me, 'fetch', '-q')
    sh(other, 'push', '-q', 'origin', ':refs/heads/gone')
    await repoOps.deleteRemoteBranch(me, 'origin/gone')
    expect(sh(me, 'branch', '-r')).not.toContain('origin/gone')
  })
})

describe('paths from the UI (SEC-03, SEC-22)', () => {
  it('diff of an untracked file only reads files of the working copy', async () => {
    const dir = newRepo()
    const outside = join(root, `outside${counter++}`)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    const untracked = (path: string): Promise<string> =>
      repoOps.diff(dir, { kind: 'unstaged', file: { path, kind: '?' } })
    expect(await untracked('new.txt')).toContain('+new')
    for (const p of ['../' + outside.split(/[\\/]/).pop() + '/secret.txt', join(outside, 'x')])
      await expect(untracked(p)).rejects.toThrow(/Invalid file path/)
    linkFolder(outside, join(dir, 'linked'))
    await expect(untracked('linked/secret.txt')).rejects.toThrow(/leads outside the repository/)
    await expect(
      repoOps.diff(dir, { kind: 'staged', file: { path: '../x', kind: 'M' } })
    ).rejects.toThrow(/Invalid file path/)
  })

  it('diffs committed names any OS allows (":", a trailing dot) in history', async () => {
    const dir = newRepo()
    const parent = sh(dir, 'rev-parse', 'HEAD')
    const blob = sh(dir, 'rev-parse', 'HEAD:a.txt')
    const tree = execFileSync('git', ['mktree'], {
      cwd: dir,
      encoding: 'utf8',
      input: `100644 blob ${blob}\tnotes:v1.txt\n100644 blob ${blob}\ttrail.\n`
    }).trim()
    const sha = sh(dir, 'commit-tree', tree, '-p', parent, '-m', 'from another OS')
    for (const path of ['notes:v1.txt', 'trail.']) {
      const target = { kind: 'commit' as const, sha, parent, file: { path, kind: 'A' as const } }
      expect(await repoOps.diff(dir, target)).toContain('+a')
    }
    const compare = { kind: 'compare' as const, from: parent, to: sha, threeDot: false }
    expect(await repoOps.diff(dir, { ...compare, file: { path: 'trail.', kind: 'A' } })).toContain(
      '+a'
    )
    for (const path of ['../x', '/etc/x', 'C:/x', 'a\0b'])
      await expect(
        repoOps.diff(dir, { kind: 'commit', sha, parent, file: { path, kind: 'A' } })
      ).rejects.toThrow(/Invalid file path/)
  })

  it('discard, stage and hunk discard refuse files behind a folder link leading out', async () => {
    const dir = newRepo()
    const outside = join(root, `outside${counter++}`)
    mkdirSync(join(dir, 'sub'))
    commitFile(dir, 'sub/a.txt', 'tracked\n')
    mkdirSync(outside)
    writeFileSync(join(outside, 'a.txt'), 'precious\n')
    writeFileSync(join(outside, 'extra.txt'), 'precious\n')
    rmSync(join(dir, 'sub'), { recursive: true })
    linkFolder(outside, join(dir, 'sub'))

    const files = [
      { path: 'sub/a.txt', kind: 'M' as const },
      { path: 'sub/extra.txt', kind: '?' as const }
    ]
    await expect(repoOps.discard(dir, files)).rejects.toThrow(/leads outside the repository/)
    await expect(repoOps.stage(dir, ['sub/a.txt'])).rejects.toThrow(/leads outside the repository/)
    const patch =
      'diff --git a/sub/a.txt b/sub/a.txt\n--- a/sub/a.txt\n+++ b/sub/a.txt\n' +
      '@@ -1 +1 @@\n-tracked\n+precious\n'
    await expect(repoOps.applyPatch(dir, patch, { cached: false, reverse: true })).rejects.toThrow(
      /leads outside the repository/
    )
    expect(existsSync(join(outside, 'extra.txt'))).toBe(true)
    expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('precious\n')
  })

  it('discards files of the working copy as before', async () => {
    const dir = newRepo()
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    writeFileSync(join(dir, 'junk.txt'), 'junk\n')
    await repoOps.discard(dir, [
      { path: 'a.txt', kind: 'M' },
      { path: 'junk.txt', kind: '?' }
    ])
    expect(sh(dir, 'status', '--porcelain')).toBe('')
  })

  it('lists the paths a patch touches, renames included', () => {
    expect(repoOps.parseNumstatPaths('1\t0\td/new\x001\t1\tx.txt\0')).toEqual(['d/new', 'x.txt'])
    expect(repoOps.parseNumstatPaths('0\t0\t\0old name\0new name\0-\t-\tbin.png\0')).toEqual([
      'old name',
      'new name',
      'bin.png'
    ])
  })
})

describe('undo (PERF-13, PERF-53)', () => {
  const commitTracked = (dir: string, file: string, extra?: () => void): Promise<void> =>
    undoOps.track(dir, undoOps.actions.commit(false), async () => {
      writeFileSync(join(dir, file), file)
      sh(dir, 'add', '--', file)
      await repoOps.commit(dir, `add ${file}`, false)
      extra?.()
    })

  it('undoes a commit, and refuses once something else committed since', async () => {
    const dir = newRepo()
    const base = sh(dir, 'rev-parse', 'HEAD')
    await commitTracked(dir, 'b.txt')
    expect((await undoOps.undoInfo(dir))?.label).toContain('add b.txt')
    await undoOps.undo(dir)
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(base)
    await expect(undoOps.undo(dir)).rejects.toThrow(/Nothing to undo/)

    await commitTracked(dir, 'c.txt')
    commitFile(dir, 'd.txt', 'terminal\n') // a commit made in a terminal
    await expect(undoOps.undo(dir)).rejects.toThrow(/changed since/)
    expect(await undoOps.undoInfo(dir)).toBeNull()
  })

  it('undoes the very first commit back to "no commits yet"', async () => {
    const dir = join(root, `empty${counter++}`)
    mkdirSync(dir)
    sh(dir, 'init', '-q', '-b', 'main')
    sh(dir, 'config', 'user.name', 'Test')
    sh(dir, 'config', 'user.email', 'test@example.com')
    await commitTracked(dir, 'first.txt')
    await undoOps.undo(dir)
    expect(() => sh(dir, 'rev-parse', '--verify', '-q', 'HEAD')).toThrow()
    expect(sh(dir, 'status', '--porcelain')).toBe('A  first.txt') // kept, staged
  }, 20000)

  it('refuses to undo a rename once the old name exists again', async () => {
    const dir = newRepo()
    sh(dir, 'branch', 'old')
    await undoOps.track(dir, undoOps.actions.rename('old', 'new'), () =>
      repoOps.renameBranch(dir, 'old', 'new')
    )
    sh(dir, 'branch', 'old')
    await expect(undoOps.undo(dir)).rejects.toThrow(/changed since/)
    expect(sh(dir, 'branch', '--list', 'new')).toContain('new')
  })

  it('makes a merge finished in a terminal undoable', async () => {
    const dir = newRepo()
    sh(dir, 'switch', '-q', '-c', 'side')
    commitFile(dir, 'a.txt', 'side\n')
    sh(dir, 'switch', '-q', 'main')
    const base = commitFile(dir, 'a.txt', 'main\n')
    await expect(
      undoOps.track(dir, undoOps.actions.history('Undo merge of side'), () =>
        repoOps.merge(dir, 'side')
      )
    ).rejects.toThrow(/conflicts/)
    expect(await undoOps.undoInfo(dir)).toBeNull() // in progress: Abort is the way back
    writeFileSync(join(dir, 'a.txt'), 'both\n')
    sh(dir, 'add', 'a.txt')
    sh(dir, 'commit', '-q', '--no-edit') // concluded in a terminal
    expect((await undoOps.undoInfo(dir))?.label).toBe('Undo merge of side')
    await undoOps.undo(dir)
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(base)
  })

  it('keeps the record after a failed undo, so it can be retried', async () => {
    const dir = newRepo()
    const base = sh(dir, 'rev-parse', 'HEAD')
    await undoOps.track(dir, undoOps.actions.history('Undo change'), async () => {
      commitFile(dir, 'a.txt', 'changed\n')
    })
    writeFileSync(join(dir, 'a.txt'), 'local edit\n') // reset --keep refuses to lose it
    await expect(undoOps.undo(dir)).rejects.toThrow()
    expect((await undoOps.undoInfo(dir))?.label).toBe('Undo change')
    sh(dir, 'checkout', '--', 'a.txt')
    await undoOps.undo(dir)
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(base)
  })

  it('leaves alone a branch another worktree committed to meanwhile', async () => {
    const dir = newRepo()
    const base = sh(dir, 'rev-parse', 'HEAD')
    const wt = join(root, `wt${counter++}`)
    sh(dir, 'worktree', 'add', '-q', '-b', 'agent/x', wt)
    const agentFirst = commitFile(wt, 'agent1.txt', 'agent 1\n')
    let agentSecond = ''
    await commitTracked(dir, 'mine.txt', () => {
      agentSecond = commitFile(wt, 'agent2.txt', 'agent 2\n') // during the action
    })
    expect(agentSecond).not.toBe(agentFirst)
    await undoOps.undo(dir)
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(base)
    expect(sh(dir, 'rev-parse', 'refs/heads/agent/x')).toBe(agentSecond)
    expect(sh(wt, 'status', '--porcelain')).toBe('')
  })

  it('reads the branches of other worktrees', () => {
    const porcelain =
      'worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /w\nHEAD 2\nbranch refs/heads/agent/x\n\n' +
      'worktree /d\nHEAD 3\ndetached\n'
    expect([...undoOps.worktreeBranches(porcelain, 'refs/heads/main')]).toEqual([
      'refs/heads/agent/x'
    ])
  })
})

describe('worktree removal (PERF-02)', () => {
  it('keeps the targets of folder links inside the removed worktree', async () => {
    const dir = newRepo()
    writeFileSync(join(dir, '.gitignore'), NODE_MODULES_IGNORED)
    sh(dir, 'add', '.gitignore')
    sh(dir, 'commit', '-q', '-m', 'ignore')
    const wt = join(root, `wt${counter++}`)
    sh(dir, 'worktree', 'add', '-q', '-b', 'w', wt)
    const shared = join(root, `shared${counter++}`)
    mkdirSync(join(shared, 'pkg'), { recursive: true })
    writeFileSync(join(shared, 'pkg', 'index.js'), 'keep me\n')
    linkFolder(shared, join(wt, 'node_modules')) // ignored: no change reported

    expect(await worktrees.folderLinks(wt)).toEqual(['node_modules'])
    await worktrees.removeWorktree(dir, wt, false)
    expect(existsSync(wt)).toBe(false)
    expect(existsSync(join(shared, 'pkg', 'index.js'))).toBe(true)
    expect(sh(dir, 'worktree', 'list', '--porcelain')).not.toContain('branch refs/heads/w\n')
  }, 20000)

  it('only looks for links leading out of the worktree (pnpm links inside stay)', async () => {
    const wt = mkdtempSync(join(root, 'tree-'))
    mkdirSync(join(wt, 'node_modules', '.pnpm', 'pkg'), { recursive: true })
    linkFolder(join(wt, 'node_modules', '.pnpm', 'pkg'), join(wt, 'node_modules', 'pkg'))
    const shared = mkdtempSync(join(root, 'shared-'))
    linkFolder(shared, join(wt, 'outside'))
    expect(await worktrees.folderLinks(wt)).toEqual(['node_modules/pkg', 'outside'])
    expect(await worktrees.folderLinks(wt, { outsideOnly: true })).toEqual(['outside'])
  })

  it('also with Remove anyway, for a link git reports as a change', async () => {
    const dir = newRepo()
    const wt = join(root, `wt${counter++}`)
    sh(dir, 'worktree', 'add', '-q', '-b', 'w2', wt)
    const shared = join(root, `shared${counter++}`)
    mkdirSync(shared)
    writeFileSync(join(shared, 'data.txt'), 'keep me\n')
    linkFolder(shared, join(wt, 'data'))
    await expect(worktrees.removeWorktree(dir, wt, false)).rejects.toThrow(/uncommitted change/)
    await worktrees.removeWorktree(dir, wt, true)
    expect(existsSync(wt)).toBe(false)
    expect(existsSync(join(shared, 'data.txt'))).toBe(true)
  }, 20000)

  it('refuses a locked worktree before touching its links', async () => {
    const dir = newRepo()
    writeFileSync(join(dir, '.gitignore'), NODE_MODULES_IGNORED)
    sh(dir, 'add', '.gitignore')
    sh(dir, 'commit', '-q', '-m', 'ignore')
    const wt = join(root, `wt${counter++}`)
    sh(dir, 'worktree', 'add', '-q', '-b', 'w3', wt)
    sh(dir, 'worktree', 'lock', wt)
    const shared = join(root, `shared${counter++}`)
    mkdirSync(shared)
    writeFileSync(join(shared, 'index.js'), 'keep me\n')
    linkFolder(shared, join(wt, 'node_modules'))

    await expect(worktrees.removeWorktree(dir, wt, false)).rejects.toThrow(/is locked/)
    expect(existsSync(join(wt, 'node_modules', 'index.js'))).toBe(true) // link kept
    await worktrees.removeWorktree(dir, wt, true)
    expect(existsSync(wt)).toBe(false)
    expect(existsSync(join(shared, 'index.js'))).toBe(true)
  }, 20000)
})
