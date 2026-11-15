// The repository watcher (src/main/watcher.ts) on temporary repositories: what notifies,
// what does not, and how often. Everything happens in a temp folder.
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000 })

const sent: { repo: string; at: number }[] = []
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (_c: string, repo: string) => sent.push({ repo, at: Date.now() }) } }
    ]
  }
}))

const watcher = await import('../../src/main/watcher')

const root = mkdtempSync(join(tmpdir(), 'gitdesk-watcher-'))
afterAll(() => {
  watcher.unwatchAll()
  rmSync(root, { recursive: true, force: true })
})
afterEach(() => watcher.unwatchAll())

let counter = 0
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

/** A repository that ignores dist/, out/ and *.log, with a file force-added inside dist/. */
function newRepo(): string {
  const dir = join(root, `r${counter++}`)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, '.gitignore'), 'dist/\nout/\n*.log\n')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  writeFileSync(join(dir, 'dist', 'kept.js'), 'kept\n')
  sh(dir, 'add', '.gitignore', 'a.txt')
  sh(dir, 'add', '-f', 'dist/kept.js')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

const notified = (repo: string): number => sent.filter((s) => s.repo === repo).length

/** Waits until `ready()` holds (git and the worker are slow on a busy machine), at most `ms`. */
async function until(ready: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!ready() && Date.now() < end) await sleep(50)
}

/** Waits until no notification arrived for a while (the last burst and its git checks are done). */
async function settle(repo: string): Promise<void> {
  for (let seen = -1; seen !== notified(repo);) {
    seen = notified(repo)
    await sleep(watcher.QUIET_MS + 800)
  }
}

/**
 * Watches `repo` once the worker really does: rewriting .gitignore (same content) always
 * notifies, so it is rewritten until a notification comes. Then waits for the burst to settle.
 */
async function watch(repo: string): Promise<void> {
  watcher.watchRepo(repo)
  const ignore = join(repo, '.gitignore')
  const content = readFileSync(ignore)
  for (let i = 0; i < 100 && !notified(repo); i++) {
    writeFileSync(ignore, content)
    await sleep(100)
  }
  expect(notified(repo), 'the watcher never reported a change').toBeGreaterThan(0)
  await settle(repo)
  sent.length = 0
}

describe('mayChangeView', () => {
  const repo = newRepo()

  it('drops files git ignores', async () => {
    expect(await watcher.mayChangeView(repo, ['dist/bundle.js', 'app.log', 'dist/sub/'])).toBe(
      false
    )
    expect(await watcher.mayChangeView(repo, [])).toBe(false)
  })

  it('keeps tracked files (even under an ignore pattern), new files and git state', async () => {
    expect(await watcher.mayChangeView(repo, ['dist/kept.js'])).toBe(true)
    expect(await watcher.mayChangeView(repo, ['dist/'])).toBe(true) // holds a tracked file
    expect(await watcher.mayChangeView(repo, ['app.log', 'src/new.ts'])).toBe(true)
    expect(await watcher.mayChangeView(repo, ['a.txt'])).toBe(true)
    expect(await watcher.mayChangeView(repo, ['.git/HEAD'])).toBe(true)
    expect(await watcher.mayChangeView(repo, ['sub/.gitignore'])).toBe(true)
  })

  it('refreshes when a name cannot be checked', async () => {
    expect(await watcher.mayChangeView(repo, ['../outside.txt'])).toBe(true)
  })
})

describe('viewFingerprint', () => {
  it('changes with what a refresh would show, not with ignored files', async () => {
    const repo = newRepo()
    const first = await watcher.viewFingerprint(repo)
    writeFileSync(join(repo, 'dist', 'bundle.js'), 'x')
    writeFileSync(join(repo, 'app.log'), 'x')
    expect(await watcher.viewFingerprint(repo)).toBe(first)
    writeFileSync(join(repo, 'a.txt'), 'edited\n')
    const edited = await watcher.viewFingerprint(repo)
    expect(edited).not.toBe(first)
    // Edited again: same status, but the diff would differ.
    await sleep(20)
    writeFileSync(join(repo, 'a.txt'), 'edited again, longer\n')
    expect(await watcher.viewFingerprint(repo)).not.toBe(edited)
    const again = await watcher.viewFingerprint(repo)
    sh(repo, 'branch', 'other')
    expect(await watcher.viewFingerprint(repo)).not.toBe(again)
  })
})

