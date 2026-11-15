import { existsSync } from 'fs'
import type {
  ActivityCommit,
  ActivityData,
  ActivityPayload,
  ActivityPush,
  PushKind
} from '../shared/types'
import { tokensInOrder } from './accounts'
import {
  GITHUB_COM_SCOPE,
  identityOf,
  loginAvatars,
  needsLookup,
  resolveAvatars,
  type AvatarSource
} from './avatars'
import { runGit } from './git'
import { repoActivity, type ActivityEvent } from './github'
import { activityCommits, originSlug } from './repo'
import { accountFor, loadState } from './store'

const KINDS: PushKind[] = [
  'push',
  'force_push',
  'branch_creation',
  'branch_deletion',
  'pr_merge',
  'merge_queue_merge'
]

// GitHub activity is cached briefly so switching views does not re-download it.
const CACHE_MS = 3 * 60_000
const eventCache = new Map<string, { at: number; events: ActivityEvent[] }>()

async function githubEvents(
  slug: string,
  tokens: string[],
  sinceMs: number
): Promise<ActivityEvent[]> {
  const cached = eventCache.get(slug)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.events
  let lastError: unknown = null
  for (const token of tokens) {
    try {
      const events = await repoActivity(slug, token, sinceMs)
      eventCache.set(slug, { at: Date.now(), events })
      return events
    } catch (e) {
      lastError = e
    }
  }
  throw lastError ?? new Error('No GitHub account can read this repository.')
}

/** Unknown authors whose picture one Activity load may look up (the most active first). */
export const AVATAR_LOOKUPS = 500

// A repository's commits are read again only when one of its refs (or HEAD) moved, or when
// the window starts more than a day later than the one read: the page filters by date.
const commitCache = new Map<string, { tips: string; sinceSec: number; commits: ActivityCommit[] }>()

export async function cachedActivityCommits(
  repo: string,
  sinceSec: number
): Promise<ActivityCommit[]> {
  const r = await runGit(repo, ['show-ref', '--head'], { okCodes: [0, 1] }).catch(() => null)
  const tips = r?.stdout ?? null
  const cached = commitCache.get(repo)
  if (
    tips !== null &&
    cached?.tips === tips &&
    cached.sinceSec <= sinceSec &&
    sinceSec - cached.sinceSec < 86_400
  ) {
    return cached.commits
  }
  const commits = await activityCommits(repo, sinceSec)
  if (tips !== null) commitCache.set(repo, { tips, sinceSec, commits })
  return commits
}

/** Emails of these commits, the most frequent first. */
export function authorsByActivity(commits: ActivityCommit[]): { email: string; sha: string }[] {
  const seen = new Map<string, { sha: string; count: number }>()
  for (const c of commits) {
    const a = seen.get(c.email)
    if (a) a.count++
    else seen.set(c.email, { sha: c.sha, count: 1 })
  }
  return [...seen]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([email, { sha }]) => ({ email, sha }))
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift()!)
    })
  )
}

/** The payload sent to the UI: repository paths once, commits pointing at them by index. */
export function compactActivity(data: ActivityData): ActivityPayload {
  const repos: string[] = []
  const index = new Map<string, number>()
  const commits = data.commits.map((c) => {
    let i = index.get(c.repo)
    if (i === undefined) {
      i = repos.push(c.repo) - 1
      index.set(c.repo, i)
    }
    return { ...c, repo: i }
  })
  return { ...data, repos, commits }
}

export async function loadActivity(days: number): Promise<ActivityData> {
  const state = loadState()
  const now = Date.now()
  const sinceMs = now - Math.min(Math.max(days, 1), 365) * 86_400_000
  const commits: ActivityCommit[] = []
  const pushes: ActivityPush[] = []
  const identities: ActivityData['identities'] = {}
  const pushSources: ActivityData['pushSources'] = []
  const actors = new Map<string, string>()
  // "slug|email" looked up during this load. Only emails resolveAvatars would really look
  // up (each can cost a download) count toward AVATAR_LOOKUPS: authors already known, or
  // looked up lately without finding anything, are free. So a repository with many such
  // authors does not use up the budget of the next ones.
  const lookedUp = new Set<string>()
  let lookups = 0

  await pool(state.repos, 3, async (repo) => {
    if (!existsSync(repo)) return
    const repoCommits = await cachedActivityCommits(repo, sinceMs / 1000).catch(() => [])
    commits.push(...repoCommits)
    const slug = await originSlug(repo).catch(() => null)
    const tokens = tokensInOrder(accountFor(repo)).map((a) => a.token)

    // Who is behind each email (GitHub login + picture), shared with the commit graph cache.
    const authors = authorsByActivity(repoCommits)
    const key = (email: string): string => `${slug ?? ''}|${email}`
    const source: AvatarSource = { slug, tokens, useGravatar: state.settings.useGravatar }
    const asked: typeof authors = []
    for (const a of authors) {
      if (lookedUp.has(key(a.email))) continue
      if (needsLookup(a.email, source)) {
        if (lookups >= AVATAR_LOOKUPS) continue
        lookups++
      }
      lookedUp.add(key(a.email))
      asked.push(a)
    }
    if (asked.length) await resolveAvatars(asked, source).catch(() => undefined)
    for (const { email } of authors) identities[email] = identityOf(email)

    if (!slug) {
      pushSources.push({ repo, github: null, ok: false, error: null })
      return
    }
    if (!tokens.length) {
      pushSources.push({
        repo,
        github: slug,
        ok: false,
        error: 'Sign in with GitHub to see pushes.'
      })
      return
    }
    try {
      for (const e of await githubEvents(slug, tokens, sinceMs)) {
        const time = Date.parse(e.timestamp)
        const kind = e.activity_type as PushKind
        if (time < sinceMs || !KINDS.includes(kind)) continue
        if (e.actor) actors.set(e.actor.login, e.actor.avatar_url)
        pushes.push({
          repo,
          id: `${slug}#${e.id}`,
          actor: e.actor?.login ?? null,
          time: Math.floor(time / 1000),
          branch: e.ref.replace(/^refs\/heads\//, ''),
          kind,
          before: e.before,
          after: e.after
        })
      }
      pushSources.push({ repo, github: slug, ok: true, error: null })
    } catch (e) {
      pushSources.push({
        repo,
        github: slug,
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  })

  for (const repo of commitCache.keys()) if (!state.repos.includes(repo)) commitCache.delete(repo)

  return {
    generatedAt: Math.floor(now / 1000),
    commits: commits.sort((a, b) => b.time - a.time),
    pushes: pushes.sort((a, b) => b.time - a.time),
    identities,
    loginAvatars: await loginAvatars(actors, GITHUB_COM_SCOPE),
    pushSources
  }
}
