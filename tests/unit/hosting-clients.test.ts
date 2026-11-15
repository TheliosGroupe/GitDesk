// Provider clients against a local fake server (no network, no real tokens).

import { createServer, type IncomingMessage, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setApiOverrides, setFetch } from '../../src/main/hosting/http'
import { clientFor } from '../../src/main/hosting/providers'
import { azureReview, mapAzurePr } from '../../src/main/hosting/providers/azure'
import {
  bitbucketCi,
  bitbucketReview,
  mapBitbucketPr
} from '../../src/main/hosting/providers/bitbucket'
import { githubCi, mapGitHubSearch } from '../../src/main/hosting/providers/github'
import { gitlabCi, mapGitLabMr, slugFromReference } from '../../src/main/hosting/providers/gitlab'
import { parseRemote } from '../../src/main/hosting/remote'
import { mapJiraIssue, mapLinearIssue } from '../../src/main/hosting/trackers'

interface Seen {
  method: string
  url: string
  auth: string | undefined
  body: unknown
}

let server: Server
let base = ''
let seen: Seen[] = []
type Route = (req: IncomingMessage, url: URL, body: unknown) => unknown
const routes = new Map<string, Route>()

const repo = (i: number): Record<string, unknown> => ({
  full_name: `octo/r${i}`,
  description: null,
  private: i % 2 === 0,
  fork: false,
  pushed_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
  clone_url: `https://github.com/octo/r${i}.git`,
  html_url: `https://github.com/octo/r${i}`
})

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const url = new URL(req.url!, base)
      const body = raw ? JSON.parse(raw) : undefined
      seen.push({
        method: req.method!,
        url: url.pathname + url.search,
        auth: req.headers.authorization,
        body
      })
      const route = routes.get(`${req.method} ${url.pathname}`)
      const out = route ? route(req, url, body) : undefined
      if (out === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Not Found' }))
        return
      }
      if (out === 401) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Bad credentials' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  setFetch((url, init) => fetch(url, init))
  setApiOverrides({
    'github.com': `${base}/gh`,
    'gitlab.example.test': `${base}/gl`,
    'bitbucket.org': `${base}/bb`,
    'dev.azure.com': `${base}/az`
  })
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
beforeEach(() => {
  seen = []
  routes.clear()
})

const github = (): ReturnType<typeof clientFor> =>
  clientFor({
    provider: 'github',
    host: 'github.com',
    token: 'gh-token',
    username: null,
    organization: null,
    accountId: 'octo'
  })

describe('GitHub client', () => {
  it('lists repositories page by page with the token, at most 10 pages', async () => {
    routes.set('GET /gh/user/repos', (_req, url) => {
      const page = Number(url.searchParams.get('page'))
      return page === 1 ? Array.from({ length: 100 }, (_, i) => repo(i)) : [repo(100), repo(101)]
    })
    const r = await github().repos('octo')
    expect(r.repos).toHaveLength(102)
    expect(r.truncated).toBe(false)
    expect(r.repos[0]).toMatchObject({ provider: 'github', host: 'github.com', account: 'octo' })
    expect(seen.every((s) => s.auth === 'Bearer gh-token')).toBe(true)
  })

  it('creates a pull request', async () => {
    routes.set('GET /gh/repos/octo/r1', () => ({ ...repo(1), default_branch: 'trunk' }))
    routes.set('POST /gh/repos/octo/r1/pulls', (_r, _u, body) => ({
      html_url: `https://github.com/octo/r1/pull/7?draft=${(body as { draft: boolean }).draft}`
    }))
    const ref = parseRemote('git@github.com:octo/r1.git')!
    expect(await github().defaultBranch(ref)).toBe('trunk')
    const { url } = await github().createPullRequest(ref, {
      head: 'feature',
      base: 'trunk',
      title: 'T',
      body: 'B',
      draft: true
    })
    expect(url).toBe('https://github.com/octo/r1/pull/7?draft=true')
    expect(seen[1].body).toEqual({
      title: 'T',
      body: 'B',
      head: 'feature',
      base: 'trunk',
      draft: true
    })
  })

  it('reads the Launchpad with one GraphQL search', async () => {
    routes.set('POST /gh/graphql', () => ({
      data: {
        review: { nodes: [searchNode(1, 'SUCCESS', 'REVIEW_REQUIRED')] },
        mine: { nodes: [searchNode(2, 'FAILURE', 'APPROVED')] },
        issues: { nodes: [{ ...searchNode(3), state: 'OPEN' }] }
      }
    }))
    const items = await github().launchpad()
    expect(items.map((i) => [i.group, i.key, i.ci, i.review])).toEqual([
      ['review', '#1', 'success', 'review_required'],
      ['mine', '#2', 'failure', 'approved'],
      ['issue', '#3', null, null]
    ])
    expect(String((seen[0].body as { query: string }).query)).toContain('review-requested:@me')
  })

  it('explains a refused token', async () => {
    routes.set('GET /gh/user', () => 401)
    await expect(github().user()).rejects.toThrow(/refused the token/)
  })
})

