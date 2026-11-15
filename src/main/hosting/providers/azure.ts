// Azure DevOps Services (dev.azure.com/<organization>), REST API 7.1, PAT with Basic auth.
// Answers are checked field by field (validate.ts): a wrong-typed item is skipped.

import type { HostedRepo, HostingOrg, ReviewState } from '../../../shared/features/hosting'
import { Api, apiOverride, basic, downloadPicture, pool, unix } from '../http'
import type { RemoteRef } from '../remote'
import {
  bool,
  dotsOnly,
  hasControl,
  int,
  link,
  list,
  obj,
  refName,
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

const V = 'api-version=7.1'
const MAX_PROJECTS = 20

export function azureBase(org: string): string {
  return `${apiOverride('dev.azure.com') ?? 'https://dev.azure.com'}/${encodeURIComponent(org)}`
}

/** Remote URLs carry the organization as user name ("https://org@dev.azure.com/…"). */
const withoutUser = (url: string): string => url.replace(/^(https:\/\/)[^@/]+@/, '$1')

/** A project or repository name: a single path segment Azure DevOps could have. */
const azureName = (v: unknown): string | null => {
  const s = str(v, 256)
  return s && !dotsOnly(s) && !/[/\\]/.test(s) && !hasControl(s) ? s : null
}

export function mapAzureRepo(raw: unknown, org: string, account: string): HostedRepo | null {
  const r = obj(raw)
  const name = azureName(r.name)
  const project = obj(r.project)
  const projectName = azureName(project.name)
  const remoteUrl = link(r.remoteUrl)
  const webUrl = link(r.webUrl)
  if (!name || !projectName || !remoteUrl || !webUrl) return null
  return {
    provider: 'azure',
    host: 'dev.azure.com',
    fullName: `${org}/${projectName}/${name}`,
    description: null,
    private: project.visibility !== 'public',
    fork: bool(r.isFork),
    pushedAt: null,
    cloneUrl: withoutUser(remoteUrl),
    webUrl,
    account
  }
}

const branch = (ref: unknown): string => (refName(ref) ?? '').replace(/^refs\/heads\//, '')

export function azurePullUrl(org: string, project: string, repo: string, id: number): string {
  return `https://dev.azure.com/${[org, project, '_git', repo].map(encodeURIComponent).join('/')}/pullrequest/${id}`
}

/** Number, title, project and repository of a pull request; null when one is missing. */
function prBasics(
  raw: unknown
): { p: Json; number: number; title: string; project: string; repo: string } | null {
  const p = obj(raw)
  const number = int(p.pullRequestId)
  const title = str(p.title, TITLE_MAX)
  const repository = obj(p.repository)
  const repo = azureName(repository.name)
  const project = azureName(obj(repository.project).name)
  if (!number || title === null || !repo || !project) return null
  return { p, number, title, project, repo }
}

export function mapAzurePr(raw: unknown, org: string): PullWithAvatar | null {
  const b = prBasics(raw)
  if (!b) return null
  const { p } = b
  const createdBy = obj(p.createdBy)
  const fork = p.forkSource ? obj(obj(p.forkSource).repository) : null
  return {
    avatarUrl: link(obj(obj(createdBy._links).avatar).href) ?? link(createdBy.imageUrl),
    pull: {
      number: b.number,
      title: b.title,
      author: userName(createdBy.displayName),
      authorAvatar: null,
      draft: bool(p.isDraft),
      headRef: branch(p.sourceRefName),
      headRepo: fork ? (azureName(fork.name) ?? 'fork') : null,
      baseRef: branch(p.targetRefName),
      url: azurePullUrl(org, b.project, b.repo, b.number),
      updatedAt: unix(p.creationDate)
    }
  }
}

/** Votes: 10 approved, 5 approved with suggestions, 0 none, -5 waiting for author, -10 rejected. */
export function azureReview(reviewers: unknown): ReviewState | null {
  const votes = list(reviewers)
    .map(obj)
    .map((r) => ({ vote: typeof r.vote === 'number' ? r.vote : 0, isRequired: bool(r.isRequired) }))
  if (!votes.length) return null
  if (votes.some((r) => r.vote < 0)) return 'changes_requested'
  const required = votes.filter((r) => r.isRequired)
  const decisive = required.length ? required : votes
  if (decisive.every((r) => r.vote > 0)) return 'approved'
  return 'review_required'
}

export function mapAzureItem(
  group: LaunchpadPart['group'],
  raw: unknown,
  org: string,
  accountId: string,
  accountLabel: string
): LaunchpadPart | null {
  const b = prBasics(raw)
  if (!b) return null
  const { p, project, repo } = b
  const slug = `${org}/${project}/${repo}`
  return {
    id: `azure:${slug}#${b.number}:${group}`,
    group,
    source: 'azure',
    accountId,
    accountLabel,
    host: 'dev.azure.com',
    repo: slug,
    number: b.number,
    key: `!${b.number}`,
    title: b.title,
    url: azurePullUrl(org, project, repo, b.number),
    author: userName(obj(p.createdBy).displayName),
    authorAvatar: null,
    updatedAt: unix(p.creationDate),
    draft: bool(p.isDraft),
    ci: null,
    review: group === 'mine' ? azureReview(p.reviewers) : null,
    state: 'open',
    headRef: branch(p.sourceRefName) || null,
    baseRef: branch(p.targetRefName) || null,
    cloneUrl: `https://dev.azure.com/${[org, project, '_git', repo].map(encodeURIComponent).join('/')}`
  }
}

/** The user of connectionData; throws when it has no id or usable name. */
export function mapAzureUser(raw: unknown): ProviderUser {
  const u = obj(obj(raw).authenticatedUser)
  const id = str(u.id, 200)
  const display = userName(u.providerDisplayName)
  const login = userName(obj(obj(u.properties).Account).$value) ?? display ?? userName(id)
  if (!id || !login) throw new Error('Azure DevOps did not say who this token belongs to.')
  return { login, name: display, avatarUrl: null }
}

const mapAll = <T>(items: unknown, fn: (item: unknown) => T | null, max?: number): T[] =>
  list(items, max).flatMap((i) => fn(i) ?? [])

/**
 * Azure lists every repository of an organization or project in one answer (no paging):
 * all of them are kept (the 20 MB answer cap bounds the list), up to this many.
 */
export const AZURE_MAX_REPOS = 10_000

export function azureClient(config: ClientConfig): ProviderClient {
  const org = config.organization ?? ''
  if (!org || dotsOnly(org)) throw new Error('This Azure DevOps account has no organization.')
  const base = azureBase(org)
  const api = new Api(`Azure DevOps (${org})`, [base], { Authorization: basic('', config.token) })
  const get = (path: string): Promise<unknown> =>
    api.json(`${base}${path}${path.includes('?') ? '&' : '?'}${V}`)
  const accountId = config.accountId ?? ''
  const accountLabel = config.accountLabel ?? accountId
  const repoPath = (ref: RemoteRef): string => {
    if (!ref.azure) throw new Error('Not an Azure DevOps repository')
    if (ref.azure.org.toLowerCase() !== org.toLowerCase())
      throw new Error(`This account is for the organization ${org}, not ${ref.azure.org}.`)
    return `/${encodeURIComponent(ref.azure.project)}/_apis/git/repositories/${encodeURIComponent(ref.azure.repo)}`
  }

  let me: Promise<Json> | null = null
  // connectionData checks the organization and the token in one call, on dev.azure.com.
  const connection = (): Promise<Json> =>
    (me ??= api.json(`${base}/_apis/connectionData`).then(obj))

  const projects = async (): Promise<string[]> =>
    list(obj(await get('/_apis/projects?$top=500')).value).flatMap(
      (p) => azureName(obj(p).name) ?? []
    )

  const enabledRepos = (raw: unknown, account: string): HostedRepo[] =>
    mapAll(
      obj(raw).value,
      (x) => (obj(x).isDisabled ? null : mapAzureRepo(x, org, account)),
      AZURE_MAX_REPOS
    )

  return {
    supportsDraft: true,
    async user() {
      return mapAzureUser(await connection())
    },
    avatar: (url) => downloadPicture(url, api),
    async repos(account) {
      const raw = await get('/_apis/git/repositories')
      const all = obj(raw).value
      return {
        repos: enabledRepos(raw, account),
        truncated: Array.isArray(all) && all.length > AZURE_MAX_REPOS
      }
    },
    async orgs() {
      return (await projects()).map((name): HostingOrg => ({ name, label: name, kind: 'project' }))
    },
    async orgRepos(project, account) {
      if (!azureName(project)) throw new Error(`Invalid project ${project}`)
      return enabledRepos(
        await get(`/${encodeURIComponent(project)}/_apis/git/repositories`),
        account
      )
    },
    async pullRequests(ref) {
      const r = obj(await get(`${repoPath(ref)}/pullrequests?searchCriteria.status=active&$top=50`))
      return mapAll(r.value, (p) => mapAzurePr(p, org))
    },
    async pullSource(ref, number) {
      const p = obj(await get(`${repoPath(ref)}/pullrequests/${number}`))
      const source = refName(p.sourceRefName)
      if (!source)
        throw new Error(`Azure DevOps did not say which branch pull request ${number} is on.`)
      const forkUrl = link(obj(obj(p.forkSource).repository).remoteUrl)
      return { url: forkUrl ? withoutUser(forkUrl) : null, ref: source }
    },
    async defaultBranch(ref) {
      return branch(obj(await get(repoPath(ref))).defaultBranch) || null
    },
    async createPullRequest(ref, input) {
      const p = obj(
        await api.json(`${base}${repoPath(ref)}/pullrequests?${V}`, {
          method: 'POST',
          body: {
            sourceRefName: `refs/heads/${input.head}`,
            targetRefName: `refs/heads/${input.base}`,
            title: input.title,
            description: input.body,
            isDraft: input.draft
          }
        })
      )
      const id = int(p.pullRequestId)
      if (!id)
        throw new Error('Azure DevOps created the pull request but did not return its number.')
      return { url: azurePullUrl(org, ref.azure!.project, ref.azure!.repo, id) }
    },
    async launchpad() {
      const id = str(obj((await connection()).authenticatedUser).id, 200)
      if (!id) throw new Error('Azure DevOps did not say who this token belongs to.')
      const who = encodeURIComponent(id)
      const names = (await projects()).slice(0, MAX_PROJECTS)
      const lists = await pool(names, 4, async (project) => {
        const p = `/${encodeURIComponent(project)}/_apis/git/pullrequests?searchCriteria.status=active&$top=50`
        const [review, mine] = await Promise.all([
          get(`${p}&searchCriteria.reviewerId=${who}`),
          get(`${p}&searchCriteria.creatorId=${who}`)
        ])
        return [
          ...mapAll(obj(review).value, (x) =>
            mapAzureItem('review', x, org, accountId, accountLabel)
          ),
          ...mapAll(obj(mine).value, (x) => mapAzureItem('mine', x, org, accountId, accountLabel))
        ]
      })
      return lists.flat()
    },
    async repoIssues() {
      return []
    }
  }
}
