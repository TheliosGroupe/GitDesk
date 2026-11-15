// Bitbucket Cloud, REST API 2.0 (Basic auth: email + API token, or user name + app password).
// Answers are checked field by field (validate.ts): a wrong-typed item is skipped.

import type { CiState, HostedRepo, HostingOrg, ReviewState } from '../../../shared/features/hosting'
import { Api, apiOverride, basic, downloadPicture, pool, unix } from '../http'
import {
  bool,
  dotsOnly,
  int,
  link,
  list,
  obj,
  refName,
  repoSlug,
  slugPath,
  str,
  TITLE_MAX,
  userName,
  type Json
} from '../validate'
import type {
  ClientConfig,
  LaunchpadPart,
  ProviderClient,
  ProviderUser,
  PullWithAvatar
} from './types'

const MAX_PAGES = 10
const MAX_DETAILS = 15

export function bitbucketBase(): string {
  return apiOverride('bitbucket.org') ?? 'https://api.bitbucket.org/2.0'
}

/** Clone links carry the user name ("https://me@bitbucket.org/…"): GitDesk sends its own. */
const withoutUser = (url: string): string => url.replace(/^(https:\/\/)[^@/]+@/, '$1')

const href = (links: unknown, name: string): string | null => link(obj(obj(links)[name]).href)

export function mapBitbucketRepo(raw: unknown, account: string): HostedRepo | null {
  const r = obj(raw)
  const fullName = repoSlug(r.full_name)
  if (!fullName || fullName.split('/').length !== 2) return null
  const links = obj(r.links)
  const https = list(links.clone)
    .map(obj)
    .find((l) => l.name === 'https')
  const cloneUrl = link(https?.href)
  return {
    provider: 'bitbucket',
    host: 'bitbucket.org',
    fullName,
    description: str(r.description) || null,
    private: bool(r.is_private),
    fork: !!r.parent,
    pushedAt: str(r.updated_on, 64),
    cloneUrl: cloneUrl ? withoutUser(cloneUrl) : `https://bitbucket.org/${fullName}.git`,
    webUrl: href(links, 'html') ?? `https://bitbucket.org/${fullName}`,
    account
  }
}

/** Name shown for a Bitbucket user (nickname, else display name). */
const personName = (u: Json): string | null => userName(u.nickname) ?? userName(u.display_name)

/** The user of a sign-in answer; throws when it has no usable name. */
export function mapBitbucketUser(raw: unknown): ProviderUser {
  const u = obj(raw)
  const login = userName(u.username) ?? personName(u)
  if (!login) throw new Error('Bitbucket did not say who this token belongs to.')
  return { login, name: userName(u.display_name), avatarUrl: href(u.links, 'avatar') }
}

/** Number, title, URL and branches of a pull request; null when one of the first three is missing. */
function prBasics(raw: unknown): {
  p: Json
  number: number
  title: string
  url: string
  slug: string | null
} | null {
  const p = obj(raw)
  const number = int(p.id)
  const title = str(p.title, TITLE_MAX)
  const slug = repoSlug(obj(obj(p.destination).repository).full_name)
  const url =
    href(p.links, 'html') ??
    (slug && number ? `https://bitbucket.org/${slug}/pull-requests/${number}` : null)
  if (!number || title === null || !url) return null
  return { p, number, title, url, slug }
}

export function mapBitbucketPr(raw: unknown): PullWithAvatar | null {
  const b = prBasics(raw)
  if (!b) return null
  const { p } = b
  const author = obj(p.author)
  const source = obj(p.source)
  return {
    avatarUrl: href(author.links, 'avatar'),
    // Two people may share a nickname: their pictures are kept apart by account.
    pictureKey: userName(author.uuid) ?? userName(author.account_id),
    pull: {
      number: b.number,
      title: b.title,
      author: personName(author),
      authorAvatar: null,
      draft: bool(p.draft),
      headRef: refName(obj(source.branch).name) ?? '',
      headRepo: repoSlug(obj(source.repository).full_name),
      baseRef: refName(obj(obj(p.destination).branch).name) ?? '',
      url: b.url,
      updatedAt: unix(p.updated_on)
    }
  }
}

