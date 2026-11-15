import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  credentialConfig,
  git,
  setAuthResolver,
  setGitIdentityResolver,
  type GitAuth
} from '../../src/main/git'

// Runs the real `git credential fill` with GitDesk's helper, isolated from the user's
// git configuration (no system / global helpers that could answer instead).
const work = mkdtempSync(join(tmpdir(), 'gitdesk-cred-'))
const emptyConfig = join(work, 'gitconfig')
writeFileSync(emptyConfig, '')
afterAll(() => rmSync(work, { recursive: true, force: true }))

function fill(auth: GitAuth | null, request: Record<string, string>): string {
  const config = credentialConfig(auth)
  const input = Object.entries(request)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('')
  const r = spawnSync('git', [...(config?.args ?? []), 'credential', 'fill'], {
    cwd: work,
    input: input + '\n',
    encoding: 'utf8',
    env: {
      ...process.env,
      ...config?.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyConfig
    }
  })
  return r.stdout
}

const gitlab: GitAuth = {
  login: 'gitlab:git.example.com:me',
  token: 'glpat-secret',
  username: 'oauth2',
  hosts: ['git.example.com']
}

describe('credential helper', () => {
  it('answers for the linked host over https', () => {
    const out = fill(gitlab, { protocol: 'https', host: 'git.example.com', path: 'g/p.git' })
    expect(out).toContain('username=oauth2')
    expect(out).toContain('password=glpat-secret')
  })

  it('never answers for another host, a look-alike host, another port or plain http', () => {
    const requests: Record<string, string>[] = [
      { protocol: 'https', host: 'github.com' },
      { protocol: 'https', host: 'git.example.com.evil.com' },
      { protocol: 'https', host: 'evil.com', path: 'git.example.com' },
      { protocol: 'https', host: 'git.example.com:8443' },
      { protocol: 'http', host: 'git.example.com' }
    ]
    for (const request of requests) {
      expect(fill(gitlab, request), JSON.stringify(request)).not.toContain('glpat-secret')
    }
  })

  it('answers for each Azure DevOps host of the organization', () => {
    const azure: GitAuth = {
      login: 'azure:dev.azure.com/org:me',
      token: 'azure-pat',
      username: 'gitdesk',
      hosts: ['dev.azure.com', 'org.visualstudio.com']
    }
    expect(fill(azure, { protocol: 'https', host: 'dev.azure.com' })).toContain(
      'password=azure-pat'
    )
    expect(fill(azure, { protocol: 'https', host: 'org.visualstudio.com' })).toContain(
      'password=azure-pat'
    )
    expect(fill(azure, { protocol: 'https', host: 'other.visualstudio.com' })).not.toContain(
      'azure-pat'
    )
  })

  it('keeps the token out of the command line', () => {
    const config = credentialConfig(gitlab)!
    expect(config.args.join(' ')).not.toContain('glpat-secret')
    expect(config.env.GITDESK_CRED_TOKEN).toBe('glpat-secret')
  })

  it('refuses unknown accounts and malformed hosts', () => {
    // Without the account store, only github.com logins (ids without ":") resolve.
    expect(credentialConfig({ login: 'gitlab:x:me', token: 't' })).toBeNull()
    expect(credentialConfig({ login: 'x', token: 't', username: 'u', hosts: ['a b'] })).toBeNull()
    expect(
      credentialConfig({ login: 'x', token: 't\nhost=evil', username: 'u', hosts: ['a.com'] })
    ).toBeNull()
    const legacy = credentialConfig({ login: 'octocat', token: 'gho_x' })
    expect(legacy?.env).toMatchObject({
      GITDESK_CRED_USER: 'octocat',
      GITDESK_CRED_HOSTS: 'github.com'
    })
  })

  it('uses the account store to resolve an id', () => {
    setGitIdentityResolver((id) =>
      id === 'bitbucket:bitbucket.org:me'
        ? { username: 'x-bitbucket-api-token-auth', hosts: ['bitbucket.org'] }
        : null
    )
    const out = fill(
      { login: 'bitbucket:bitbucket.org:me', token: 'bb-token' },
      { protocol: 'https', host: 'bitbucket.org' }
    )
    expect(out).toContain('username=x-bitbucket-api-token-auth')
    expect(out).toContain('password=bb-token')
    expect(credentialConfig({ login: 'someone-else', token: 't' })).toBeNull()
  })
})

describe('hooks', () => {
  it('commit hooks do not see the token; commands that may fetch get it', async () => {
    const repo = join(work, 'hooks')
    mkdirSync(repo)
    const seen = join(work, 'hook-env.txt')
    await git(repo, ['init', '-q', '-b', 'main'])
    await git(repo, ['config', 'user.name', 'T'])
    await git(repo, ['config', 'user.email', 't@example.com'])
    await git(repo, ['config', 'core.hooksPath', '.git/hooks'])
    const log = seen.split('\\').join('/')
    const hook = `#!/bin/sh\necho "$1:\${GITDESK_CRED_TOKEN:-none}" >> "${log}"\n`
    for (const name of ['pre-commit', 'commit-msg'])
      writeFileSync(join(repo, '.git', 'hooks', name), hook, { mode: 0o755 })
    setGitIdentityResolver(() => ({ username: 'me', hosts: ['github.com'] }))
    setAuthResolver(() => ({ login: 'me', token: 'hook-secret' }))
    try {
      writeFileSync(join(repo, 'a.txt'), 'a\n')
      await git(repo, ['add', 'a.txt'])
      await git(repo, ['commit', '--quiet', '-m', 'one'])
      // `git hook run` stands in for any command that keeps the credentials.
      await git(repo, ['hook', 'run', 'pre-commit', '--', 'other'])
    } finally {
      setAuthResolver(() => null)
    }
    const lines = readFileSync(seen, 'utf8').trim().split(/\r?\n/)
    expect(lines[0]).toBe(':none')
    expect(lines[1]).toMatch(/COMMIT_EDITMSG:none$/)
    expect(lines[2]).toBe('other:hook-secret')
  })
})
