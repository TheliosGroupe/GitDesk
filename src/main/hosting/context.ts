// Which repository is on which host, and which accounts may talk to it.

import type { HostingProvider, RemoteInfo } from '../../shared/features/hosting'
import { allAuth, authFor, type AccountAuth } from '../accounts'
import { originUrl as cachedOriginUrl } from '../repo'
import { findStoredPath } from '../paths'
import { accountFor, loadState } from '../store'
import { pool } from './http'
import { clientFor, type ProviderClient } from './providers'
import { parseRemote, remoteInfo, type RemoteRef } from './remote'

/** Self-managed hosts of the signed-in accounts (GitHub Enterprise, GitLab). */
export function knownHosts(): Record<string, HostingProvider> {
  const map: Record<string, HostingProvider> = {}
  for (const a of allAuth()) map[a.account.host] = a.account.provider
  return map
}

/**
 * origin's URL (null without one). Cached in repo.ts until the repository's config file
 * changes, so the Launchpad, the dashboard and the sidebar do not run git for it each time.
 */
export function originUrl(repo: string): Promise<string | null> {
  return cachedOriginUrl(repo)
}

/** Repositories read at the same time (a long list must not start hundreds of processes). */
const REMOTES_CONCURRENCY = 8

/** Where origin points (null: no origin or not a URL GitDesk understands). */
export async function originRef(repo: string): Promise<RemoteRef | null> {
  const url = await originUrl(repo)
  return url ? parseRemote(url, knownHosts()) : null
}

/** Does this account belong to the host (and Azure organization) of the repository? */
export function accountMatches(auth: AccountAuth, ref: RemoteRef): boolean {
  const a = auth.account
  if (a.provider !== ref.provider || a.host !== ref.host) return false
  if (a.provider === 'azure')
    return (a.organization ?? '').toLowerCase() === (ref.azure?.org ?? '').toLowerCase()
  return true
}

/** Accounts for the repository's host, the one linked to `repo` first. */
export function accountsFor(ref: RemoteRef, repo: string | null): AccountAuth[] {
  const linked = repo ? accountFor(repo) : null
  return allAuth()
    .filter((a) => accountMatches(a, ref))
    .sort((a, b) => Number(b.account.id === linked) - Number(a.account.id === linked))
}

export const accountLabel = (a: AccountAuth): string => {
  const { provider, host, login, organization } = a.account
  const where =
    provider === 'azure'
      ? `Azure DevOps (${organization})`
      : `${{ github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' }[provider]}${
          host === 'github.com' || host === 'gitlab.com' || host === 'bitbucket.org'
            ? ''
            : ` (${host})`
        }`
  return `${login} on ${where}`
}

export function clientOf(auth: AccountAuth): ProviderClient {
  return clientFor({
    provider: auth.account.provider,
    host: auth.account.host,
    token: auth.token,
    username: auth.username,
    organization: auth.account.organization,
    accountId: auth.account.id,
    accountLabel: accountLabel(auth)
  })
}

export function requireAuth(id: string): AccountAuth {
  const auth = typeof id === 'string' ? authFor(id) : null
  if (!auth) throw new Error(`Not signed in to this account (${id}).`)
  return auth
}

/** Tries each account in turn; the first that succeeds wins, otherwise the last error. */
export async function withAccounts<T>(
  accounts: AccountAuth[],
  fn: (client: ProviderClient, auth: AccountAuth) => Promise<T>
): Promise<T> {
  let lastError: unknown = new Error('No account')
  for (const auth of accounts) {
    try {
      return await fn(clientOf(auth), auth)
    } catch (e) {
      lastError = e
    }
  }
  throw lastError
}

export function providerName(ref: RemoteRef): string {
  return ref.provider
    ? { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', azure: 'Azure DevOps' }[
        ref.provider
      ]
    : ref.host
}

// Registered repositories by remote, for the Launchpad ("Check out" when cloned here).
let remoteCache: { at: number; map: Map<string, string> } | null = null
const repoKey = (host: string, slug: string): string => `${host}|${slug.toLowerCase()}`

export async function remotesOf(repos: string[]): Promise<Record<string, RemoteInfo | null>> {
  const state = loadState()
  const known = knownHosts()
  const out: Record<string, RemoteInfo | null> = {}
  const list = Array.isArray(repos) ? repos.slice(0, 1000) : []
  await pool(list, REMOTES_CONCURRENCY, async (path) => {
    const registered = typeof path === 'string' && findStoredPath(state.repos, path)
    if (!registered) return
    const url = await originUrl(registered).catch(() => null)
    const ref = url ? parseRemote(url, known) : null
    out[path] = ref ? remoteInfo(ref) : null
  })
  return out
}

export async function localRepoIndex(): Promise<Map<string, string>> {
  if (remoteCache && Date.now() - remoteCache.at < 60_000) return remoteCache.map
  const state = loadState()
  const infos = await remotesOf(state.repos)
  const map = new Map<string, string>()
  for (const [path, info] of Object.entries(infos)) {
    if (!info) continue
    const key = repoKey(info.host, info.slug)
    const existing = map.get(key)
    // Worktrees share their main repository's origin: prefer the main repository.
    if (!existing || (state.worktreeParents[existing] && !state.worktreeParents[path]))
      map.set(key, path)
  }
  remoteCache = { at: Date.now(), map }
  return map
}

export function forgetRemoteIndex(): void {
  remoteCache = null
}

export function localRepoFor(
  index: Map<string, string>,
  host: string | null,
  slug: string | null
): string | null {
  return host && slug ? (index.get(repoKey(host, slug)) ?? null) : null
}
