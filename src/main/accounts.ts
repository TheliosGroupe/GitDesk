import { app, safeStorage } from 'electron'
import { join } from 'path'
import type { Account, DeviceCode } from '../shared/types'
import type { HostingProvider, TokenSignIn } from '../shared/features/hosting'
import { setGitIdentityResolver, type GitAuth, type GitIdentity } from './git'
import { canAccess, getUser, pollDeviceToken, requestDeviceCode } from './github'
import { downloadPicture } from './hosting/http'
import { accountId, gitIdentity, normalizeHost } from './hosting/identity'
import { clientFor } from './hosting/providers'
import { dotsOnly, userName } from './hosting/validate'
import { requireSecureStorage } from './secureStorage'
import { readJsonStore, writeJsonAtomic } from './store'

interface StoredAccount {
  /** Missing in files written before other providers existed: github.com then. */
  id?: string
  provider?: HostingProvider
  host?: string
  organization?: string | null
  /** Bitbucket: the email / user name used with the token (Basic auth). */
  username?: string | null
  login: string
  name: string | null
  avatar: string | null
  /** Token encrypted with the OS key store (DPAPI on Windows), base64. */
  token: string
  /** ms since epoch; null when the token does not expire. */
  expiresAt?: number | null
}

/** A stored account with every field filled in (older entries are github.com accounts). */
type Stored = Required<Omit<StoredAccount, 'expiresAt'>> & { expiresAt: number | null }

const PROVIDERS: HostingProvider[] = ['github', 'gitlab', 'bitbucket', 'azure']

let accounts: Stored[] | null = null
const tokens = new Map<string, string>()

function file(): string {
  return join(app.getPath('userData'), 'accounts.json')
}

/** An Azure DevOps organization name (one URL path segment). */
const isOrganization = (s: string): boolean => /^[\w.-]{1,100}$/.test(s) && !dotsOnly(s)

const providerOf = (a: StoredAccount): HostingProvider =>
  a.provider && PROVIDERS.includes(a.provider) ? a.provider : 'github'

/** Login, token and Azure organization: an entry failing these is removed from the file. */
function identityOk(a: StoredAccount): boolean {
  if (!userName(a.login) || typeof a.token !== 'string' || !a.token) return false
  const org = a.organization
  return providerOf(a) !== 'azure' || (typeof org === 'string' && isOrganization(org))
}

/** A stored entry with its fields checked, or null when it cannot be used. */
function complete(raw: unknown): Stored | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as StoredAccount
  if (!identityOk(a)) return null
  const login = userName(a.login)!
  const provider = providerOf(a)
  // Older files may hold no usable host: github.com then, as before.
  const host =
    normalizeHost(typeof a.host === 'string' ? a.host : '') ??
    (provider === 'github' ? 'github.com' : null)
  if (!host) return null
  const organization = typeof a.organization === 'string' ? a.organization : null
  return {
    id:
      typeof a.id === 'string' && a.id && a.id.length <= 600
        ? a.id
        : accountId(provider, host, login, organization),
    provider,
    host,
    organization,
    username: typeof a.username === 'string' ? a.username : null,
    login,
    name: userName(a.name),
    avatar: typeof a.avatar === 'string' && a.avatar.startsWith('data:image/') ? a.avatar : null,
    token: a.token,
    expiresAt: typeof a.expiresAt === 'number' ? a.expiresAt : null
  }
}

function load(): Stored[] {
  if (accounts) return accounts
  // A damaged file is kept aside (and one that cannot be read is never overwritten).
  const raw = readJsonStore(file(), [])
  const entries: unknown[] = Array.isArray(raw) ? raw : []
  accounts = entries.flatMap((a) => complete(a) ?? [])
  // An entry with a broken identity is dropped from the file too, with its encrypted token.
  // Others that cannot be used (unknown host...) stay until the next change, as before.
  if (entries.some((a) => !!a && typeof a === 'object' && !identityOk(a as StoredAccount)))
    try {
      save()
    } catch {
      /* read-only folder: dropped again on the next start */
    }
  return accounts
}

function save(): void {
  writeJsonAtomic(file(), load())
}

function toAccount(a: Stored): Account {
  return {
    id: a.id,
    provider: a.provider,
    host: a.host,
    organization: a.organization,
    login: a.login,
    name: a.name,
    avatar: a.avatar,
    tokenExpires: a.expiresAt !== null,
    expired: a.expiresAt !== null && a.expiresAt < Date.now()
  }
}

export function listAccounts(): Account[] {
  return load().map(toAccount)
}

export function getAccount(id: string): Account | null {
  const a = load().find((x) => x.id === id)
  return a ? toAccount(a) : null
}

/** The account with what its API calls need (token decrypted on demand). */
export interface AccountAuth {
  account: Account
  token: string
  /** Bitbucket: the user name / email for Basic auth. */
  username: string | null
}

export function authFor(id: string): AccountAuth | null {
  const a = load().find((x) => x.id === id)
  const token = a ? tokenFor(id) : null
  return a && token ? { account: toAccount(a), token, username: a.username } : null
}

/** Every account (with its token) of the given providers. */
export function allAuth(providers: HostingProvider[] = PROVIDERS): AccountAuth[] {
  return load()
    .filter((a) => providers.includes(a.provider))
    .flatMap((a) => authFor(a.id) ?? [])
}

/** Decrypted token of an account, by id. */
export function tokenFor(id: string): string | null {
  const cached = tokens.get(id)
  if (cached) return cached
  const account = load().find((a) => a.id === id)
  if (!account) return null
  try {
    const token = safeStorage.decryptString(Buffer.from(account.token, 'base64'))
    tokens.set(id, token)
    return token
  } catch {
    return null
  }
}