function searchNode(n: number, ci?: string, review?: string): Record<string, unknown> {
  return {
    number: n,
    title: `T${n}`,
    url: `https://github.com/o/r/pull/${n}`,
    isDraft: false,
    updatedAt: '2026-02-01T00:00:00Z',
    headRefName: 'h',
    baseRefName: 'main',
    reviewDecision: review ?? null,
    author: { login: 'me', avatarUrl: 'https://avatars.example/u' },
    repository: { nameWithOwner: 'o/r', url: 'https://github.com/o/r' },
    commits: { nodes: ci ? [{ commit: { statusCheckRollup: { state: ci } } }] : [] }
  }
}

describe('GitLab client (self-managed)', () => {
  const gitlab = (): ReturnType<typeof clientFor> =>
    clientFor({
      provider: 'gitlab',
      host: 'gitlab.example.test',
      token: 'glpat',
      username: null,
      organization: null
    })

  it('lists merge requests of a nested project and creates a draft', async () => {
    routes.set('GET /gl/api/v4/projects/g%2Fsub%2Fp/merge_requests', () => [
      {
        iid: 4,
        project_id: 1,
        title: 'MR',
        draft: true,
        web_url: 'https://gitlab.example.test/g/sub/p/-/merge_requests/4',
        updated_at: '2026-02-01T00:00:00Z',
        author: { username: 'ann', avatar_url: null },
        source_branch: 'feat',
        target_branch: 'main',
        source_project_id: 1,
        target_project_id: 1
      }
    ])
    routes.set('POST /gl/api/v4/projects/g%2Fsub%2Fp/merge_requests', (_r, _u, body) => ({
      web_url: `https://gitlab.example.test/g/sub/p/-/merge_requests/5#${(body as { title: string }).title}`
    }))
    const ref = parseRemote('git@gitlab.example.test:g/sub/p.git', {
      'gitlab.example.test': 'gitlab'
    })!
    const [mr] = await gitlab().pullRequests(ref)
    expect(mr.pull).toMatchObject({ number: 4, draft: true, headRef: 'feat', headRepo: 'g/sub/p' })
    const { url } = await gitlab().createPullRequest(ref, {
      head: 'feat',
      base: 'main',
      title: 'Add x',
      body: '',
      draft: true
    })
    expect(url.endsWith('#Draft: Add x')).toBe(true)
    expect(await gitlab().pullSource(ref, 4)).toEqual({
      url: null,
      ref: 'refs/merge-requests/4/head'
    })
    expect(seen.every((s) => s.auth === 'Bearer glpat')).toBe(true)
  })
})