export function mapBitbucketItem(
  group: LaunchpadPart['group'],
  raw: unknown,
  accountId: string,
  accountLabel: string
): LaunchpadPart | null {
  const b = prBasics(raw)
  if (!b) return null
  const { p, slug } = b
  const author = obj(p.author)
  return {
    id: `bitbucket:${slug ?? ''}#${b.number}:${group}`,
    group,
    source: 'bitbucket',
    accountId,
    accountLabel,
    host: 'bitbucket.org',
    repo: slug,
    number: b.number,
    key: `#${b.number}`,
    title: b.title,
    url: b.url,
    author: personName(author),
    authorAvatar: href(author.links, 'avatar'),
    updatedAt: unix(p.updated_on),
    draft: bool(p.draft),
    ci: null,
    review: null,
    state: 'open',
    headRef: refName(obj(obj(p.source).branch).name),
    baseRef: refName(obj(obj(p.destination).branch).name),
    cloneUrl: slug ? `https://bitbucket.org/${slug}.git` : null
  }
}

export function bitbucketCi(states: unknown[]): CiState | null {
  if (!states.length) return null
  if (states.some((s) => s === 'FAILED' || s === 'STOPPED')) return 'failure'
  if (states.some((s) => s === 'INPROGRESS')) return 'pending'
  return 'success'
}

export function bitbucketReview(participants: unknown): ReviewState | null {
  const reviewers = list(participants)
    .map(obj)
    .filter((p) => p.role === 'REVIEWER')
  if (reviewers.some((p) => p.state === 'changes_requested')) return 'changes_requested'
  if (reviewers.length && reviewers.every((p) => p.approved === true)) return 'approved'
  return reviewers.length ? 'review_required' : null
}

const mapAll = <T>(items: unknown, fn: (item: unknown) => T | null): T[] =>
  list(items).flatMap((i) => fn(i) ?? [])

/** "workspace/repo" as API path segments (each encoded; dot segments refused). */
const repoPath = (slug: string): string => `/repositories/${slugPath(slug, 2)}`

