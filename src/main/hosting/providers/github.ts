// GitHub (github.com and GitHub Enterprise Server) REST + one GraphQL search for the Launchpad.
// Answers are checked field by field (validate.ts): a wrong-typed item is skipped.

import type {
  CiState,
  HostedRepo,
  HostingOrg,
  Issue,
  NewPullRequest,
  ReviewState
} from '../../../shared/features/hosting'
import { Api, apiOverride, downloadPicture, unix } from '../http'
import type { RemoteRef } from '../remote'
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
  userName
} from '../validate'
import type {
  ClientConfig,
  LaunchpadPart,
  ProviderClient,
  ProviderUser,
  PullSource,
  PullWithAvatar
} from './types'

const MAX_PAGES = 10

export function githubBases(host: string): { rest: string; graphql: string } {
  const origin = apiOverride(host)
  if (host === 'github.com') {
    const rest = origin ?? 'https://api.github.com'
    return { rest, graphql: `${rest}/graphql` }
  }
  const base = origin ?? `https://${host}`
  return { rest: `${base}/api/v3`, graphql: `${base}/api/graphql` }
}

/** A repository of the list, or null when it lacks its name or URLs. */
export function mapGitHubRepo(raw: unknown, host: string, account: string): HostedRepo | null {
  const r = obj(raw)
  const fullName = repoSlug(r.full_name)
  const cloneUrl = link(r.clone_url)
  const webUrl = link(r.html_url)
  if (!fullName || !cloneUrl || !webUrl) return null
  return {
    provider: 'github',
    host,
    fullName,
    description: str(r.description),
    private: bool(r.private),
    fork: bool(r.fork),
    pushedAt: str(r.pushed_at, 64),
    cloneUrl,
    webUrl,
    account
  }
}

/** The user of a sign-in answer; throws when it has no usable login. */
export function mapGitHubUser(raw: unknown, label = 'GitHub'): ProviderUser {
  const u = obj(raw)
  const login = userName(u.login)
  if (!login) throw new Error(`${label} did not say who this token belongs to.`)
  return { login, name: userName(u.name), avatarUrl: link(u.avatar_url) }
}

/** A pull request of a list, or null without a number, a title or a URL. */
export function mapGitHubPull(raw: unknown): PullWithAvatar | null {
  const p = obj(raw)
  const number = int(p.number)
  const title = str(p.title, TITLE_MAX)
  const url = link(p.html_url)
  if (!number || title === null || !url) return null
  const user = obj(p.user)
  const head = obj(p.head)
  return {
    avatarUrl: link(user.avatar_url),
    pull: {
      number,
      title,
      author: userName(user.login),
      authorAvatar: null,
      draft: bool(p.draft),
      headRef: refName(head.ref) ?? '',
      headRepo: repoSlug(obj(head.repo).full_name),
      baseRef: refName(obj(p.base).ref) ?? '',
      url,
      updatedAt: unix(p.updated_at)
    }
  }
}

/** An issue of a list (pull requests and odd items: null). */
export function mapGitHubIssue(raw: unknown, slug: string): Issue | null {
  const i = obj(raw)
  const number = int(i.number)
  const title = str(i.title, TITLE_MAX)
  const url = link(i.html_url)
  if (!number || title === null || !url || i.pull_request) return null
  const assignee = obj(i.assignee)
  return {
    source: 'github',
    key: `#${number}`,
    number,
    title,
    state: str(i.state, 100) ?? '',
    url,
    assignee: userName(assignee.login),
    assigneeAvatar: link(assignee.avatar_url),
    container: slug,
    updatedAt: unix(i.updated_at)
  }
}

// One GraphQL query covers the three Launchpad searches (same syntax as the REST search
// API: is:pr is:open review-requested:@me, author:@me, is:issue assignee:@me), with CI
// (statusCheckRollup: check runs + commit statuses) and the review decision.
export const LAUNCHPAD_QUERY = `query {
  review: search(query: "is:pr is:open archived:false review-requested:@me", type: ISSUE, first: 50) { nodes { ...pr } }
  mine: search(query: "is:pr is:open archived:false author:@me", type: ISSUE, first: 50) { nodes { ...pr } }
  issues: search(query: "is:issue is:open archived:false assignee:@me", type: ISSUE, first: 50) { nodes { ...issue } }
}
fragment pr on PullRequest {
  number title url isDraft updatedAt headRefName baseRefName reviewDecision
  author { login avatarUrl }
  repository { nameWithOwner url }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
fragment issue on Issue {
  number title url updatedAt state
  author { login avatarUrl }
  repository { nameWithOwner url }
}`

export function githubCi(state: unknown): CiState | null {
  switch (state) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return null
  }
}

export function githubReview(decision: unknown): ReviewState | null {
  switch (decision) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'REVIEW_REQUIRED':
      return 'review_required'
    default:
      return null
  }
}

