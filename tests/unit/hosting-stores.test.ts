// What GitDesk saves from sign-ins and provider answers: identities are strings or refused,
// files written with odd values heal on load, and pictures cached by login are scoped by
// service. Electron is replaced by a temp folder and a fake key store.

import { readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('path') as typeof import('path')
  return mkdtempSync(join(tmpdir(), 'gitdesk-stores-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => dir, isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  net: {},
  session: {}
}))

// Pictures: no network; each download is recorded and answered by URL.
const downloads: string[] = []
vi.mock('../../src/main/hosting/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/hosting/http')>()
  return {
    ...real,
    downloadPicture: async (url: string) => {
      downloads.push(url)
      return url.includes('missing')
        ? null
        : `data:image/png;base64,${Buffer.from(url).toString('base64')}`
    }
  }
})

const accountsFile = join(dir, 'accounts.json')
const integrationsFile = join(dir, 'integrations.json')
const avatarsFile = join(dir, 'avatars.json')

let server: Server
let answer: (path: string) => unknown = () => ({})

beforeAll(async () => {
  writeFileSync(
    accountsFile,
    JSON.stringify([
      { login: 'good', name: 'Good', avatar: null, token: 'enc:t1' },
      { login: { nested: 1 }, name: 'x', avatar: null, token: 'enc:t2' },
      { login: 'ctrl\u0007', token: 'enc:t3' },
      { provider: 'gitlab', host: 'not a host', login: 'gl', token: 'enc:t4' },
      {
        provider: 'azure',
        host: 'dev.azure.com',
        organization: '..',
        login: 'az',
        token: 'enc:t5'
      },
      { login: 'named', name: ['array'], avatar: 'javascript:x', token: 'enc:t6' },
      // Older github.com entries without a usable host: still github.com.
      { login: 'nohost', host: null, avatar: null, token: 'enc:t7' },
      { login: 'emptyhost', host: '', avatar: null, token: 'enc:t8' },
      'junk'
    ])
  )
  writeFileSync(
    integrationsFile,
    JSON.stringify({
      jira: {
        site: 'https://acme.atlassian.net',
        email: 'me@acme.test',
        user: { x: 1 },
        token: 'enc:j'
      },
      linear: { user: 42, token: 'enc:l' }
    })
  )
  writeFileSync(
    avatarsFile,
    JSON.stringify({
      '@alice': { data: 'data:image/png;base64,b2xk', checked: Date.now(), login: 'alice' },
      'a@b.test': { data: 'data:image/png;base64,ZW1haWw=', checked: Date.now(), login: null },
      'bad@b.test': { data: { nested: 1 }, checked: Date.now() }
    })
  )
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer(req.url!) ?? null))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const { setApiOverrides, setFetch } = await import('../../src/main/hosting/http')
  setFetch((url, init) => fetch(url, init))
  setApiOverrides({
    'ghe.example.test': `${base}/ghe`,
    'acme.atlassian.net': `${base}/jira`,
    'linear.app': `${base}/linear`
  })
})

afterAll(async () => {
  server.close()
  // avatars.json is written a second after the last change.
  await new Promise((r) => setTimeout(r, 1200))
  rmSync(dir, { recursive: true, force: true })
})

describe('accounts', () => {
  it('drops unusable entries on load, with their tokens', async () => {
    const { listAccounts } = await import('../../src/main/accounts')
    const list = listAccounts()
    expect(list.map((a) => a.login)).toEqual(['good', 'named', 'nohost', 'emptyhost'])
    expect(list[1]).toMatchObject({ name: null, avatar: null })
    expect(list.slice(2).map((a) => a.host)).toEqual(['github.com', 'github.com'])
    const saved = JSON.parse(readFileSync(accountsFile, 'utf8')) as { token: string }[]
    expect(saved.map((a) => a.token)).toEqual(['enc:t1', 'enc:t6', 'enc:t7', 'enc:t8'])
  })

  it('refuses a sign-in whose identity is not a string, and keeps names strings', async () => {
    const { addTokenAccount, listAccounts } = await import('../../src/main/accounts')
    for (const login of [{ nested: 1 }, ['a'], 7, '', 'a\nb']) {
      answer = () => ({ login, name: 'x' })
      await expect(
        addTokenAccount({ provider: 'github', host: 'ghe.example.test', token: 'tok' })
      ).rejects.toThrow(/did not say who/)
    }
    answer = () => ({ login: 'octo', name: { nested: 1 }, avatar_url: 12 })
    const account = await addTokenAccount({
      provider: 'github',
      host: 'ghe.example.test',
      token: 'tok'
    })
    expect(account).toMatchObject({ id: 'github:ghe.example.test:octo', login: 'octo', name: null })
    expect(listAccounts().every((a) => typeof a.login === 'string')).toBe(true)
  })

  it('refuses an Azure DevOps organization made of dots', async () => {
    const { addTokenAccount } = await import('../../src/main/accounts')
    await expect(
      addTokenAccount({ provider: 'azure', organization: '..', token: 'tok' })
    ).rejects.toThrow(/organization/)
  })
})

