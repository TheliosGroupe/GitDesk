// Text helpers for accounts and links (no components, so React fast refresh stays happy).

import type { Account } from '../../../../shared/types'
import { DEFAULT_HOSTS, PROVIDER_LABELS } from '../../../../shared/features/hosting'

/** "octocat", or "octocat · GitLab (gitlab.example.com)" for other providers and hosts. */
export function accountLabel(a: Account): string {
  if (a.provider === 'github' && a.host === 'github.com') return a.login
  const where =
    a.provider === 'azure'
      ? `${PROVIDER_LABELS.azure} (${a.organization})`
      : a.host === DEFAULT_HOSTS[a.provider]
        ? PROVIDER_LABELS[a.provider]
        : `${PROVIDER_LABELS[a.provider]} (${a.host})`
  return `${a.login} · ${where}`
}

export function profileUrl(a: Account): string | null {
  if (a.provider === 'github' || a.provider === 'gitlab')
    return `https://${a.host}/${encodeURIComponent(a.login)}`
  if (a.provider === 'azure' && a.organization)
    return `https://dev.azure.com/${encodeURIComponent(a.organization)}`
  return a.provider === 'bitbucket' ? 'https://bitbucket.org/account/settings/' : null
}

/** Folders below the clone folder the main process will use (preview only). */
export function cloneFoldersOf(input: string): string[] | null {
  const text = input.trim()
  const short = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(text)
  if (short) return [short[1], short[2]]
  const m =
    /^(?:https?|ssh):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^?#\s]+)/i.exec(text) ??
    /^(?:[^@/\s:]+@)?([\w.-]+):([^?#\s]+)$/.exec(text)
  if (!m) return null
  const host = m[1].toLowerCase()
  let path = m[2].split('/').filter(Boolean)
  if (host === 'dev.azure.com' || host.endsWith('visualstudio.com')) {
    if (path[0] === 'v3') path = path.slice(1)
    else if (host.endsWith('.visualstudio.com') && host !== 'vs-ssh.visualstudio.com')
      path = [host.split('.')[0], ...path.filter((p) => p.toLowerCase() !== 'defaultcollection')]
    path = path.filter((p) => p !== '_git')
    if (path.length === 2) path = [path[0], path[1], path[1]]
    path = path.slice(0, 3)
  } else {
    const cut = path.indexOf('-')
    if (cut >= 0) path = path.slice(0, cut)
    if (/(^|\.)github\.com$|^bitbucket\.org$/.test(host)) path = path.slice(0, 2)
  }
  path = path.map((p) => {
    try {
      return decodeURIComponent(p).replace(/\.git$/i, '')
    } catch {
      return p
    }
  })
  return path.length >= 2 ? path : null
}
