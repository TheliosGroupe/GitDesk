import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AvatarMap } from '../shared/types'
import { downloadImage } from './accounts'
import { commitAuthor, recentAuthors, type GitHubIdentity } from './github'

interface Entry {
  data: string | null
  /** When we last looked (ms). Misses are retried after a week. */
  checked: number
  /** The lookup went through GitHub with an account that could read the repository. */
  githubChecked?: boolean
  /** GitHub login of this email; undefined = looked up before logins were recorded. */
  login?: string | null
  /**
   * Gravatar was asked (or could have been: the setting was on). false: looked up with
   * Gravatar turned off, so turning it on looks again. undefined: recorded before this
   * was kept (Gravatar was on by default), taken as asked.
   */
  gravatarChecked?: boolean
}

const RETRY_MISSES_MS = 7 * 24 * 3600 * 1000
/** Pictures found by login are downloaded again after a month (the user may have changed it). */
const REFRESH_LOGIN_PICTURES_MS = 30 * 24 * 3600 * 1000
/** Where logins of loginAvatars come from unless told otherwise. */
export const GITHUB_COM_SCOPE = 'github:github.com'
// Per-author API calls; anonymous requests are limited to 60 an hour by GitHub.
const MAX_COMMIT_LOOKUPS = { signedIn: 60, anonymous: 10 }

let cache: Record<string, Entry> | null = null
let saveTimer: NodeJS.Timeout | null = null
/** "owner/repo|email" already retried in this session, so a failing lookup is not repeated on every refresh. */
const retried = new Set<string>()

function file(): string {
  return join(app.getPath('userData'), 'avatars.json')
}

function load(): Record<string, Entry> {
  if (cache) return cache
  let raw: unknown
  try {
    raw = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {}
  } catch {
    raw = {}
  }
  cache = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw))
    for (const [key, e] of Object.entries(raw as Record<string, Entry>)) {
      // "@login" entries written before logins were scoped by provider and host: the
      // login could belong to anyone on another service, so they are looked up again.
      if (key.startsWith('@') && !key.includes('/')) continue
      if (!e || typeof e !== 'object' || typeof e.checked !== 'number') continue
      const data = typeof e.data === 'string' && e.data.startsWith('data:image/') ? e.data : null
      cache[key] = { ...e, data }
    }
  return cache
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const tmp = file() + '.tmp'
    writeFileSync(tmp, JSON.stringify(load()))
    renameSync(tmp, file())
  }, 1000)
}

const sized = (url: string): string => `${url}${url.includes('?') ? '&' : '?'}s=64`

/** GitHub's private "noreply" addresses encode the user, no API call needed. */
function noreplyIdentity(email: string): GitHubIdentity | null {
  const withId = /^(\d+)\+([^@]+)@users\.noreply\.github\.com$/.exec(email)
  if (withId) {
    return {
      login: withId[2],
      avatarUrl: `https://avatars.githubusercontent.com/u/${withId[1]}?s=64`
    }
  }
  const loginOnly = /^([\w-]+)@users\.noreply\.github\.com$/.exec(email)
  return loginOnly
    ? { login: loginOnly[1], avatarUrl: `https://github.com/${loginOnly[1]}.png?size=64` }
    : null
}

function gravatar(email: string): string {
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
  return `https://gravatar.com/avatar/${hash}?s=64&d=404`
}

function download(url: string): Promise<string | null> {
  return downloadImage(url.includes('avatars.githubusercontent.com') ? sized(url) : url)
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift()!)
    })
  )
}

/** After signing in, everything not found so far deserves a new look. */
export function forgetMisses(): void {
  const store = load()
  for (const [email, entry] of Object.entries(store)) if (entry.data === null) delete store[email]
  retried.clear()
  scheduleSave()
}

export interface AvatarSource {
  /** "owner/repo" when the repository is on GitHub. */
  slug: string | null
  /** Tokens to try for GitHub API calls, best first. */
  tokens: string[]
  useGravatar: boolean
}

