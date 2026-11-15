// A repository registered under one name of its folder and reached under another (a
// link, a Windows 8.3 short name such as the C:\Users\RUNNER~1 temp folder of CI runners,
// /var for /private/var on macOS), as git reports it: the store, worktrees and the
// watcher must agree that it is the same repository. Everything happens in a temp folder.
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000 }) // several git processes per test

const WINDOWS = process.platform === 'win32'
const root = mkdtempSync(join(tmpdir(), 'gitdesk-paths-registered-'))
let userData = root

vi.mock('electron', () => ({
  app: { getPath: () => userData, isReady: () => false, whenReady: () => new Promise(() => {}) },
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }) },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../src/main/terminal/pty', () => ({ killTerminalsIn: () => {} }))

const store = await import('../../src/main/store')
const worktrees = await import('../../src/main/terminal/worktrees')
const watcher = await import('../../src/main/watcher')
const { findStoredPath, forgetCanonicalPaths } = await import('../../src/main/paths')

afterAll(() => {
  watcher.unwatchAll()
  rmSync(root, { recursive: true, force: true })
})

let counter = 0
beforeEach(() => {
  userData = mkdtempSync(join(root, 'data-'))
  // A fresh, empty state for each test (the store keeps it in memory).
  store.saveState({ ...store.loadState(), repos: [] })
  forgetCanonicalPaths()
})

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

