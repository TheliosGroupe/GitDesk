// Pure helpers about accounts: ids, hosts, and how git authenticates for each provider.
// No Electron imports, so unit tests can load this file.

import type { HostingProvider } from '../../shared/features/hosting'

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::\\d{1,5})?$`)

/**
 * "GitLab.Example.com", "https://gitlab.example.com/", "gitlab.example.com:8443/x" ->
 * the lowercase host (with its port); null when it is not a host name.
 */
export function normalizeHost(input: string): string | null {
  let text = input.trim().toLowerCase()
  if (!text) return null
  text = text.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')
  if (text.includes('@')) return null
  return HOST.test(text) && text.length <= 253 ? text : null
}

/**
 * Stable account id. github.com accounts keep their login as id, so repositories
 * linked before other providers existed (repoAccounts values) still match.
 */
export function accountId(
  provider: HostingProvider,
  host: string,
  login: string,
  organization: string | null = null
): string {
  if (provider === 'github' && host === 'github.com') return login
  if (provider === 'azure') return `azure:${host}/${(organization ?? '').toLowerCase()}:${login}`
  return `${provider}:${host}:${login}`
}

/** Hosts git sees for an Azure DevOps organization (new and legacy URLs). */
export function azureHosts(organization: string | null): string[] {
  const org = (organization ?? '').toLowerCase()
  return [
    'dev.azure.com',
    ...(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(org) ? [`${org}.visualstudio.com`] : [])
  ]
}

/**
 * User name and hosts for git's credential helper. The token is only ever offered to
 * these hosts (over https):
 * - GitHub: the login (any user name works with a token), the account's host only.
 * - GitLab: "oauth2" with the personal access token.
 * - Bitbucket: an Atlassian API token goes with "x-bitbucket-api-token-auth"; an app
 *   password with the Bitbucket user name.
 * - Azure DevOps: any user name with the PAT; dev.azure.com and <org>.visualstudio.com.
 */
export function gitIdentity(
  provider: HostingProvider,
  host: string,
  login: string,
  username: string | null,
  organization: string | null
): { username: string; hosts: string[] } | null {
  switch (provider) {
    case 'github':
      return { username: login, hosts: [host] }
    case 'gitlab':
      return { username: 'oauth2', hosts: [host] }
    case 'bitbucket':
      if (!username) return null
      return {
        username: username.includes('@') ? 'x-bitbucket-api-token-auth' : username,
        hosts: ['bitbucket.org']
      }
    case 'azure':
      return { username: 'gitdesk', hosts: azureHosts(organization) }
    default:
      return null
  }
}
