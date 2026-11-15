// Provider and tracker answers with wrong-typed fields: every mapper keeps strings (or null)
// and skips what cannot be shown, instead of throwing or passing objects to the UI.
// Repository paths cannot move an API request to another path.

import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Api, setApiOverrides, setFetch } from '../../src/main/hosting/http'
import { clientFor, type ClientConfig } from '../../src/main/hosting/providers'
import {
  mapAzureItem,
  mapAzurePr,
  mapAzureRepo,
  mapAzureUser
} from '../../src/main/hosting/providers/azure'
import {
  bitbucketReview,
  mapBitbucketItem,
  mapBitbucketPr,
  mapBitbucketRepo,
  mapBitbucketUser
} from '../../src/main/hosting/providers/bitbucket'
import {
  mapGitHubIssue,
  mapGitHubPull,
  mapGitHubRepo,
  mapGitHubSearch,
  mapGitHubUser
} from '../../src/main/hosting/providers/github'
import {
  mapGitLabIssue,
  mapGitLabItem,
  mapGitLabMr,
  mapGitLabProject,
  mapGitLabUser
} from '../../src/main/hosting/providers/gitlab'
import { normalizeCloneInput, parseRemote } from '../../src/main/hosting/remote'
import { mapJiraIssue, mapLinearIssue } from '../../src/main/hosting/trackers'
import { repoSlug, slugPath, userName } from '../../src/main/hosting/validate'

/** Values a broken or hostile server could send where a string, number or object is expected. */
const ODD: unknown[] = [
  null,
  undefined,
  42,
  -1,
  1.5,
  true,
  'text',
  '',
  [],
  ['a'],
  {},
  { nested: { deeper: 1 } },
  { toString: 'not a function' },
  JSON.parse('{"__proto__": {"polluted": 1}}'),
  'javascript:alert(1)',
  'http://plain.example/x',
  'x'.repeat(100_000)
]

/** Every string-or-null field of an object really is a string or null (no nested objects). */
function flat(value: unknown): void {
  expect(value && typeof value === 'object').toBe(true)
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'pull') {
      flat(v)
      continue
    }
    expect(['string', 'number', 'boolean'].includes(typeof v) || v === null, k).toBe(true)
    if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true)
    if (typeof v === 'string') expect(v.length, k).toBeLessThanOrEqual(5000)
  }
}

/** Calls fn on each odd value in each position of `template`, expecting no throw and flat output. */
function fuzz(template: Record<string, unknown>, fn: (raw: unknown) => unknown): number {
  let kept = 0
  const run = (raw: unknown): void => {
    const out = fn(raw)
    if (out === null) return
    if (Array.isArray(out)) out.forEach(flat)
    else flat(out)
    kept++
  }
  for (const odd of ODD) {
    run(odd)
    for (const key of Object.keys(template)) run({ ...template, [key]: odd })
  }
  return kept
}

const ghPull = {
  number: 3,
  title: 'Fix',
  draft: false,
  html_url: 'https://github.com/o/r/pull/3',
  updated_at: '2026-01-01T00:00:00Z',
  user: { login: 'alice', avatar_url: 'https://avatars.example.com/u/1' },
  head: { ref: 'fix', repo: { full_name: 'alice/r' } },
  base: { ref: 'main' }
}

