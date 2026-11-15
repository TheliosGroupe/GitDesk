// Pure parsing of repository URLs for every provider. No Electron imports (unit tested).

import type { HostingProvider, RemoteInfo } from '../../shared/features/hosting'

/** A repository on a hosting service, as read from a remote URL. */
export interface RemoteRef {
  provider: HostingProvider | null
  /** Web / API host (lowercase, with a port if any). Azure DevOps: always dev.azure.com. */
  host: string
  /** "owner/repo"; GitLab "group/sub/repo"; Azure DevOps "org/project/repo". */
  slug: string
  /** Azure DevOps parts. */
  azure?: { org: string; project: string; repo: string }
}

/** Hosts of the cloud services. Self-managed hosts come from the accounts (`known`). */
export function cloudProvider(host: string): HostingProvider | null {
  if (host === 'github.com' || host === 'www.github.com') return 'github'
  if (host === 'gitlab.com') return 'gitlab'
  if (host === 'bitbucket.org') return 'bitbucket'
  if (
    host === 'dev.azure.com' ||
    host === 'ssh.dev.azure.com' ||
    host === 'vs-ssh.visualstudio.com' ||
    host.endsWith('.visualstudio.com')
  )
    return 'azure'
  return null
}

// Checked after decoding: a segment that still holds "%" was encoded twice, and could turn
// into a dot segment or a slash once it is put into an API URL.
const SEGMENT = /^[\w.~-]+$/
/** ".", "..", "...": path steps, never names. */
const dotsOnly = (s: string): boolean => /^\.+$/.test(s)
/** An owner, group or repository name: not empty and not a path step. */
const isName = (s: string): boolean => s.length > 0 && !dotsOnly(s)
const decode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Splits a remote URL into host and path; https, ssh:// and scp-like `user@host:path`. */
function splitUrl(url: string): { host: string; path: string[]; user: string | null } | null {
  const text = url.trim()
  let m = /^(?:https?|ssh|git):\/\/(?:([^@/\s]+)@)?([^/:\s]+)(?::\d+)?(?:\/(.*))?$/i.exec(text)
  // Keep the port for https hosts (self-managed instances), not for ssh ones.
  const port = /^https?:\/\/(?:[^@/\s]+@)?[^/:\s]+(:\d+)/i.exec(text)?.[1] ?? ''
  if (!m) {
    m = /^(?:([^@/\s:]+)@)?([\w.-]+):(?!\/\/)(.*)$/.exec(text)
    if (!m || /^[a-z]$/i.test(m[2])) return null // "C:\path" is a Windows path
  }
  const path = (m[3] ?? '')
    .replace(/[?#].*$/, '')
    .split('/')
    .filter(Boolean)
  return { host: m[2].toLowerCase() + port, path, user: m[1] ?? null }
}

const stripGit = (s: string): string => s.replace(/\.git$/i, '')

/**
 * Where a remote URL points. `known` maps self-managed hosts (GitHub Enterprise,
 * GitLab) to their provider. Browser URLs of a sub-page also work
 * ("https://github.com/o/r/pull/1", "https://gitlab.com/g/r/-/issues").
 */
export function parseRemote(
  url: string,
  known: Record<string, HostingProvider> = {}
): RemoteRef | null {
  const parts = splitUrl(url)
  if (!parts) return null
  const { host, path } = parts
  const provider = cloudProvider(host) ?? known[host] ?? known[host.replace(/:\d+$/, '')] ?? null

  if (provider === 'azure') {
    let org: string | undefined
    let rest: string[]
    if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
      // git@ssh.dev.azure.com:v3/org/project/repo, org@vs-ssh.visualstudio.com:v3/org/project/repo
      if (path[0] !== 'v3' || path.length < 4) return null
      return azureRef(path[1], path[2], path[3])
    } else if (host === 'dev.azure.com') {
      org = path[0]
      rest = path.slice(1)
    } else {
      org = host.replace(/\.visualstudio\.com$/, '')
      rest = path[0]?.toLowerCase() === 'defaultcollection' ? path.slice(1) : path
    }
    const git = rest.findIndex((s) => s === '_git')
    if (!org || git < 0 || !rest[git + 1]) return null
    // https://dev.azure.com/org/_git/repo: the project has the repository's name.
    const project = git > 0 ? rest[git - 1] : rest[git + 1]
    return azureRef(org, project, rest[git + 1])
  }

  const cut = path.indexOf('-')
  const segments = (cut >= 0 ? path.slice(0, cut) : path).map(decode)
  if (segments.length < 2 || !segments.every((s) => SEGMENT.test(s) && !dotsOnly(s))) return null
  // GitLab groups nest (group/subgroup/project; browser sub-pages start with "/-/"), and an
  // unknown host could be a self-managed GitLab without an account: keep the full path there.
  // GitHub, Bitbucket and other unknown URLs: owner/repo (the rest is a sub-page).
  const nested = provider === 'gitlab' || (!provider && segments.length > 2)
  const names = nested ? segments.map(stripGit) : [segments[0], stripGit(segments[1])]
  // Checked again once ".git" is gone: "..git" or ".git" alone names nothing.
  if (!names.every(isName)) return null
  const slug = names.join('/')
  return { provider, host: provider === 'github' ? host.replace(/^www\./, '') : host, slug }
}

function azureRef(org: string, project: string, repo: string): RemoteRef | null {
  const [o, p, r] = [org, project, stripGit(repo)].map(decode)
  if (![o, p, r].every((s) => isName(s) && !/[/\\\0\r\n]/.test(s))) return null
  return {
    provider: 'azure',
    host: 'dev.azure.com',
    slug: `${o}/${p}/${r}`,
    azure: { org: o, project: p, repo: r }
  }
}

/** Browser URL of the repository. */
export function webUrl(ref: RemoteRef): string | null {
  if (!ref.provider) return null
  if (ref.azure) {
    const { org, project, repo } = ref.azure
    return `https://dev.azure.com/${[org, project, '_git', repo].map(encodeURIComponent).join('/')}`
  }
  return `https://${ref.host}/${ref.slug}`
}

/** https URL git can clone with the account's token. */
export function httpsCloneUrl(ref: RemoteRef): string {
  if (ref.azure) return webUrl(ref)!
  return `https://${ref.host}/${ref.slug}.git`
}

export function remoteInfo(ref: RemoteRef): RemoteInfo {
  return { provider: ref.provider, host: ref.host, slug: ref.slug, webUrl: webUrl(ref) }
}

/**
 * Turns what the user pasted into something safe to give `git clone`: an https or
 * ssh URL (never a local path or an `ext::` transport). "owner/repo" means GitHub.
 */
export function normalizeCloneInput(
  input: string,
  known: Record<string, HostingProvider> = {}
): { url: string; ref: RemoteRef | null } {
  const text = input.trim()
  if (!text || /\s/.test(text) || text.startsWith('-')) throw new Error('Paste a repository link.')
  const shorthand = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(text)
  if (shorthand && isName(shorthand[1]) && isName(shorthand[2])) {
    const ref: RemoteRef = {
      provider: 'github',
      host: 'github.com',
      slug: `${shorthand[1]}/${shorthand[2]}`
    }
    return { url: httpsCloneUrl(ref), ref }
  }
  const isHttps = /^https:\/\/[\w.-]+(:\d+)?\/\S+$/i.test(text)
  const isSsh = /^(ssh:\/\/|[\w.-]+@[\w.-]+:)\S+$/i.test(text)
  const isBrowser = /^https?:\/\//i.test(text)
  if (!isHttps && !isSsh && !isBrowser)
    throw new Error('Unsupported link. Use an https:// or SSH repository URL.')
  const ref = parseRemote(text, known)
  // github.com links always become https (as before); other known providers too, so the
  // signed-in account can authenticate. Unknown hosts keep what was pasted.
  if (ref?.provider) return { url: httpsCloneUrl(ref), ref }
  if (!isHttps && !isSsh)
    throw new Error('Unsupported link. Use an https:// or SSH repository URL.')
  return { url: text, ref }
}

/** Folder names (below the clone folder) for a repository: its slug's segments. */
export function cloneFolders(ref: RemoteRef | null, url: string): string[] {
  // Characters Windows refuses in file names (and control characters) become "_".
  const clean = (s: string): string =>
    [...s]
      .map((c) => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? '_' : c))
      .join('')
      .replace(/^\.+$/, '_')
      .replace(/[. ]+$/, '') || '_'
  if (ref) return ref.slug.split('/').map(clean)
  const name = url
    .split(/[/:]/)
    .filter(Boolean)
    .pop()!
    .replace(/\.git$/i, '')
  return ['other', clean(name)]
}

/** Same repository? Hosts and slugs compare case-insensitively. */
export function sameRepo(a: RemoteRef | RemoteInfo, b: RemoteRef | RemoteInfo): boolean {
  return a.host === b.host && a.slug.toLowerCase() === b.slug.toLowerCase()
}