/** How git authenticates for an account id (see the credential helper in git.ts). */
function identityOf(id: string): GitIdentity | null {
  const a = load().find((x) => x.id === id)
  return a ? gitIdentity(a.provider, a.host, a.login, a.username, a.organization) : null
}
setGitIdentityResolver(identityOf)

/** Credentials git may use for a repository linked to this account. */
export function gitAuthFor(id: string | null): GitAuth | null {
  if (!id) return null
  const token = tokenFor(id)
  const identity = identityOf(id)
  return token && identity ? { login: id, token, ...identity } : null
}

/**
 * Every signed-in github.com account with its token, the given one first. Only
 * github.com: these tokens go to api.github.com (avatars, activity, pull requests).
 */
export function tokensInOrder(preferred: string | null): { login: string; token: string }[] {
  const ids = load()
    .filter((a) => a.provider === 'github' && a.host === 'github.com')
    .map((a) => a.id)
  if (preferred) ids.sort((a, b) => Number(b === preferred) - Number(a === preferred))
  return ids.flatMap((id) => {
    const token = tokenFor(id)
    return token ? [{ login: id, token }] : []
  })
}

/** First signed-in github.com account that can see `owner/repo`. */
export async function accountForSlug(slug: string): Promise<string | null> {
  for (const { login, token } of tokensInOrder(null)) {
    if (await canAccess(token, slug)) return login
  }
  return null
}

/** A public profile picture (no credentials) as a data: URL; see downloadPicture. */
export function downloadImage(url: string): Promise<string | null> {
  return downloadPicture(url)
}

function store(stored: Stored, token: string): Account {
  accounts = [...load().filter((a) => a.id !== stored.id), stored]
  tokens.set(stored.id, token)
  save()
  return toAccount(stored)
}

function encrypt(token: string): string {
  requireSecureStorage()
  return safeStorage.encryptString(token).toString('base64')
}

async function addGitHubDeviceAccount({
  token,
  expiresIn
}: {
  token: string
  expiresIn: number | null
}): Promise<Account> {
  const user = await getUser(token)
  const login = userName(user.login)
  if (!login) throw new Error('GitHub did not say who this token belongs to.')
  const url = user.avatar_url
  const avatar = url ? await downloadImage(`${url}${url.includes('?') ? '&' : '?'}s=64`) : null
  return store(
    {
      id: login,
      provider: 'github',
      host: 'github.com',
      organization: null,
      username: null,
      login,
      name: userName(user.name),
      avatar,
      token: encrypt(token),
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null
    },
    token
  )
}

/** Adds an account from a personal access token, after checking it with the provider. */
export async function addTokenAccount(input: TokenSignIn): Promise<Account> {
  if (!input || !PROVIDERS.includes(input.provider)) throw new Error('Unknown provider.')
  const provider = input.provider
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (!token || /\s/.test(token)) throw new Error('Paste the token (it has no spaces).')
  const defaultHost = { github: 'github.com', gitlab: 'gitlab.com' }[provider as string]
  const typedHost = typeof input.host === 'string' ? input.host.trim() : ''
  const host =
    provider === 'bitbucket'
      ? 'bitbucket.org'
      : provider === 'azure'
        ? 'dev.azure.com'
        : normalizeHost(typedHost || defaultHost!)
  if (!host) throw new Error(`"${typedHost}" is not a host name (e.g. gitlab.example.com).`)
  const organization =
    provider === 'azure' ? (typeof input.organization === 'string' ? input.organization : '') : ''
  if (provider === 'azure' && !isOrganization(organization.trim()))
    throw new Error('Enter your Azure DevOps organization (dev.azure.com/<organization>).')
  const username = provider === 'bitbucket' ? (input.username ?? '').trim() : ''
  if (provider === 'bitbucket' && (!username || /[\s:]/.test(username)))
    throw new Error('Enter your Atlassian email (API token) or Bitbucket username (app password).')
  requireSecureStorage()

  const client = clientFor({
    provider,
    host,
    token,
    username: username || null,
    organization: organization.trim() || null
  })
  const user = await client.user()
  // The clients check this already; the account id and the file depend on it.
  const login = userName(user.login)
  if (!login) throw new Error('The service did not say who this token belongs to.')
  const avatar = typeof user.avatarUrl === 'string' ? await client.avatar(user.avatarUrl) : null
  const org = provider === 'azure' ? organization.trim() : null
  return store(
    {
      id: accountId(provider, host, login, org),
      provider,
      host,
      organization: org,
      username: username || null,
      login,
      name: userName(user.name),
      avatar,
      token: encrypt(token),
      expiresAt: null
    },
    token
  )
}

export function removeAccount(id: string): Account[] {
  accounts = load().filter((a) => a.id !== id)
  tokens.delete(id)
  save()
  return listAccounts()
}

// ---------------------------------------------------------------------------
// Sign-in (GitHub device flow)
// ---------------------------------------------------------------------------

let pending: { controller: AbortController; result: Promise<Account> } | null = null

export async function startSignIn(clientId: string): Promise<DeviceCode> {
  if (!clientId) throw new Error('Add the Client ID of your GitHub OAuth App in Settings first.')
  requireSecureStorage()
  cancelSignIn()
  const code = await requestDeviceCode(clientId)
  const controller = new AbortController()
  const result = pollDeviceToken(clientId, code, controller.signal).then(addGitHubDeviceAccount)
  result.catch(() => undefined) // reported by finishSignIn
  pending = { controller, result }
  return {
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    expiresIn: code.expires_in
  }
}

export async function finishSignIn(): Promise<Account> {
  if (!pending) throw new Error('No sign-in in progress.')
  const current = pending
  try {
    return await current.result
  } finally {
    if (pending === current) pending = null
  }
}

export function cancelSignIn(): void {
  pending?.controller.abort()
  pending = null
}
