// GitLab (gitlab.com and self-managed), REST API v4.
// Answers are checked field by field (validate.ts): a wrong-typed item is skipped.

import type {
  CiState,
  HostedRepo,
  HostingOrg,
  Issue,
  ReviewState
} from '../../../shared/features/hosting'
import { Api, apiOverride, downloadPicture, pool, unix } from '../http'
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
/** My merge requests whose pipeline and approval state are read one by one. */
const MAX_DETAILS = 20

export function gitlabBase(host: string): string {
  return `${apiOverride(host) ?? `https://${host}`}/api/v4`
}

export function mapGitLabProject(raw: unknown, host: string, account: string): HostedRepo | null {
  const p = obj(raw)
  const fullName = repoSlug(p.path_with_namespace)
  const cloneUrl = link(p.http_url_to_repo)
  const webUrl = link(p.web_url)
  if (!fullName || !cloneUrl || !webUrl) return null
  return {
    provider: 'gitlab',
    host,
    fullName,
    description: str(p.description) || null,
    private: p.visibility !== 'public',
    fork: !!p.forked_from_project,
    pushedAt: str(p.last_activity_at, 64),
    cloneUrl,
    webUrl,
    account
  }
}

/** The user of a sign-in answer; throws when it has no usable user name. */
export function mapGitLabUser(raw: unknown, label = 'GitLab'): ProviderUser {
  const u = obj(raw)
  const login = userName(u.username)
  if (!login) throw new Error(`${label} did not say who this token belongs to.`)
  return { login, name: userName(u.name), avatarUrl: link(u.avatar_url) }
}

export function mapGitLabMr(raw: unknown, slug: string): PullWithAvatar | null {
  const m = obj(raw)
  const number = int(m.iid)
  const title = str(m.title, TITLE_MAX)
  const url = link(m.web_url)
  if (!number || title === null || !url) return null
  const author = obj(m.author)
  const source = int(m.source_project_id)
  return {
    avatarUrl: link(author.avatar_url),
    pull: {
      number,
      title,
      author: userName(author.username),
      authorAvatar: null,
      draft: bool(m.draft) || bool(m.work_in_progress),
      headRef: refName(m.source_branch) ?? '',
      // A fork's project path is not in the list; "fork" marks it as not this repository.
      headRepo: source !== null && source === int(m.target_project_id) ? slug : 'fork',
      baseRef: refName(m.target_branch) ?? '',
      url,
      updatedAt: unix(m.updated_at)
    }
  }
}

export function gitlabCi(status: unknown): CiState | null {
  switch (status) {
    case 'success':
      return 'success'
    case 'failed':
    case 'canceled':
      return 'failure'
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'running':
    case 'scheduled':
      return 'pending'
    default:
      return null
  }
}

export function gitlabReview(status: unknown): ReviewState | null {
  if (status === 'not_approved') return 'review_required'
  if (status === 'requested_changes') return 'changes_requested'
  if (status === 'mergeable') return 'approved'
  return null
}