/** What is stored for `email` is good enough for `source`: no lookup (no download) needed. */
function fresh(store: Record<string, Entry>, email: string, source: AvatarSource): boolean {
  const e = store[email]
  if (!e) return false
  // Recorded without access to the repository on GitHub (for example before
  // signing in to a private repository), or before logins were kept: look again.
  const canAskGitHub = !!source.slug && source.tokens.length > 0
  const incomplete = !e.githubChecked || e.login === undefined
  if (canAskGitHub && incomplete && !retried.has(`${source.slug}|${email}`)) return false
  if (e.data !== null) return true
  // A miss recorded with Gravatar off: Gravatar is now on, so it may have a picture.
  if (source.useGravatar && e.gravatarChecked === false && !retried.has(`${source.slug}|${email}`))
    return false
  return Date.now() - e.checked < RETRY_MISSES_MS
}

/**
 * Whether resolveAvatars would look `email` up (and so may download something) for
 * `source`, rather than answer from what is stored. The Activity page counts only these
 * toward its lookup budget.
 */
export function needsLookup(email: string, source: AvatarSource): boolean {
  return !fresh(load(), email.trim().toLowerCase(), source)
}

export async function resolveAvatars(
  authors: { email: string; sha: string }[],
  source: AvatarSource
): Promise<AvatarMap> {
  const store = load()
  const now = Date.now()
  const wanted = new Map<string, string>()
  for (const a of authors) {
    const email = a.email.trim().toLowerCase()
    if (email && !wanted.has(email)) wanted.set(email, a.sha)
  }
  const todo = [...wanted.keys()].filter((email) => !fresh(store, email, source))
  for (const email of todo) retried.add(`${source.slug}|${email}`)

  if (todo.length) {
    // Recent commits first: one API call usually covers most authors.
    let recent = new Map<string, GitHubIdentity>()
    let token: string | null = null
    if (source.slug) {
      for (const t of [...source.tokens, null]) {
        try {
          recent = await recentAuthors(source.slug, t)
          token = t
          break
        } catch {
          /* no access with this token: try the next one */
        }
      }
    }
    let lookups = 0
    await pool(todo, 4, async (email) => {
      let who = noreplyIdentity(email) ?? recent.get(email) ?? null
      if (!who && source.slug && lookups < MAX_COMMIT_LOOKUPS[token ? 'signedIn' : 'anonymous']) {
        lookups++
        who = await commitAuthor(source.slug, wanted.get(email)!, token).catch(() => null)
      }
      let data = who ? await download(who.avatarUrl) : null
      if (!data && source.useGravatar) data = await downloadImage(gravatar(email))
      const previous = store[email]
      store[email] = {
        data: data ?? previous?.data ?? null,
        checked: now,
        githubChecked: !!source.slug && token !== null,
        login: who?.login ?? previous?.login ?? null,
        gravatarChecked:
          source.useGravatar || (previous !== undefined && previous.gravatarChecked !== false)
      }
    })
    scheduleSave()
  }

  const result: AvatarMap = {}
  for (const email of wanted.keys()) result[email] = store[email]?.data ?? null
  return result
}

/** GitHub login and picture known for an email (after resolveAvatars). */
export function identityOf(email: string): { login: string | null; avatar: string | null } {
  const e = load()[email.trim().toLowerCase()]
  return { login: e?.login ?? null, avatar: e?.data ?? null }
}

/**
 * Pictures of users by login (push authors, pull request authors), cached like emails under
 * "@<scope>/<login>". `scope` names the service ("github:github.com", "gitlab:gitlab.com"…):
 * the same login on two services is two people, and must not share a picture.
 */
export async function loginAvatars(
  users: Map<string, string>,
  scope: string = GITHUB_COM_SCOPE
): Promise<Record<string, string | null>> {
  const store = load()
  const now = Date.now()
  const result: Record<string, string | null> = {}
  await pool([...users], 4, async ([login, url]) => {
    const key = `@${scope.toLowerCase()}/${login.toLowerCase()}`
    const e = store[key]
    const stale =
      e && now - e.checked > (e.data === null ? RETRY_MISSES_MS : REFRESH_LOGIN_PICTURES_MS)
    if (!e || stale) {
      const data = await download(url)
      store[key] = { data: data ?? e?.data ?? null, checked: now, githubChecked: true, login }
    }
    result[login] = store[key].data
  })
  scheduleSave()
  return result
}
