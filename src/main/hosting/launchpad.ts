// Launchpad: review requests, my pull requests and my issues across every account.

import type { LaunchpadData, LaunchpadItem } from '../../shared/features/hosting'
import { allAuth } from '../accounts'
import { loadState } from '../store'
import { accountLabel, clientOf, localRepoFor, localRepoIndex, originRef } from './context'
import { cachedPicture, pool } from './http'
import { bitbucketReviewRequests } from './providers/bitbucket'
import type { LaunchpadPart } from './providers/types'
import { trackerIssues } from './trackers'

/** Providers' search APIs are rate limited (GitHub: 30 searches a minute): cache for 2 minutes. */
const TTL_MS = 2 * 60_000
const MAX_BITBUCKET_REPOS = 10
/**
 * Deadlines: one for the accounts and trackers, then one for the pictures, so a server
 * that stalls costs an error entry for its account instead of the whole Launchpad.
 */
const SOURCES_MS = 45_000
const PICTURES_MS = 20_000

let cache: { at: number; data: LaunchpadData } | null = null
let running: Promise<LaunchpadData> | null = null

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** `p`, or a rejection once `until` (ms since epoch) has passed. */
function before<T>(p: Promise<T>, until: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${what} did not answer in time.`)),
      Math.max(0, until - Date.now())
    )
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

async function collect(): Promise<LaunchpadData> {
  const errors: LaunchpadData['errors'] = []
  const parts: LaunchpadPart[] = []
  const accounts = allAuth()
  const until = Date.now() + SOURCES_MS

  const jobs = accounts.map(async (auth) => {
    try {
      parts.push(...(await before(clientOf(auth).launchpad(), until, accountLabel(auth))))
    } catch (e) {
      errors.push({ source: accountLabel(auth), error: message(e) })
    }
  })

  // Bitbucket cannot search review requests across workspaces: look at the repositories here.
  const bitbucket = accounts.filter((a) => a.account.provider === 'bitbucket')
  if (bitbucket.length) {
    const reviewRequests = async (): Promise<LaunchpadPart[]> => {
      const found: LaunchpadPart[] = []
      const refs = await pool(loadState().repos, 8, (r) => originRef(r).catch(() => null))
      const slugs = [
        ...new Set(refs.flatMap((r) => (r?.provider === 'bitbucket' ? [r.slug] : [])))
      ].slice(0, MAX_BITBUCKET_REPOS)
      for (const auth of bitbucket) {
        const config = {
          provider: 'bitbucket' as const,
          host: auth.account.host,
          token: auth.token,
          username: auth.username,
          organization: null,
          accountId: auth.account.id,
          accountLabel: accountLabel(auth)
        }
        await pool(slugs, 3, async (slug) => {
          try {
            found.push(...(await bitbucketReviewRequests(config, slug)))
          } catch {
            /* no access to that repository with this account */
          }
        })
      }
      return found
    }
    jobs.push(
      before(reviewRequests(), until, 'Bitbucket').then(
        (found) => void parts.push(...found),
        (e) => void errors.push({ source: 'Bitbucket', error: message(e) })
      )
    )
  }

  jobs.push(
    before(trackerIssues(), until, 'Jira / Linear').then(
      ({ issues, errors: trackerErrors }) => {
        for (const e of trackerErrors) errors.push({ source: e.split(':')[0], error: e })
        for (const i of issues) {
          parts.push({
            id: `${i.source}:${i.key}:issue`,
            group: 'issue',
            source: i.source as 'jira' | 'linear',
            accountId: null,
            accountLabel: i.source === 'jira' ? 'Jira' : 'Linear',
            host: null,
            repo: i.container,
            number: null,
            key: i.key,
            title: i.title,
            url: i.url,
            author: i.assignee,
            authorAvatar: i.assigneeAvatar,
            updatedAt: i.updatedAt,
            draft: false,
            ci: null,
            review: null,
            state: i.state,
            headRef: null,
            baseRef: null,
            cloneUrl: null
          })
        }
      },
      (e) => void errors.push({ source: 'Issue trackers', error: message(e) })
    )
  )

  await Promise.all(jobs)

  const index = await localRepoIndex()
  const seen = new Set<string>()
  const unique = parts.filter((p) => !seen.has(p.id) && !!seen.add(p.id))
  const picturesUntil = Date.now() + PICTURES_MS
  const picture = async (url: unknown): Promise<string | null> => {
    if (typeof url !== 'string') return null
    if (url.startsWith('data:image/')) return url
    if (Date.now() >= picturesUntil) return null
    return before(cachedPicture(url), picturesUntil, 'picture').catch(() => null)
  }
  const items: LaunchpadItem[] = await pool(unique, 6, async (p) => ({
    ...p,
    authorAvatar: await picture(p.authorAvatar),
    localRepo:
      p.source === 'jira' || p.source === 'linear' ? null : localRepoFor(index, p.host, p.repo)
  }))
  items.sort((a, b) => b.updatedAt - a.updatedAt)
  return { generatedAt: Math.floor(Date.now() / 1000), items, errors }
}

export async function launchpad(refresh: boolean): Promise<LaunchpadData> {
  if (!refresh && cache && Date.now() - cache.at < TTL_MS) return cache.data
  if (running) return running
  running = collect()
  try {
    const data = await running
    cache = { at: Date.now(), data }
    return data
  } finally {
    running = null
  }
}

/** After signing in or out, the next Launchpad read goes to the providers. */
export function forgetLaunchpad(): void {
  cache = null
}
