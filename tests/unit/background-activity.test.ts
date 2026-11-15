// The Activity page's data (src/main/activity.ts) on a temporary repository: bounded
// picture lookups, and commits read again only when refs move. Everything happens in a
// temp folder; nothing goes to the network (avatars and GitHub are mocked).
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })

const h = vi.hoisted(() => ({
  repos: [] as string[],
  lookups: [] as { email: string; sha: string }[][],
  /** Emails whose picture is stored (what identityOf knows). */
  known: new Set<string>(),
  /** Emails looked up lately without finding anything (stored misses: no lookup needed). */
  missed: new Set<string>(),
  logs: 0
}))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, net: {}, shell: {} }))
vi.mock('../../src/main/trust/worktree', () => ({ assertSafeWorkTree: async () => {} }))
vi.mock('../../src/main/store', () => ({
  requireRepo: (p: string) => resolve(p),
  loadState: () => ({ repos: h.repos, settings: { useGravatar: true }, worktreeParents: {} }),
  accountFor: () => null,
  samePath: (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
}))
vi.mock('../../src/main/accounts', () => ({ tokensInOrder: () => [] }))
vi.mock('../../src/main/github', () => ({
  repoActivity: async () => []
}))
vi.mock('../../src/main/avatars', () => ({
  GITHUB_COM_SCOPE: 'github.com',
  identityOf: (email: string) => ({ login: null, avatar: h.known.has(email) ? 'data:' : null }),
  needsLookup: (email: string) => !h.known.has(email) && !h.missed.has(email),
  loginAvatars: async () => ({}),
  resolveAvatars: async (authors: { email: string; sha: string }[]) => {
    h.lookups.push(authors)
    return {}
  }
}))
vi.mock('../../src/main/repo', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/repo')>()
  return {
    ...real,
    activityCommits: async (repo: string, since: number) => {
      h.logs++
      return real.activityCommits(repo, since)
    }
  }
})

const activity = await import('../../src/main/activity')

const root = mkdtempSync(join(tmpdir(), 'gitdesk-activity-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A repository with `authors` distinct authors; author k makes k % 3 + 1 commits. */
function repoWithAuthors(name: string, authors: number, prefix = 'a'): string {
  const dir = join(root, name)
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  const now = Math.floor(Date.now() / 1000)
  let stream = ''
  let mark = 0
  for (let k = 0; k < authors; k++) {
    for (let c = 0; c <= k % 3; c++) {
      const msg = `commit ${k}.${c}`
      const who = `Author ${k} <${prefix}${k}@example.com> ${now - mark} +0000`
      stream += `commit refs/heads/main\nmark :${++mark}\nauthor ${who}\ncommitter ${who}\n`
      stream += `data ${Buffer.byteLength(msg)}\n${msg}\n`
      if (mark > 1) stream += `from :${mark - 1}\n`
      stream += '\n'
    }
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: stream })
  return dir
}

describe('authorsByActivity', () => {
  it('orders emails by commit count', () => {
    const c = (email: string, sha: string) =>
      ({ repo: 'r', sha, email, author: '', time: 0, subject: '', merge: false }) as const
    expect(
      activity.authorsByActivity([c('a', '1'), c('b', '2'), c('b', '3'), c('c', '4'), c('b', '5')])
    ).toEqual([
      { email: 'b', sha: '2' },
      { email: 'a', sha: '1' },
      { email: 'c', sha: '4' }
    ])
  })
})

describe('activity payload (compactActivity / expandActivity)', () => {
  it('sends each repository path once and reads back the same data', async () => {
    const { expandActivity } = await import('../../src/renderer/src/lib/activity')
    const c = (repo: string, sha: string) =>
      ({ repo, sha, email: 'a@x', author: 'A', time: 1, subject: 's', merge: false }) as const
    const data = {
      generatedAt: 5,
      commits: [c('/r/one', '1'), c('/r/two', '2'), c('/r/one', '3')],
      pushes: [],
      identities: {},
      loginAvatars: {},
      pushSources: []
    }
    const payload = activity.compactActivity(data)
    expect(payload.repos).toEqual(['/r/one', '/r/two'])
    expect(payload.commits.map((x) => x.repo)).toEqual([0, 1, 0])
    expect(expandActivity(payload)).toEqual(data)
  })
})

describe('loadActivity', () => {
  const big = repoWithAuthors('many-authors', 700)

  it('looks up at most AVATAR_LOOKUPS pictures, the most active authors first', async () => {
    h.repos = [big]
    h.lookups.length = 0
    const data = await activity.loadActivity(30)
    const asked = h.lookups.flat()
    expect(asked.length).toBe(activity.AVATAR_LOOKUPS)
    // Authors with 3 commits (k % 3 === 2) come first.
    expect(asked.slice(0, 200).every((a) => Number(a.email.slice(1).split('@')[0]) % 3 === 2)).toBe(
      true
    )
    // Everyone still gets an identity entry (what is already known).
    expect(Object.keys(data.identities).length).toBe(700)
  })

  it('counts only unknown authors toward the budget', async () => {
    // 600 authors with 2 or 3 commits come before every 1-commit author; all are known
    // except three of the least active, who must still be looked up.
    const crowd = repoWithAuthors('known-authors', 900, 'c')
    const unknown = ['c0@example.com', 'c3@example.com', 'c6@example.com']
    h.repos = [crowd]
    h.known = new Set(Array.from({ length: 900 }, (_, k) => `c${k}@example.com`))
    for (const e of unknown) h.known.delete(e)
    h.lookups.length = 0
    await activity.loadActivity(30)
    const asked = new Set(h.lookups.flat().map((a) => a.email))
    expect(unknown.filter((e) => asked.has(e))).toEqual(unknown)
    h.known = new Set()
  })

  it('does not spend the budget on authors looked up lately without a picture', async () => {
    // 600 more active authors were looked up before and nothing was found (stored misses:
    // resolveAvatars answers them without a download); three were never seen.
    const misses = repoWithAuthors('missed-authors', 900, 'm')
    const fresh = ['m0@example.com', 'm3@example.com', 'm6@example.com']
    h.repos = [misses]
    h.missed = new Set(Array.from({ length: 900 }, (_, k) => `m${k}@example.com`))
    for (const e of fresh) h.missed.delete(e)
    h.lookups.length = 0
    await activity.loadActivity(30)
    const asked = new Set(h.lookups.flat().map((a) => a.email))
    expect(fresh.filter((e) => asked.has(e))).toEqual(fresh)
    h.missed = new Set()
  })

  it('reads the commits again only when refs moved', async () => {
    h.repos = [big]
    const first = await activity.loadActivity(30)
    const before = h.logs
    const second = await activity.loadActivity(30)
    expect(h.logs).toBe(before) // cached by the first load
    expect(second.commits.length).toBe(first.commits.length)
    execFileSync('git', ['branch', 'other'], { cwd: big })
    await activity.loadActivity(30)
    expect(h.logs).toBe(before + 1)
    // A much older start (a wider window) is read again too.
    await activity.loadActivity(90)
    expect(h.logs).toBe(before + 2)
  })
})
