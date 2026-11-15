// Sync (src/main/sync.ts) on temporary repositories with local remotes: parallel fetches,
// and the UI told only when something changed. Everything happens in a temp folder.
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPO_CHANGED_CHANNEL, REPOS_SYNCED_CHANNEL } from '../../src/shared/api'

vi.setConfig({ testTimeout: 60_000 })

const sent: { channel: string; repo?: string }[] = []
const state = { repos: [] as string[], repoAccounts: {} as Record<string, string> }
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (channel: string, repo?: string) => sent.push({ channel, repo }) } }
    ]
  }
}))
vi.mock('../../src/main/store', () => ({
  requireRepo: (p: string) => resolve(p),
  loadState: () => ({ ...state, settings: { fetchIntervalMinutes: 0 } }),
  samePath: (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase(),
  accountFor: (p: string) => state.repoAccounts[p] ?? null
}))
vi.mock('../../src/main/trust/worktree', () => ({ assertSafeWorkTree: async () => {} }))
// Fetches at the same time, for repositories with and without a GitDesk account.
const h = vi.hoisted(() => ({
  active: { linked: 0, other: 0 },
  peak: { linked: 0, other: 0 },
  /** Fetches that started, in order. With `holdFirst`, the first one waits for `gate`. */
  started: [] as string[],
  holdFirst: false,
  gate: Promise.resolve()
}))
vi.mock('../../src/main/repo', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/repo')>()
  return {
    ...real,
    fetchAll: async (repo: string) => {
      const kind = state.repoAccounts[repo] ? 'linked' : 'other'
      h.peak[kind] = Math.max(h.peak[kind], ++h.active[kind])
      h.started.push(repo)
      try {
        if (h.holdFirst && h.started.length === 1) await h.gate
        await new Promise((r) => setTimeout(r, 30))
        return await real.fetchAll(repo)
      } finally {
        h.active[kind]--
      }
    }
  }
})

const sync = await import('../../src/main/sync')
const queue = await import('../../src/main/queue')

const root = mkdtempSync(join(tmpdir(), 'gitdesk-sync-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => {
  sent.length = 0
})

let counter = 0
function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

/** An "upstream" repository and a clone of it; returns both. */
function pair(): { upstream: string; clone: string } {
  const n = counter++
  const upstream = join(root, `up${n}`)
  mkdirSync(upstream)
  sh(upstream, 'init', '-q', '-b', 'main')
  writeFileSync(join(upstream, 'a.txt'), 'a\n')
  sh(upstream, 'add', '.')
  sh(upstream, 'commit', '-q', '-m', 'init')
  const clone = join(root, `clone${n}`)
  sh(root, 'clone', '-q', upstream, clone)
  return { upstream, clone }
}

const synced = (): number => sent.filter((s) => s.channel === REPOS_SYNCED_CHANNEL).length
const changed = (): (string | undefined)[] =>
  sent.filter((s) => s.channel === REPO_CHANGED_CHANNEL).map((s) => s.repo)

describe('inPool', () => {
  it('runs every item, never more than the limit at once', async () => {
    let active = 0
    let peak = 0
    const done: number[] = []
    await sync.inPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 10 + (n % 3) * 5))
      done.push(n)
      active--
    })
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(peak).toBe(4)
  })
})