describe('Bitbucket client', () => {
  const bitbucket = (): ReturnType<typeof clientFor> =>
    clientFor({
      provider: 'bitbucket',
      host: 'bitbucket.org',
      token: 'api-token',
      username: 'me@example.com',
      organization: null
    })

  it('uses Basic auth and refuses a next page outside the API', async () => {
    routes.set('GET /bb/repositories', () => ({
      values: [
        {
          full_name: 'team/repo',
          is_private: true,
          updated_on: '2026-01-01T00:00:00Z',
          links: { clone: [{ name: 'https', href: 'https://me@bitbucket.org/team/repo.git' }] }
        }
      ],
      next: 'https://evil.example/steal'
    }))
    await expect(bitbucket().repos('bb')).rejects.toThrow(/Unexpected Bitbucket URL/)
    expect(seen[0].auth).toBe(`Basic ${Buffer.from('me@example.com:api-token').toString('base64')}`)
  })

  it('checks out a pull request from its source branch (a fork: its own URL)', async () => {
    routes.set('GET /bb/repositories/team/repo/pullrequests/3', () => ({
      id: 3,
      title: 'x',
      updated_on: '2026-01-01T00:00:00Z',
      author: null,
      source: { branch: { name: 'feat' }, repository: { full_name: 'someone/fork' } },
      destination: { branch: { name: 'main' }, repository: { full_name: 'team/repo' } },
      links: {}
    }))
    const ref = parseRemote('git@bitbucket.org:team/repo.git')!
    expect(await bitbucket().pullSource(ref, 3)).toEqual({
      url: 'https://bitbucket.org/someone/fork.git',
      ref: 'refs/heads/feat'
    })
  })
})

describe('Azure DevOps client', () => {
  const azure = (): ReturnType<typeof clientFor> =>
    clientFor({
      provider: 'azure',
      host: 'dev.azure.com',
      token: 'pat',
      username: null,
      organization: 'org'
    })

  it('signs in with connectionData and creates a pull request', async () => {
    routes.set('GET /az/org/_apis/connectionData', () => ({
      authenticatedUser: {
        id: 'u1',
        providerDisplayName: 'Me',
        properties: { Account: { $value: 'me@x.com' } }
      }
    }))
    routes.set('POST /az/org/My%20Project/_apis/git/repositories/repo/pullrequests', () => ({
      pullRequestId: 9
    }))
    expect(await azure().user()).toEqual({ login: 'me@x.com', name: 'Me', avatarUrl: null })
    const ref = parseRemote('https://org@dev.azure.com/org/My%20Project/_git/repo')!
    const { url } = await azure().createPullRequest(ref, {
      head: 'f',
      base: 'main',
      title: 'T',
      body: '',
      draft: false
    })
    expect(url).toBe('https://dev.azure.com/org/My%20Project/_git/repo/pullrequest/9')
    expect(seen[1].body).toMatchObject({
      sourceRefName: 'refs/heads/f',
      targetRefName: 'refs/heads/main'
    })
    expect(seen.every((s) => s.auth === `Basic ${Buffer.from(':pat').toString('base64')}`)).toBe(
      true
    )
  })

  it('keeps every repository of a big organization (Azure does not page this list)', async () => {
    const repoOf = (i: number): unknown => ({
      name: `r${i}`,
      project: { name: 'p', visibility: 'private' },
      remoteUrl: `https://org@dev.azure.com/org/p/_git/r${i}`,
      webUrl: `https://dev.azure.com/org/p/_git/r${i}`
    })
    routes.set('GET /az/org/_apis/git/repositories', () => ({
      value: Array.from({ length: 1500 }, (_, i) => repoOf(i))
    }))
    const r = await azure().repos('az')
    expect(r.repos).toHaveLength(1500)
    expect(r.truncated).toBe(false)
  })

  it('refuses a repository of another organization', async () => {
    const ref = parseRemote('https://dev.azure.com/other/p/_git/r')!
    await expect(azure().pullRequests(ref)).rejects.toThrow(/organization org/)
    expect(seen).toHaveLength(0)
  })
})