describe('mappers survive wrong-typed fields', () => {
  it('GitHub', () => {
    expect(fuzz(ghPull, mapGitHubPull)).toBeGreaterThan(0)
    expect(mapGitHubPull({ ...ghPull, title: { nested: 1 } })).toBeNull()
    expect(mapGitHubPull({ ...ghPull, number: '3' })).toBeNull()
    expect(mapGitHubPull({ ...ghPull, html_url: 'javascript:alert(1)' })).toBeNull()
    expect(
      mapGitHubPull({ ...ghPull, head: { ref: 7, repo: { full_name: 12 } }, user: [] })?.pull
    ).toMatchObject({ headRef: '', headRepo: null, author: null })
    const issue = {
      number: 1,
      title: 'I',
      state: 'open',
      html_url: 'https://github.com/o/r/issues/1',
      assignee: { login: 'a', avatar_url: 'https://x.example/a.png' }
    }
    fuzz(issue, (i) => mapGitHubIssue(i, 'o/r'))
    expect(mapGitHubIssue({ ...issue, pull_request: {} }, 'o/r')).toBeNull()
    expect(mapGitHubIssue({ ...issue, state: { name: 'x' } }, 'o/r')?.state).toBe('')
    fuzz(
      {
        full_name: 'o/r',
        clone_url: 'https://github.com/o/r.git',
        html_url: 'https://github.com/o/r',
        description: 'd',
        pushed_at: '2026-01-01T00:00:00Z'
      },
      (r) => mapGitHubRepo(r, 'github.com', 'me')
    )
    const node = {
      number: 1,
      title: 'T',
      url: 'https://github.com/o/r/pull/1',
      updatedAt: '2026-01-01T00:00:00Z',
      author: { login: 'a', avatarUrl: 'https://x.example/a.png' },
      repository: { nameWithOwner: 'o/r', url: 'https://github.com/o/r' },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }
    }
    fuzz(node, (n) => mapGitHubSearch({ review: { nodes: [n] } }, 'github.com', 'a', 'a'))
    fuzz({ review: { nodes: [node] }, mine: { nodes: 'x' }, issues: 5 }, (d) =>
      mapGitHubSearch(d, 'github.com', 'a', 'a')
    )
    const many = mapGitHubSearch(
      { review: { nodes: Array.from({ length: 10_000 }, () => node) } },
      'github.com',
      'a',
      'a'
    )
    expect(many.length).toBeLessThanOrEqual(1000)
  })

  it('GitLab', () => {
    const mr = {
      iid: 1,
      project_id: 2,
      title: 'C',
      web_url: 'https://gitlab.com/g/p/-/merge_requests/1',
      updated_at: '2026-01-01T00:00:00Z',
      author: { username: 'u', avatar_url: 'https://x.example/u.png' },
      source_branch: 's',
      target_branch: 't',
      source_project_id: 2,
      target_project_id: 2,
      references: { full: 'g/p!1' }
    }
    fuzz(mr, (m) => mapGitLabMr(m, 'g/p'))
    fuzz(mr, (m) => mapGitLabItem('mine', m, 'gitlab.com', 'a', 'a'))
    fuzz(
      { iid: 4, title: 'I', state: 'opened', web_url: 'https://gitlab.com/g/p/-/issues/4' },
      (i) => mapGitLabIssue(i, 'g/p')
    )
    fuzz(
      {
        path_with_namespace: 'g/p',
        http_url_to_repo: 'https://gitlab.com/g/p.git',
        web_url: 'https://gitlab.com/g/p'
      },
      (p) => mapGitLabProject(p, 'gitlab.com', 'me')
    )
    expect(
      mapGitLabItem('mine', { ...mr, references: { full: '../x!1' } }, 'gitlab.com', 'a', 'a')
    ).toMatchObject({ repo: 'g/p' })
  })

  it('Bitbucket', () => {
    const pr = {
      id: 1,
      title: 'B',
      updated_on: '2026-01-01T00:00:00Z',
      author: { nickname: 'bob', links: { avatar: { href: 'https://x.example/b.png' } } },
      source: { branch: { name: 'x' }, repository: { full_name: 't/r' } },
      destination: { branch: { name: 'main' }, repository: { full_name: 't/r' } },
      links: { html: { href: 'https://bitbucket.org/t/r/pull-requests/1' } }
    }
    fuzz(pr, mapBitbucketPr)
    fuzz(pr, (p) => mapBitbucketItem('mine', p, 'a', 'a'))
    expect(mapBitbucketPr({ ...pr, links: 'x' })?.pull.url).toBe(
      'https://bitbucket.org/t/r/pull-requests/1'
    )
    expect(mapBitbucketPr({ ...pr, links: 'x', destination: {} })).toBeNull()
    fuzz({ full_name: 't/r', links: { clone: 'x', html: { href: 5 } } }, (r) =>
      mapBitbucketRepo(r, 'me')
    )
    expect(bitbucketReview('REVIEWER')).toBeNull()
    expect(bitbucketReview([null, 1, { role: 'REVIEWER', approved: 'yes' }])).toBe(
      'review_required'
    )
  })

  it('Azure DevOps', () => {
    const pr = {
      pullRequestId: 2,
      title: 'A',
      creationDate: '2026-01-01T00:00:00Z',
      createdBy: { displayName: 'Ann' },
      sourceRefName: 'refs/heads/f',
      targetRefName: 'refs/heads/main',
      repository: { name: 'r', project: { name: 'p' } },
      reviewers: [{ vote: 10 }]
    }
    fuzz(pr, (p) => mapAzurePr(p, 'org'))
    fuzz(pr, (p) => mapAzureItem('mine', p, 'org', 'a', 'a'))
    expect(
      mapAzurePr({ ...pr, repository: { name: '..', project: { name: 'p' } } }, 'o')
    ).toBeNull()
    fuzz(
      {
        name: 'r',
        project: { name: 'p' },
        remoteUrl: 'https://org@dev.azure.com/org/p/_git/r',
        webUrl: 'https://dev.azure.com/org/p/_git/r'
      },
      (r) => mapAzureRepo(r, 'org', 'me')
    )
  })

  it('Jira and Linear', () => {
    const jira = {
      key: 'PROJ-1',
      fields: {
        summary: 'S',
        status: { name: 'In Progress' },
        assignee: { displayName: 'Me', avatarUrls: { '48x48': 'https://x.example/a.png' } },
        project: { key: 'PROJ' }
      }
    }
    fuzz(jira, (i) => mapJiraIssue(i, 'https://acme.atlassian.net'))
    fuzz(jira.fields, (f) =>
      mapJiraIssue({ key: 'PROJ-1', fields: f }, 'https://acme.atlassian.net')
    )
    expect(
      mapJiraIssue(
        { ...jira, fields: { ...jira.fields, status: { name: { nested: 1 } } } },
        'https://acme.atlassian.net'
      )?.state
    ).toBe('')
    const linear = {
      identifier: 'ENG-2',
      title: 'L',
      url: 'https://linear.app/x/issue/ENG-2',
      state: { name: 'Todo' },
      assignee: { name: 'N', avatarUrl: 'https://x.example/n.png' },
      team: { key: 'ENG' }
    }
    fuzz(linear, mapLinearIssue)
    expect(mapLinearIssue({ ...linear, url: 'javascript:alert(1)' })).toBeNull()
  })

  it('sign-in identities: strings only, or a clear error', () => {
    for (const odd of [{ nested: 1 }, 7, ['a'], '', '  ', 'a\nb', null]) {
      expect(() => mapGitHubUser({ login: odd })).toThrow(/did not say who/)
      expect(() => mapGitLabUser({ username: odd })).toThrow(/did not say who/)
      expect(() => mapBitbucketUser({ username: odd, nickname: odd, display_name: odd })).toThrow(
        /did not say who/
      )
      expect(() => mapAzureUser({ authenticatedUser: { id: odd } })).toThrow(/did not say who/)
    }
    expect(mapGitHubUser({ login: 'me', name: { x: 1 }, avatar_url: 5 })).toEqual({
      login: 'me',
      name: null,
      avatarUrl: null
    })
    expect(mapBitbucketUser({ display_name: 'Bo B', links: { avatar: 'x' } }).login).toBe('Bo B')
    expect(userName('x'.repeat(201))).toBeNull()
  })
})