/** A repository with one commit, in a folder with a long name. */
function newRepo(): string {
  const dir = join(root, `Repository Folder ${counter++}`)
  mkdirSync(dir)
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** Another name of a folder: a junction on Windows (no special rights needed), a symlink elsewhere. */
function alias(target: string): string {
  const at = join(root, `alias-${counter++}`)
  symlinkSync(target, at, WINDOWS ? 'junction' : 'dir')
  return at
}

describe('the store', () => {
  it('clones into ~/repos by default, on every system', () => {
    expect(store.DEFAULT_SETTINGS.cloneRoot).toBe(join(homedir(), 'repos'))
  })

  it('registers a repository as the file system names it, once', () => {
    const repo = newRepo()
    const other = alias(repo)
    const state = store.addRepos([other])
    expect(state.repos).toEqual([realpathSync.native(repo)])
    expect(store.addRepos([repo, other]).repos).toHaveLength(1)
  })

  it('finds a registered repository by any name of its folder', () => {
    const repo = newRepo()
    const [stored] = store.addRepos([repo], 'someone').repos
    const other = alias(repo)
    expect(store.requireRepo(other)).toBe(stored)
    expect(store.requireRepo(join(other, '.'))).toBe(stored)
    expect(store.accountFor(other)).toBe('someone')
    store.setTrustRecord(other, 'checked')
    expect(store.trustRecord(stored)).toBe('checked')
    expect(store.trustRecord(repo)).toBe('checked')
  })

  it('never matches a relative path (resolved against the current folder)', () => {
    store.addRepos([process.cwd()])
    expect(() => store.requireRepo('.')).toThrow(/Not a registered repository/)
    expect(() => store.requireRepo('')).toThrow(/Not a registered repository/)
  })

  it('keeps tabs opened under another name of a registered folder', () => {
    const repo = newRepo()
    const state = store.addRepos([repo])
    const other = alias(repo)
    const next = store.saveState({ ...state, openTabs: [other], activeTab: other })
    expect(next.openTabs).toEqual([other])
    expect(next.activeTab).toBe(other)
    expect(store.removeRepo(other).repos).toEqual([])
  })
})

describe('lookups among registered repositories', () => {
  // Stored paths are canonical: a lookup puts the path looked up in canonical form, never
  // each registered one. On the main thread, on every tab switch and git command, one
  // file system call per repository would add up (and hang on an offline network drive).
  const many = (n: number): string[] =>
    Array.from({ length: n }, () => {
      const dir = join(root, `Registered ${counter++}`)
      mkdirSync(dir)
      return dir
    })

  /** Calls of realpathSync.native while `run` runs, with nothing cached before. */
  function fileSystemCalls(run: () => void): number {
    forgetCanonicalPaths()
    const spy = vi.spyOn(fs.realpathSync, 'native')
    try {
      run()
      return spy.mock.calls.length
    } finally {
      spy.mockRestore()
    }
  }

  it('costs the same file system calls with 3 or 60 repositories', () => {
    const counts = [3, 60].map((n) => {
      store.saveState({ ...store.loadState(), repos: [], openTabs: [], workspaces: [] })
      const repos = store.addRepos(many(n), 'someone').repos
      for (const r of repos) store.setTrustRecord(r, 'checked')
      const outside = many(1)[0]
      const other = alias(repos[n - 1])
      return [
        // A tab switch: tabs, the active tab and workspaces all name registered repositories.
        fileSystemCalls(() =>
          store.saveState({
            ...store.loadState(),
            openTabs: repos,
            activeTab: repos[n - 1],
            workspaces: [{ id: 'all', name: 'All', repos }]
          })
        ),
        fileSystemCalls(() => expect(store.requireRepo(repos[n - 1])).toBe(repos[n - 1])),
        // Another name of the last one, and a folder never registered (no early match).
        fileSystemCalls(() => expect(store.requireRepo(other)).toBe(repos[n - 1])),
        fileSystemCalls(() => expect(store.trustRecord(outside)).toBeNull()),
        fileSystemCalls(() => expect(store.accountFor(outside)).toBeNull()),
        fileSystemCalls(() => expect(findStoredPath(repos, outside)).toBeUndefined())
      ]
    })
    expect(counts[0][0]).toBe(0)
    expect(counts[0][1]).toBe(0)
    expect(counts[0][2]).toBeGreaterThan(0) // the spy sees the calls
    expect(counts[1]).toEqual(counts[0])
    for (const c of counts[1]) expect(c).toBeLessThanOrEqual(2)
  })

  it('converts the paths of an older state file once, when loading it', async () => {
    const repo = newRepo()
    const other = alias(repo)
    const real = realpathSync.native(repo)
    userData = mkdtempSync(join(root, 'older-'))
    writeFileSync(
      join(userData, 'gitdesk.json'),
      JSON.stringify({
        repos: [other, repo],
        openTabs: [other],
        activeTab: other,
        repoAccounts: { [other]: 'someone' },
        workspaces: [{ id: 'w', name: 'W', repos: [other, repo] }],
        worktreeParents: {},
        trustedRepos: { [other]: 'checked' }
      })
    )
    vi.resetModules()
    const older = await import('../../src/main/store')
    const state = older.loadState()
    expect(state.repos).toEqual([real])
    expect(state.openTabs).toEqual([real])
    expect(state.activeTab).toBe(real)
    expect(state.repoAccounts).toEqual({ [real]: 'someone' })
    expect(state.workspaces[0].repos).toEqual([real])
    expect(older.trustRecord(real)).toBe('checked')
    older.saveState(state)
    expect(JSON.parse(readFileSync(join(userData, 'gitdesk.json'), 'utf8')).canonicalPaths).toBe(
      true
    )
  })
})

describe('worktrees', () => {
  it('knows the repository and its worktrees by any name of their folders', async () => {
    const main = newRepo()
    const wt = `${main}-wt`
    sh(main, 'worktree', 'add', '-q', '-b', 'side', wt)
    const mainAlias = alias(main)
    const list = await worktrees.listWorktrees(mainAlias, true)
    expect(list.find((w) => w.isCurrent)?.isMain).toBe(true)
    const found = await worktrees.requireWorktree(mainAlias, alias(wt))
    expect(realpathSync.native(found.path)).toBe(realpathSync.native(wt))
    await expect(worktrees.requireWorktree(mainAlias, newRepo())).rejects.toThrow(/Not a worktree/)
  })
})

describe('the watcher', () => {
  it('watches nothing more for a repository opened through a link', async () => {
    const repo = newRepo()
    expect(await watcher.outsideGitDirs(alias(repo))).toEqual([])
  })
})
