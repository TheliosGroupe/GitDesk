import { describe, expect, it } from 'vitest'
import {
  cloneFolders,
  httpsCloneUrl,
  normalizeCloneInput,
  parseRemote,
  webUrl
} from '../../src/main/hosting/remote'
import { accountId, gitIdentity, normalizeHost } from '../../src/main/hosting/identity'

describe('parseRemote', () => {
  it.each([
    ['https://github.com/octocat/Hello-World.git', 'github', 'github.com', 'octocat/Hello-World'],
    ['https://github.com/octocat/Hello-World', 'github', 'github.com', 'octocat/Hello-World'],
    ['git@github.com:octocat/Hello-World.git', 'github', 'github.com', 'octocat/Hello-World'],
    ['ssh://git@github.com/octocat/Hello-World.git', 'github', 'github.com', 'octocat/Hello-World'],
    ['https://github.com/o/r/pull/12', 'github', 'github.com', 'o/r'],
    ['https://user@github.com/o/r.git', 'github', 'github.com', 'o/r'],
    ['https://gitlab.com/group/sub/proj.git', 'gitlab', 'gitlab.com', 'group/sub/proj'],
    ['git@gitlab.com:group/sub/proj.git', 'gitlab', 'gitlab.com', 'group/sub/proj'],
    ['https://gitlab.com/group/proj/-/merge_requests/3', 'gitlab', 'gitlab.com', 'group/proj'],
    ['https://me@bitbucket.org/team/repo.git', 'bitbucket', 'bitbucket.org', 'team/repo'],
    ['git@bitbucket.org:team/repo.git', 'bitbucket', 'bitbucket.org', 'team/repo']
  ])('%s', (url, provider, host, slug) => {
    expect(parseRemote(url)).toMatchObject({ provider, host, slug })
  })

  it('reads every Azure DevOps form', () => {
    const want = {
      provider: 'azure',
      host: 'dev.azure.com',
      slug: 'org/My Project/repo',
      azure: { org: 'org', project: 'My Project', repo: 'repo' }
    }
    expect(parseRemote('https://org@dev.azure.com/org/My%20Project/_git/repo')).toEqual(want)
    expect(parseRemote('https://dev.azure.com/org/My%20Project/_git/repo')).toEqual(want)
    expect(parseRemote('git@ssh.dev.azure.com:v3/org/My%20Project/repo')).toEqual(want)
    expect(parseRemote('org@vs-ssh.visualstudio.com:v3/org/My%20Project/repo')).toEqual(want)
    expect(parseRemote('https://org.visualstudio.com/My%20Project/_git/repo')).toEqual(want)
    expect(
      parseRemote('https://org.visualstudio.com/DefaultCollection/My%20Project/_git/repo')
    ).toEqual(want)
    // A repository named like its project.
    expect(parseRemote('https://dev.azure.com/org/_git/repo')?.slug).toBe('org/repo/repo')
  })

  it('uses the accounts for self-managed hosts, keeping https ports', () => {
    const known = { 'git.example.com': 'gitlab', 'ghe.example.com:8443': 'github' } as const
    expect(parseRemote('https://git.example.com/a/b/c.git', known)).toMatchObject({
      provider: 'gitlab',
      slug: 'a/b/c'
    })
    expect(parseRemote('git@git.example.com:a/b.git', known)?.provider).toBe('gitlab')
    expect(parseRemote('https://ghe.example.com:8443/o/r.git', known)).toMatchObject({
      provider: 'github',
      host: 'ghe.example.com:8443',
      slug: 'o/r'
    })
    expect(parseRemote('https://git.example.com/a/b.git')).toMatchObject({
      provider: null,
      host: 'git.example.com'
    })
  })

  it('refuses what is not a repository URL', () => {
    expect(parseRemote('C:\\repos\\x')).toBeNull()
    expect(parseRemote('/home/me/repo')).toBeNull()
    expect(parseRemote('https://github.com/onlyowner')).toBeNull()
    expect(parseRemote('https://github.com/../etc')).toBeNull()
    expect(parseRemote('https://dev.azure.com/org/project')).toBeNull()
  })

  it('builds web and clone URLs', () => {
    const azure = parseRemote('git@ssh.dev.azure.com:v3/org/My%20Project/repo')!
    expect(webUrl(azure)).toBe('https://dev.azure.com/org/My%20Project/_git/repo')
    expect(httpsCloneUrl(azure)).toBe('https://dev.azure.com/org/My%20Project/_git/repo')
    expect(httpsCloneUrl(parseRemote('git@gitlab.com:g/s/p.git')!)).toBe(
      'https://gitlab.com/g/s/p.git'
    )
  })
})