describe('syncAll', () => {
  const pairs = Array.from({ length: 6 }, pair)
  const noRemote = join(root, 'local-only')
  mkdirSync(noRemote)
  sh(noRemote, 'init', '-q', '-b', 'main')

  it('fetches every repository with a remote and reloads the UI once', async () => {
    state.repos = [...pairs.map((p) => p.clone), noRemote]
    state.repoAccounts = {}
    const result = await sync.syncAll(true)
    expect(result).toEqual({ fetched: 6, failed: [] })
    expect(synced()).toBe(1) // "Sync" always reloads after a fetch
    expect(changed()).toEqual([]) // nothing new: no repository view refreshes
  })

  it('fetches account-linked repositories in parallel, the others one at a time', async () => {
    state.repoAccounts = Object.fromEntries(pairs.slice(0, 5).map((p) => [p.clone, 'account']))
    pairs.push(pair(), pair()) // 3 without an account
    state.repos = pairs.map((p) => p.clone)
    h.peak = { linked: 0, other: 0 }
    const result = await sync.syncAll(true)
    expect(result).toEqual({ fetched: 8, failed: [] })
    expect(h.peak.linked).toBe(sync.SYNC_CONCURRENCY)
    expect(h.peak.other).toBe(1) // at most one credential prompt at a time
    pairs.splice(6)
  })

  it('stays quiet in the background when nothing changed', async () => {
    state.repoAccounts = Object.fromEntries(pairs.map((p) => [p.clone, 'account']))
    const result = await sync.syncAll(false)
    expect(result.fetched).toBe(6)
    expect(synced()).toBe(0)
    expect(changed()).toEqual([])
  })

  it('tells the UI which repository got new commits', async () => {
    const { upstream, clone } = pairs[2]
    writeFileSync(join(upstream, 'b.txt'), 'b\n')
    sh(upstream, 'add', '.')
    sh(upstream, 'commit', '-q', '-m', 'new')
    await sync.syncAll(false)
    expect(changed()).toEqual([clone])
    expect(synced()).toBe(1)
  })

  it('reloads when a fetch error appears or goes away, not when it repeats', async () => {
    const broken = pair()
    rmSync(broken.upstream, { recursive: true, force: true })
    state.repos = [broken.clone]
    state.repoAccounts = { [broken.clone]: 'account' }
    const first = await sync.syncAll(false)
    expect(first.failed.map((f) => f.repo)).toEqual([broken.clone])
    expect(sync.fetchError(broken.clone)).toBeTruthy()
    expect(synced()).toBe(1)
    sent.length = 0
    await sync.syncAll(false)
    expect(synced()).toBe(0)
    // Back: the card's error goes away.
    sh(root, 'clone', '-q', '--bare', pairs[0].upstream, broken.upstream)
    sh(broken.clone, 'remote', 'set-url', 'origin', broken.upstream)
    sent.length = 0
    const back = await sync.syncAll(false)
    expect(back.failed).toEqual([])
    expect(sync.fetchError(broken.clone)).toBeNull()
    expect(synced()).toBe(1)
  })
})

describe('sync and the write queue', () => {
  it("a repository waiting for its turn does not hold up that repository's writes", async () => {
    const clones = [pair(), pair(), pair()].map((p) => p.clone)
    state.repos = clones
    state.repoAccounts = {} // no account: their fetches take turns
    let open = (): void => undefined
    h.gate = new Promise<void>((r) => (open = r))
    h.holdFirst = true
    h.started = []
    const running = sync.syncAll(true)
    try {
      // The first fetch to start is held open (as by a credential prompt); the others
      // wait for their turn (given time to get there: their ref snapshots come first).
      for (let i = 0; i < 200 && !h.started.length; i++) await new Promise((r) => setTimeout(r, 25))
      await new Promise((r) => setTimeout(r, 1000))
      expect(h.started).toHaveLength(1)
      const waiting = clones.find((c) => c !== h.started[0])!
      const write = queue.exclusive(waiting, async () => 'written')
      const timeout = new Promise((r) => setTimeout(() => r('blocked'), 3000))
      expect(await Promise.race([write, timeout])).toBe('written')
    } finally {
      open()
      h.holdFirst = false
    }
    expect((await running).fetched).toBe(3)
  })
})

describe('fetchRepo', () => {
  it('tells other views only when refs moved or the fetch failed', async () => {
    const { upstream, clone } = pair()
    state.repos = [clone]
    await sync.fetchRepo(clone)
    expect(changed()).toEqual([])
    writeFileSync(join(upstream, 'c.txt'), 'c\n')
    sh(upstream, 'add', '.')
    sh(upstream, 'commit', '-q', '-m', 'more')
    await sync.fetchRepo(clone)
    expect(changed()).toEqual([clone])
    sent.length = 0
    rmSync(upstream, { recursive: true, force: true })
    await expect(sync.fetchRepo(clone)).rejects.toThrow()
    expect(changed()).toEqual([clone])
  })
})