/** "group/sub/project!12" -> "group/sub/project" ('' when neither gives a repository path). */
export function slugFromReference(ref: unknown, webUrl: unknown, host: string): string {
  const fromRef = typeof ref === 'string' ? repoSlug(ref.replace(/[!#]\d+$/, '')) : null
  if (fromRef) return fromRef
  if (typeof webUrl !== 'string') return ''
  const m = new RegExp(`^https?://${host.replace(/[.]/g, '\\.')}/(.+?)/-/`).exec(webUrl)
  return (m && repoSlug(m[1])) || ''
}

export function mapGitLabIssue(raw: unknown, slug: string): Issue | null {
  const i = obj(raw)
  const number = int(i.iid)
  const title = str(i.title, TITLE_MAX)
  const url = link(i.web_url)
  if (!number || title === null || !url) return null
  const assignee = obj(i.assignee)
  return {
    source: 'gitlab',
    key: `#${number}`,
    number,
    title,
    state: str(i.state, 100) ?? '',
    url,
    assignee: userName(assignee.username),
    assigneeAvatar: link(assignee.avatar_url),
    container: slug,
    updatedAt: unix(i.updated_at)
  }
}

const mapAll = <T>(items: unknown, fn: (item: unknown) => T | null): T[] =>
  list(items).flatMap((i) => fn(i) ?? [])

/** A Launchpad item of a merge request or an issue; null without number, title or URL. */
export function mapGitLabItem(
  group: LaunchpadPart['group'],
  raw: unknown,
  host: string,
  accountId: string,
  accountLabel: string,
  extra: Partial<LaunchpadPart> = {}
): LaunchpadPart | null {
  const m = obj(raw)
  const number = int(m.iid)
  const title = str(m.title, TITLE_MAX)
  const url = link(m.web_url)
  if (!number || title === null || !url) return null
  const slug = slugFromReference(obj(m.references).full, url, host)
  const isMr = group !== 'issue'
  const person = obj(m.author)
  const mark = isMr ? '!' : '#'
  return {
    id: `gitlab:${host}:${slug}${mark}${number}:${group}`,
    group,
    source: 'gitlab',
    accountId,
    accountLabel,
    host,
    repo: slug || null,
    number,
    key: `${mark}${number}`,
    title,
    url,
    author: userName(person.username),
    authorAvatar: link(person.avatar_url),
    updatedAt: unix(m.updated_at),
    draft: isMr && (bool(m.draft) || bool(m.work_in_progress)),
    ci: null,
    review: null,
    state: isMr ? 'open' : (str(m.state, 100) ?? 'opened'),
    headRef: isMr ? refName(m.source_branch) : null,
    baseRef: isMr ? refName(m.target_branch) : null,
    cloneUrl: slug ? `https://${host}/${slug}.git` : null,
    ...extra
  }
}

export function gitlabClient(config: ClientConfig): ProviderClient {
  const { host } = config
  const base = gitlabBase(host)
  const label = host === 'gitlab.com' ? 'GitLab' : `GitLab (${host})`
  const api = new Api(label, [base], { Authorization: `Bearer ${config.token}` })
  const get = (path: string): Promise<unknown> => api.json(base + path)
  // The whole path is one encoded segment, as the API wants it.
  const project = (ref: RemoteRef): string => `/projects/${encodeURIComponent(ref.slug)}`
  const accountId = config.accountId ?? ''
  const accountLabel = config.accountLabel ?? accountId
  let me: Promise<ProviderUser> | null = null
  const user = (): Promise<ProviderUser> =>
    (me ??= get('/user').then((u) => mapGitLabUser(u, label)))

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

  const item = (
    group: LaunchpadPart['group'],
    m: unknown,
    extra: Partial<LaunchpadPart> = {}
  ): LaunchpadPart | null => mapGitLabItem(group, m, host, accountId, accountLabel, extra)

  return {
    supportsDraft: true,
    user,
    avatar: (url) => downloadPicture(url, api),
    async repos(account) {
      const { items, truncated } = await pages(
        '/projects?membership=true&order_by=last_activity_at&sort=desc'
      )
      return { repos: mapAll(items, (p) => mapGitLabProject(p, host, account)), truncated }
    },
    async orgs() {
      const [u, groups] = await Promise.all([
        user(),
        get('/groups?min_access_level=10&per_page=100&order_by=path')
      ])
      return [
        { name: u.login, label: `${u.login} (your projects)`, kind: 'user' },
        ...mapAll(groups, (raw): HostingOrg | null => {
          const g = obj(raw)
          const name = str(g.full_path, 300)
          return name && !dotsOnly(name)
            ? { name, label: str(g.full_name, 300) || name, kind: 'group' }
            : null
        })
      ]
    },
    async orgRepos(org, account) {
      if (!org || org.split('/').some((s) => !s || dotsOnly(s)))
        throw new Error(`Invalid group ${org}`)
      const u = await user()
      const path =
        u.login.toLowerCase() === org.toLowerCase()
          ? `/users/${encodeURIComponent(u.login)}/projects?order_by=last_activity_at`
          : `/groups/${encodeURIComponent(org)}/projects?include_subgroups=true&with_shared=false`
      return mapAll((await pages(path)).items, (p) => mapGitLabProject(p, host, account))
    },
    async pullRequests(ref) {
      const mrs = await get(
        `${project(ref)}/merge_requests?state=opened&per_page=50&order_by=updated_at&sort=desc`
      )
      return mapAll(mrs, (m) => mapGitLabMr(m, ref.slug))
    },
    async pullSource(_ref, number) {
      return { url: null, ref: `refs/merge-requests/${number}/head` }
    },
    async defaultBranch(ref) {
      return refName(obj(await get(project(ref))).default_branch)
    },
    async createPullRequest(ref, input) {
      const title =
        input.draft && !/^draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title
      const r = await api.json(`${base}${project(ref)}/merge_requests`, {
        method: 'POST',
        body: {
          source_branch: input.head,
          target_branch: input.base,
          title,
          description: input.body,
          remove_source_branch: false
        }
      })
      const url = link(obj(r).web_url)
      if (!url) throw new Error(`${label} created the merge request but did not return its link.`)
      return { url }
    },
    async launchpad() {
      const u = await user()
      const name = encodeURIComponent(u.login)
      const [review, mine, issues] = await Promise.all([
        get(`/merge_requests?state=opened&scope=all&reviewer_username=${name}&per_page=50`),
        get('/merge_requests?state=opened&scope=created_by_me&per_page=50'),
        get('/issues?state=opened&scope=assigned_to_me&per_page=50')
      ])
      const myMrs = list(mine)
      // Pipeline and approval state are only on a single merge request.
      const detailed = await pool(myMrs.slice(0, MAX_DETAILS), 4, async (raw): Promise<Json> => {
        const m = obj(raw)
        const projectId = int(m.project_id)
        const iid = int(m.iid)
        if (projectId === null || iid === null) return m
        return get(`/projects/${projectId}/merge_requests/${iid}`).then(obj, () => m)
      })
      return [
        ...mapAll(review, (m) => item('review', m)),
        ...mapAll(
          myMrs.map((m, i) => [m, detailed[i] ?? obj(m)] as const),
          (pair) => {
            const [m, d] = pair as readonly [unknown, Json]
            return item('mine', m, {
              ci: gitlabCi(obj(d.head_pipeline).status),
              review: gitlabReview(d.detailed_merge_status)
            })
          }
        ),
        ...mapAll(issues, (i) => item('issue', i))
      ]
    },
    async repoIssues(ref) {
      const issues = await get(
        `${project(ref)}/issues?state=opened&per_page=50&order_by=updated_at&sort=desc`
      )
      return mapAll(issues, (i) => mapGitLabIssue(i, ref.slug))
    }
  }
}