describe('mappers', () => {
  it('maps pull requests of each provider', () => {
    expect(
      mapAzurePr(
        {
          pullRequestId: 2,
          title: 'A',
          isDraft: true,
          creationDate: '2026-01-01T00:00:00Z',
          createdBy: { displayName: 'Ann' },
          sourceRefName: 'refs/heads/f',
          targetRefName: 'refs/heads/main',
          repository: { name: 'r', project: { name: 'p' } }
        },
        'org'
      )?.pull
    ).toMatchObject({
      number: 2,
      draft: true,
      headRef: 'f',
      baseRef: 'main',
      author: 'Ann',
      headRepo: null
    })
    expect(
      mapBitbucketPr({
        id: 1,
        title: 'B',
        updated_on: '2026-01-01T00:00:00Z',
        author: { nickname: 'bob', links: { avatar: { href: 'https://a/b.png' } } },
        source: { branch: { name: 'x' }, repository: { full_name: 't/r' } },
        destination: { branch: { name: 'main' } },
        links: { html: { href: 'https://bitbucket.org/t/r/pull-requests/1' } }
      })
    ).toMatchObject({ avatarUrl: 'https://a/b.png', pull: { author: 'bob', headRepo: 't/r' } })
    expect(
      mapGitLabMr(
        {
          iid: 1,
          project_id: 2,
          title: 'C',
          work_in_progress: true,
          web_url: 'https://gitlab.com/g/p/-/merge_requests/1',
          updated_at: '2026-01-01T00:00:00Z',
          author: null,
          source_branch: 's',
          target_branch: 't',
          source_project_id: 3,
          target_project_id: 2
        },
        'g/p'
      )?.pull
    ).toMatchObject({ draft: true, headRepo: 'fork' })
  })

  it('maps CI and review states', () => {
    expect([githubCi('SUCCESS'), githubCi('ERROR'), githubCi('EXPECTED'), githubCi(null)]).toEqual([
      'success',
      'failure',
      'pending',
      null
    ])
    expect([gitlabCi('running'), gitlabCi('failed'), gitlabCi('manual')]).toEqual([
      'pending',
      'failure',
      null
    ])
    expect(bitbucketCi(['SUCCESSFUL', 'INPROGRESS'])).toBe('pending')
    expect(bitbucketReview([{ user: {}, role: 'REVIEWER', approved: true }])).toBe('approved')
    expect(azureReview([{ vote: 10 }, { vote: -5 }])).toBe('changes_requested')
    expect(azureReview([{ vote: 10, isRequired: true }, { vote: 0 }])).toBe('approved')
    expect(slugFromReference('g/sub/p!12', '', 'gitlab.com')).toBe('g/sub/p')
    expect(slugFromReference(undefined, 'https://gitlab.com/g/p/-/issues/1', 'gitlab.com')).toBe(
      'g/p'
    )
  })

  it('maps GitHub search results without crashing on odd nodes', () => {
    const items = mapGitHubSearch(
      { review: { nodes: [{} as never, searchNode(1) as never] } },
      'github.com',
      'a',
      'a'
    )
    expect(items).toHaveLength(1)
    expect(items[0].cloneUrl).toBe('https://github.com/o/r.git')
  })

  it('maps Jira and Linear issues', () => {
    expect(
      mapJiraIssue(
        {
          key: 'PROJ-1',
          fields: {
            summary: 'S',
            updated: '2026-01-01T00:00:00.000+0000',
            status: { name: 'In Progress' },
            assignee: { displayName: 'Me', avatarUrls: { '48x48': 'https://a/x.png' } },
            project: { key: 'PROJ' }
          }
        },
        'https://acme.atlassian.net'
      )
    ).toMatchObject({
      source: 'jira',
      key: 'PROJ-1',
      url: 'https://acme.atlassian.net/browse/PROJ-1',
      state: 'In Progress',
      container: 'PROJ',
      assigneeAvatar: 'https://a/x.png'
    })
    expect(
      mapLinearIssue({
        identifier: 'ENG-2',
        title: 'L',
        url: 'https://linear.app/x/issue/ENG-2',
        updatedAt: '2026-01-01T00:00:00Z',
        state: { name: 'Todo' },
        assignee: null,
        team: { key: 'ENG' }
      })
    ).toMatchObject({ key: 'ENG-2', number: null, container: 'ENG', state: 'Todo' })
  })
})