/** Launchpad items of the GraphQL search; nodes without number, title, URL or repository are skipped. */
export function mapGitHubSearch(
  raw: unknown,
  host: string,
  accountId: string,
  accountLabel: string
): LaunchpadPart[] {
  const data = obj(raw)
  const items: LaunchpadPart[] = []
  const add = (group: LaunchpadPart['group'], node: unknown): void => {
    const n = obj(node)
    const number = int(n.number)
    const title = str(n.title, TITLE_MAX)
    const url = link(n.url)
    const repository = obj(n.repository)
    const repo = repoSlug(repository.nameWithOwner)
    const repoUrl = link(repository.url)
    if (!number || title === null || !url || !repo) return
    const isPr = group !== 'issue'
    const author = obj(n.author)
    const lastCommit = obj(obj(list(obj(n.commits).nodes)[0]).commit)
    items.push({
      id: `github:${host}:${repo}#${number}:${group}`,
      group,
      source: 'github',
      accountId,
      accountLabel,
      host,
      repo,
      number,
      key: `#${number}`,
      title,
      url,
      author: userName(author.login),
      authorAvatar: link(author.avatarUrl),
      updatedAt: unix(n.updatedAt),
      draft: bool(n.isDraft),
      ci: isPr ? githubCi(obj(lastCommit.statusCheckRollup).state) : null,
      review: isPr ? githubReview(n.reviewDecision) : null,
      state: isPr ? 'open' : (str(n.state, 100)?.toLowerCase() ?? 'open'),
      headRef: refName(n.headRefName),
      baseRef: refName(n.baseRefName),
      cloneUrl: repoUrl ? `${repoUrl}.git` : null
    })
  }
  for (const n of list(obj(data.review).nodes)) add('review', n)
  for (const n of list(obj(data.mine).nodes)) add('mine', n)
  for (const n of list(obj(data.issues).nodes)) add('issue', n)
  return items
}

const mapAll = <T>(items: unknown, fn: (item: unknown) => T | null): T[] =>
  list(items).flatMap((i) => fn(i) ?? [])

export function githubClient(config: ClientConfig): ProviderClient {
  const { host } = config
  const bases = githubBases(host)
  const label = host === 'github.com' ? 'GitHub' : `GitHub (${host})`
  const api = new Api(
    label,
    [bases.rest, bases.graphql],
    { Authorization: `Bearer ${config.token}` },
    { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  )
  const get = (path: string): Promise<unknown> => api.json(bases.rest + path)
  const accountId = config.accountId ?? ''

  async function pages(path: string): Promise<{ items: unknown[]; truncated: boolean }> {
    const items: unknown[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = list(await get(`${path}${sep}per_page=100&page=${page}`))
      items.push(...batch)
      if (batch.length < 100) return { items, truncated: false }
    }
    return { items, truncated: true }
  }

  // Each segment encoded and checked: a slug cannot move the request to another API path.
  const repoPath = (ref: RemoteRef): string => `/repos/${slugPath(ref.slug, 2)}`

  return {
    supportsDraft: true,
    async user() {
      return mapGitHubUser(await get('/user'), label)
    },
    avatar: (url) => downloadPicture(url.includes('?') ? `${url}&s=64` : `${url}?s=64`),
    async repos(account) {
      const { items, truncated } = await pages(
        '/user/repos?sort=pushed&affiliation=owner,collaborator,organization_member'
      )
      return { repos: mapAll(items, (r) => mapGitHubRepo(r, host, account)), truncated }
    },
    async orgs() {
      const [me, orgs] = await Promise.all([get('/user'), get('/user/orgs?per_page=100')])
      const login = mapGitHubUser(me, label).login
      return [
        { name: login, label: `${login} (your repositories)`, kind: 'user' },
        ...mapAll(orgs, (o): HostingOrg | null => {
          const name = userName(obj(o).login)
          return name ? { name, label: name, kind: 'org' } : null
        })
      ]
    },
    async orgRepos(org, account) {
      if (!/^[\w.-]+$/.test(org) || dotsOnly(org)) throw new Error(`Invalid organization ${org}`)
      const me = mapGitHubUser(await get('/user'), label)
      const path =
        me.login.toLowerCase() === org.toLowerCase()
          ? '/user/repos?affiliation=owner'
          : `/orgs/${encodeURIComponent(org)}/repos?type=all`
      return mapAll((await pages(path)).items, (r) => mapGitHubRepo(r, host, account))
    },
    async pullRequests(ref) {
      const pulls = await get(
        `${repoPath(ref)}/pulls?state=open&per_page=50&sort=updated&direction=desc`
      )
      return mapAll(pulls, mapGitHubPull)
    },
    async pullSource(_ref, number): Promise<PullSource> {
      return { url: null, ref: `refs/pull/${number}/head` }
    },
    async defaultBranch(ref) {
      return refName(obj(await get(repoPath(ref))).default_branch)
    },
    async createPullRequest(ref, input: NewPullRequest) {
      const r = await api.json(`${bases.rest}${repoPath(ref)}/pulls`, {
        method: 'POST',
        body: {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: input.draft
        }
      })
      const url = link(obj(r).html_url)
      if (!url) throw new Error(`${label} created the pull request but did not return its link.`)
      return { url }
    },
    async launchpad() {
      const r = obj(
        await api.json(bases.graphql, { method: 'POST', body: { query: LAUNCHPAD_QUERY } })
      )
      if (!r.data || typeof r.data !== 'object') {
        const why = list(r.errors, 5)
          .map((e) => str(obj(e).message, 300) ?? '')
          .filter(Boolean)
          .join('; ')
        throw new Error(`GitHub search failed${why ? `: ${why}` : '.'}`)
      }
      return mapGitHubSearch(r.data, host, accountId, config.accountLabel ?? accountId)
    },
    async repoIssues(ref) {
      const issues = await get(
        `${repoPath(ref)}/issues?state=open&per_page=50&sort=updated&direction=desc`
      )
      return mapAll(issues, (i) => mapGitHubIssue(i, ref.slug))
    }
  }
}