describe('outsideGitDirs', () => {
  it('is empty for a normal repository and lists HEAD, index and refs of a worktree', async () => {
    const main = newRepo()
    expect(await watcher.outsideGitDirs(main)).toEqual([])
    const wt = `${main}-wt`
    sh(main, 'worktree', 'add', '-q', '-b', 'side', wt)
    const targets = await watcher.outsideGitDirs(wt)
    // git names them as the file system does: the temp folder may be a short name or a link.
    const real = (p: string): string => realpathSync.native(resolve(p)).toLowerCase()
    const dirs = targets.map((t) => real(t.dir))
    expect(dirs).toContain(real(join(main, '.git', 'worktrees', basename(wt))))
    expect(dirs).toContain(real(join(main, '.git', 'refs')))
    expect(targets.find((t) => t.only)?.only).toEqual(['packed-refs', 'config'])
  })
})

describe('watchRepo', () => {
  it('notifies once for a tracked edit', async () => {
    const repo = newRepo()
    await watch(repo)
    writeFileSync(join(repo, 'a.txt'), 'edited\n')
    await until(() => notified(repo) > 0)
    await sleep(watcher.QUIET_MS + 1000)
    expect(notified(repo)).toBe(1)
  })

  it('ignores ignored files, node_modules and git internals', async () => {
    const repo = newRepo()
    await watch(repo)
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(repo, 'app.log'), `line ${i}\n`, { flag: 'a' })
      writeFileSync(join(repo, 'dist', `chunk${i}.js`), 'x')
      mkdirSync(join(repo, 'node_modules', `p${i}`), { recursive: true })
      writeFileSync(join(repo, 'node_modules', `p${i}`, 'index.js'), 'x')
      writeFileSync(join(repo, '.git', 'FETCH_HEAD'), `${i}\n`)
      await sleep(150)
    }
    await sleep(1500)
    expect(notified(repo)).toBe(0)
  })

  it('ignores an ignored folder that is deleted', async () => {
    const repo = newRepo()
    mkdirSync(join(repo, 'out', 'old'), { recursive: true })
    writeFileSync(join(repo, 'out', 'old', 'a.js'), 'x')
    await watch(repo)
    // Built while watched, then cleaned (with a folder that was there before).
    mkdirSync(join(repo, 'out', 'sub'), { recursive: true })
    for (let i = 0; i < 20; i++) writeFileSync(join(repo, 'out', 'sub', `f${i}.js`), 'x')
    await sleep(800)
    rmSync(join(repo, 'out'), { recursive: true, force: true })
    await sleep(1500)
    expect(notified(repo)).toBe(0)
  })

  it('compares fingerprints, not names, when a burst has too many to check', async () => {
    const repo = newRepo()
    await watch(repo)
    // The first burst with lost names has nothing to compare with.
    watcher.reported(repo, [], true)
    await until(() => notified(repo) > 0)
    await settle(repo)
    sent.length = 0
    const names = Array.from({ length: 25_000 }, (_, i) => `dist/chunk${i}.js`)
    for (let i = 0; i < names.length; i += 5000) {
      watcher.reported(repo, names.slice(i, i + 5000))
      await sleep(50)
    }
    await sleep(watcher.QUIET_MS + 1000)
    expect(notified(repo)).toBe(0)
    // A real change in such a burst still notifies.
    writeFileSync(join(repo, 'a.txt'), 'edited\n')
    watcher.reported(repo, names)
    await until(() => notified(repo) > 0)
    expect(notified(repo)).toBeGreaterThanOrEqual(1)
  })

  it('still notifies while another file keeps changing (max wait)', async () => {
    const repo = newRepo()
    await watch(repo)
    const start = Date.now()
    let edited = 0
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(repo, 'app.log'), `line ${i}\n`, { flag: 'a' })
      if (i === 3) {
        writeFileSync(join(repo, 'a.txt'), 'edited\n')
        edited = Date.now()
      }
      await sleep(100)
    }
    const first = sent.find((s) => s.repo === repo)
    expect(first).toBeDefined()
    // Well before the writer stops (3 s): within the max wait plus the check.
    expect(first!.at - edited).toBeLessThan(watcher.MAX_WAIT_MS + 1000)
    expect(first!.at - start).toBeLessThan(2900)
  })

  it('notifies a linked worktree for a commit made in it', async () => {
    const main = newRepo()
    const wt = `${main}-wt`
    sh(main, 'worktree', 'add', '-q', '-b', 'side', wt)
    await watch(wt)
    sh(wt, 'commit', '-q', '--allow-empty', '-m', 'from the worktree')
    await until(() => notified(wt) > 0)
    expect(notified(wt)).toBeGreaterThanOrEqual(1)
  })

  it('stops notifying after unwatchRepo', async () => {
    const repo = newRepo()
    await watch(repo)
    watcher.unwatchRepo(repo)
    writeFileSync(join(repo, 'a.txt'), 'edited\n')
    await sleep(1200)
    expect(notified(repo)).toBe(0)
  })
})