describe('normalizeCloneInput', () => {
  it('turns links of known providers into https', () => {
    expect(normalizeCloneInput('octocat/Hello-World').url).toBe(
      'https://github.com/octocat/Hello-World.git'
    )
    expect(normalizeCloneInput('git@bitbucket.org:team/repo.git').url).toBe(
      'https://bitbucket.org/team/repo.git'
    )
    expect(normalizeCloneInput('https://gitlab.com/g/p/-/tree/main').url).toBe(
      'https://gitlab.com/g/p.git'
    )
  })

  it('keeps links of unknown hosts and refuses local paths and transports', () => {
    expect(normalizeCloneInput('git@example.org:x/y.git').url).toBe('git@example.org:x/y.git')
    expect(() => normalizeCloneInput('C:\\temp\\repo')).toThrow()
    expect(() => normalizeCloneInput('ext::sh -c touch% /tmp/x')).toThrow()
    expect(() => normalizeCloneInput('--upload-pack=evil')).toThrow()
    expect(() => normalizeCloneInput('file:///etc')).toThrow()
    expect(() => normalizeCloneInput('http://example.org/x/y.git')).toThrow()
  })

  it('picks folders below the clone folder', () => {
    const { url, ref } = normalizeCloneInput('https://gitlab.com/g/sub/p.git')
    expect(cloneFolders(ref, url)).toEqual(['g', 'sub', 'p'])
    expect(cloneFolders(null, 'git@example.org:x/y.git')).toEqual(['other', 'y'])
  })
})

describe('accounts', () => {
  it('keeps the login as id for github.com', () => {
    expect(accountId('github', 'github.com', 'octocat')).toBe('octocat')
    expect(accountId('github', 'ghe.example.com', 'octocat')).toBe('github:ghe.example.com:octocat')
    expect(accountId('gitlab', 'gitlab.example.com', 'me')).toBe('gitlab:gitlab.example.com:me')
    expect(accountId('azure', 'dev.azure.com', 'me@x.com', 'Org')).toBe(
      'azure:dev.azure.com/org:me@x.com'
    )
  })

  it('normalizes hosts', () => {
    expect(normalizeHost('https://GitLab.Example.com/')).toBe('gitlab.example.com')
    expect(normalizeHost('ghe.example.com:8443/path')).toBe('ghe.example.com:8443')
    expect(normalizeHost('user@evil.com')).toBeNull()
    expect(normalizeHost('not a host')).toBeNull()
    expect(normalizeHost('')).toBeNull()
  })

  it('gives git the conventions of each provider, for its own hosts only', () => {
    expect(gitIdentity('github', 'github.com', 'octocat', null, null)).toEqual({
      username: 'octocat',
      hosts: ['github.com']
    })
    expect(gitIdentity('gitlab', 'git.example.com', 'me', null, null)).toEqual({
      username: 'oauth2',
      hosts: ['git.example.com']
    })
    expect(gitIdentity('bitbucket', 'bitbucket.org', 'me', 'me@example.com', null)).toEqual({
      username: 'x-bitbucket-api-token-auth',
      hosts: ['bitbucket.org']
    })
    expect(gitIdentity('bitbucket', 'bitbucket.org', 'me', 'myname', null)?.username).toBe('myname')
    expect(gitIdentity('azure', 'dev.azure.com', 'me', null, 'Org')?.hosts).toEqual([
      'dev.azure.com',
      'org.visualstudio.com'
    ])
  })
})