export function bitbucketClient(config: ClientConfig): ProviderClient {
  const base = bitbucketBase()
  const api = new Api('Bitbucket', [base], {
    Authorization: basic(config.username ?? '', config.token)
  })
  const get = (pathOrUrl: string): Promise<unknown> =>
    api.json(pathOrUrl.startsWith('http') ? pathOrUrl : base + pathOrUrl)
  const accountId = config.accountId ?? ''
  const accountLabel = config.accountLabel ?? accountId
  let me: Promise<Json> | null = null
  const user = (): Promise<Json> => (me ??= get('/user').then(obj))

  /** Follows `next` links (the Api refuses any that leave api.bitbucket.org). */
  async function pages(path: string): Promise<{ items: unknown[]; truncated: boolean }> {
    const items: unknown[] = []
    let url: string | null = base + path
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const r = obj(await get(url))
      items.push(...list(r.values))
      url = str(r.next, 4096)
    }
    return { items, truncated: !!url }
  }

  const item = (
    group: LaunchpadPart['group'],
    p: unknown,
    extra: Partial<LaunchpadPart> = {}
  ): LaunchpadPart | null => {
    const mapped = mapBitbucketItem(group, p, accountId, accountLabel)
    return mapped && { ...mapped, ...extra }
  }

  return {
    supportsDraft: true,
    async user() {
      return mapBitbucketUser(await user())
    },
    avatar: (url) => downloadPicture(url),
    async repos(account) {
      const { items, truncated } = await pages(
        '/repositories?role=member&pagelen=100&sort=-updated_on'
      )
      return { repos: mapAll(items, (r) => mapBitbucketRepo(r, account)), truncated }
    },
    async orgs() {
      const { items } = await pages('/user/permissions/workspaces?pagelen=100')
      return mapAll(items, (raw): HostingOrg | null => {
        const w = obj(obj(raw).workspace)
        const name = str(w.slug, 200)
        if (!name || !/^[\w.-]+$/.test(name) || dotsOnly(name)) return null
        return { name, label: str(w.name, 300) || name, kind: 'workspace' }
      })
    },
    async orgRepos(org, account) {
      if (!/^[\w.-]+$/.test(org) || dotsOnly(org)) throw new Error(`Invalid workspace ${org}`)
      const { items } = await pages(
        `/repositories/${encodeURIComponent(org)}?pagelen=100&sort=-updated_on`
      )
      return mapAll(items, (r) => mapBitbucketRepo(r, account))
    },
    async pullRequests(ref) {
      const r = obj(
        await get(`${repoPath(ref.slug)}/pullrequests?state=OPEN&pagelen=50&sort=-updated_on`)
      )
      return mapAll(r.values, mapBitbucketPr)
    },
    async pullSource(ref, number) {
      const p = obj(await get(`${repoPath(ref.slug)}/pullrequests/${number}`))
      const source = obj(p.source)
      const branch = refName(obj(source.branch).name)
      if (!branch)
        throw new Error(`Bitbucket did not say which branch pull request ${number} is on.`)
      const head = repoSlug(obj(source.repository).full_name)
      const fork = head && head.toLowerCase() !== ref.slug.toLowerCase()
      return { url: fork ? `https://bitbucket.org/${head}.git` : null, ref: `refs/heads/${branch}` }
    },
    async defaultBranch(ref) {
      return refName(obj(obj(await get(repoPath(ref.slug))).mainbranch).name)
    },
    async createPullRequest(ref, input) {
      const r = obj(
        await api.json(`${base}${repoPath(ref.slug)}/pullrequests`, {
          method: 'POST',
          body: {
            title: input.title,
            description: input.body,
            source: { branch: { name: input.head } },
            destination: { branch: { name: input.base } },
            draft: input.draft
          }
        })
      )
      const id = int(r.id)
      const url =
        href(r.links, 'html') ??
        (id ? `https://bitbucket.org/${ref.slug}/pull-requests/${id}` : null)
      if (!url) throw new Error('Bitbucket created the pull request but did not return its link.')
      return { url }
    },
    async launchpad() {
      const u = await user()
      const who = encodeURIComponent(
        str(u.uuid, 200) ?? str(u.account_id, 200) ?? str(u.username, 200) ?? ''
      )
      if (!who || dotsOnly(who)) throw new Error('Bitbucket did not say who this token belongs to.')
      // Pull requests I opened, in every workspace. Bitbucket has no "review requested
      // of me" search across workspaces: those come from the repositories in GitDesk
      // (see launchpad.ts) by reading their open pull requests' reviewers.
      const mine = list(obj(await get(`/pullrequests/${who}?state=OPEN&pagelen=50`)).values)
      const detailed = await pool(mine.slice(0, MAX_DETAILS), 4, async (raw) => {
        const p = obj(raw)
        const slug = repoSlug(obj(obj(p.destination).repository).full_name)
        const id = int(p.id)
        if (!slug || !id || slug.split('/').length !== 2) return {}
        const path = `${repoPath(slug)}/pullrequests/${id}`
        const [full, statuses] = await Promise.all([
          get(path).then(obj, () => p),
          get(`${path}/statuses?pagelen=50`).then(obj, () => obj(null))
        ])
        return {
          ci: bitbucketCi(list(statuses.values).map((s) => obj(s).state)),
          review: bitbucketReview(full.participants)
        }
      })
      return mine.flatMap((p, i) => item('mine', p, detailed[i] ?? {}) ?? [])
    },
    async repoIssues() {
      return []
    }
  }
}

/** Open pull requests of one repository where I am a reviewer who has not approved yet. */
export async function bitbucketReviewRequests(
  config: ClientConfig,
  slug: string
): Promise<LaunchpadPart[]> {
  const base = bitbucketBase()
  const api = new Api('Bitbucket', [base], {
    Authorization: basic(config.username ?? '', config.token)
  })
  const path = repoPath(slug)
  const me = str(obj(await api.json(`${base}/user`)).uuid, 200)
  if (!me) return []
  const r = obj(
    await api.json(
      `${base}${path}/pullrequests?state=OPEN&pagelen=50&fields=%2Bvalues.participants`
    )
  )
  return list(r.values).flatMap((raw) => {
    const mine = list(obj(raw).participants)
      .map(obj)
      .some((x) => x.role === 'REVIEWER' && x.approved !== true && obj(x.user).uuid === me)
    if (!mine) return []
    return mapBitbucketItem('review', raw, config.accountId ?? '', config.accountLabel ?? '') ?? []
  })
}