describe('repository paths stay in the API', () => {
  it('refuses dot segments, also percent-encoded once or twice', () => {
    for (const host of ['github.com', 'bitbucket.org', 'gitlab.com', 'unknown.example']) {
      for (const bad of ['%2e%2e', '%2E%2E', '%252e%252e', '%25252e', '.', '..', '...', '%2f'])
        for (const url of [`https://${host}/${bad}/repo.git`, `https://${host}/owner/${bad}`])
          expect(parseRemote(url), url).toBeNull()
    }
    expect(parseRemote('https://github.com/o/.github.git')?.slug).toBe('o/.github')
    // A name that is only dots, or nothing at all, once ".git" is stripped.
    for (const url of [
      'https://github.com/o/..git',
      'https://github.com/o/.git',
      'git@github.com:o/..git',
      'https://bitbucket.org/w/..git',
      'https://gitlab.com/g/..git/r',
      'https://gitlab.com/g/.git/r',
      'https://unknown.example/a/..git/c',
      'https://dev.azure.com/org/p/_git/..git'
    ])
      expect(parseRemote(url), url).toBeNull()
    expect(parseRemote('https://github.com/o/.github')?.slug).toBe('o/.github')
    expect(parseRemote('https://github.com/o/r.git')?.slug).toBe('o/r')
    expect(parseRemote('https://gitlab.com/g/s/r.git')?.slug).toBe('g/s/r')
    expect(() => normalizeCloneInput('../..')).toThrow()
    expect(() => normalizeCloneInput('o/..git')).toThrow()
    expect(normalizeCloneInput('o/.github').url).toBe('https://github.com/o/.github.git')
    // github.com slugs come from the hosting parser (repo.ts githubComSlug).
    expect(parseRemote('https://github.com/../repo')).toBeNull()
    expect(parseRemote('git@github.com:o/..')).toBeNull()
    expect(parseRemote('https://github.com/o/.github')?.slug).toBe('o/.github')
    expect(() => slugPath('../x', 2)).toThrow()
    expect(() => slugPath('a/b/c', 2)).toThrow()
    expect(slugPath('a b/c%d', 2)).toBe('a%20b/c%25d')
    expect(repoSlug('a/../b')).toBeNull()
    expect(repoSlug('a/b')).toBe('a/b')
  })

  it('compares parsed URLs with the API bases', () => {
    const api = new Api(
      'Fake',
      ['https://api.example.test/2.0', 'https://api.example.test/graphql'],
      {}
    )
    expect(api.allowed('https://api.example.test/2.0/repositories/a/b')).toBe(true)
    expect(api.allowed('https://api.example.test/2.0?page=2')).toBe(true)
    expect(api.allowed('https://api.example.test/graphql')).toBe(true)
    expect(
      api.allowed('https://api.example.test/2.0/repositories/%2e%2e/%2e%2e/pullrequests')
    ).toBe(false)
    expect(api.allowed('https://api.example.test/2.0/../pullrequests')).toBe(false)
    expect(api.allowed('https://api.example.test/2.0x/a')).toBe(false)
    expect(api.allowed('https://api.example.test/graphqlx')).toBe(false)
    expect(api.allowed('https://user@api.example.test/2.0/a')).toBe(false)
    expect(api.allowed('https://other.example.test/2.0/a')).toBe(false)
  })
})