describe('issue trackers', () => {
  it('heals stored identities that are not strings', async () => {
    const { trackers } = await import('../../src/main/hosting/trackers')
    expect(trackers()).toEqual({
      jira: { site: 'https://acme.atlassian.net', email: 'me@acme.test', user: null },
      linear: { user: null }
    })
  })

  it('stores only string identities from Jira and Linear', async () => {
    const { configureTracker, testTracker } = await import('../../src/main/hosting/trackers')
    answer = () => ({ displayName: { nested: 1 } })
    let t = await configureTracker({
      kind: 'jira',
      site: 'acme.atlassian.net',
      email: 'me@acme.test',
      token: 'tok'
    })
    expect(t.jira?.user).toBeNull()
    expect(await testTracker('jira')).toBe('Connected to acme.atlassian.net as me@acme.test')
    answer = () => ({ data: { viewer: { name: ['x'] } } })
    t = await configureTracker({ kind: 'linear', apiKey: 'key' })
    expect(t.linear?.user).toBeNull()
    answer = () => ({ data: { viewer: { name: 'Lin' } } })
    t = await configureTracker({ kind: 'linear', apiKey: 'key' })
    expect(t.linear?.user).toBe('Lin')
    const saved = JSON.parse(readFileSync(integrationsFile, 'utf8'))
    expect(saved.jira.user).toBeNull()
    expect(saved.linear.user).toBe('Lin')
  })

  it('lists issues without the malformed ones', async () => {
    const { trackerIssues } = await import('../../src/main/hosting/trackers')
    answer = (path) =>
      path.startsWith('/jira')
        ? { issues: [{ key: 'P-1', fields: { summary: 'ok' } }, { key: { x: 1 } }, 'junk'] }
        : {
            data: {
              viewer: {
                assignedIssues: {
                  nodes: [
                    { identifier: 'E-1', title: { x: 1 }, url: 'https://linear.app/i/E-1' },
                    { identifier: 'E-2', title: 'ok', url: 'https://linear.app/i/E-2' }
                  ]
                }
              }
            }
          }
    const r = await trackerIssues()
    expect(r.errors).toEqual([])
    expect(r.issues.map((i) => i.key).sort()).toEqual(['E-2', 'P-1'])
  })
})

describe('pictures by login', () => {
  it('keeps the same login on two services apart, and forgets unscoped entries', async () => {
    const { loginAvatars } = await import('../../src/main/avatars')
    downloads.length = 0
    const gitlab = await loginAvatars(
      new Map([['alice', 'https://gitlab.example/alice.png']]),
      'gitlab:gitlab.com'
    )
    const github = await loginAvatars(new Map([['alice', 'https://avatars.example/alice.png']]))
    // The old "@alice" entry is not reused; each service downloads its own picture.
    expect(downloads).toEqual([
      'https://gitlab.example/alice.png',
      'https://avatars.example/alice.png'
    ])
    expect(gitlab.alice).not.toBe(github.alice)
    expect(github.alice).not.toBe('data:image/png;base64,b2xk')
    // Cached per service from now on.
    await loginAvatars(new Map([['Alice', 'https://avatars.example/other.png']]))
    expect(downloads).toHaveLength(2)
  })

  it('drops cached pictures that are not data: images', async () => {
    const { identityOf } = await import('../../src/main/avatars')
    expect(identityOf('a@b.test').avatar).toBe('data:image/png;base64,ZW1haWw=')
    expect(identityOf('bad@b.test').avatar).toBeNull()
  })
})

describe('accounts file without broken identities', () => {
  it('is left as it is when an entry is only unusable (unknown host)', async () => {
    const entries = [
      { login: 'good', token: 'enc:t1' },
      { provider: 'gitlab', host: 'not a host', login: 'gl', token: 'enc:t4' }
    ]
    const text = JSON.stringify(entries)
    writeFileSync(accountsFile, text)
    vi.resetModules()
    const { listAccounts } = await import('../../src/main/accounts')
    expect(listAccounts().map((a) => a.login)).toEqual(['good'])
    expect(readFileSync(accountsFile, 'utf8')).toBe(text)
  })
})