describe('clients with a server that answers oddly', () => {
  let server: Server
  let paths: string[] = []
  let answer: (path: string) => unknown = () => ({})
  beforeAll(async () => {
    server = createServer((req, res) => {
      paths.push(req.url!)
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer(req.url!) ?? null))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    setFetch((url, init) => fetch(url, init))
    setApiOverrides({
      'ghe.example.test': `${base}/ghe`,
      'bitbucket.org': `${base}/bb`
    })
  })
  afterAll(() => server.close())

  const config = (provider: 'github' | 'bitbucket'): ClientConfig => ({
    provider,
    host: provider === 'github' ? 'ghe.example.test' : 'bitbucket.org',
    token: 't',
    username: 'u',
    organization: null
  })

  it('keeps the valid pull requests of a list and skips the others', async () => {
    answer = () => [
      ghPull,
      { ...ghPull, number: 4, title: { nested: 1 } },
      { ...ghPull, number: 5, head: { ref: 1, repo: { full_name: 2 } } },
      'junk',
      null
    ]
    const pulls = await clientFor(config('github')).pullRequests({
      provider: 'github',
      host: 'ghe.example.test',
      slug: 'o/r'
    })
    expect(pulls.map((p) => p.pull.number)).toEqual([3, 5])
    expect(pulls[1].pull.headRepo).toBeNull()
    answer = () => ({ unexpected: true })
    expect(
      await clientFor(config('github')).pullRequests({
        provider: 'github',
        host: 'ghe.example.test',
        slug: 'o/r'
      })
    ).toEqual([])
  })

  it('refuses a sign-in whose user has no usable login', async () => {
    answer = () => ({ login: { nested: 1 }, name: ['x'] })
    await expect(clientFor(config('github')).user()).rejects.toThrow(/did not say who/)
  })

  it('never sends a request for a slug with dot segments', async () => {
    paths = []
    const client = clientFor(config('bitbucket'))
    for (const slug of ['../x', 'a/..', '%2e%2e/x'.replace(/%2e/g, '.')])
      await expect(
        client.pullRequests({ provider: 'bitbucket', host: 'bitbucket.org', slug })
      ).rejects.toThrow()
    expect(paths).toEqual([])
  })
})
