import { net } from 'electron'
import { mapGitHubPull, mapGitHubRepo, mapGitHubUser } from './hosting/providers/github'
import {
  int,
  link,
  list,
  obj,
  refName,
  slugPath,
  str,
  userName,
  type Json
} from './hosting/validate'
import { netFetchManual } from './netFetch'
import {
  API_TIMEOUT_MS,
  fetchWithin,
  readJson,
  RedirectError,
  TooLargeError,
  urlWithin
} from './safeFetch'
import type { GitHubRepo, PullRequest } from '../shared/types'

const API = 'https://api.github.com'
/** repo: private repositories (read/write for clone, fetch, push); read:org: organization repositories. */
const SCOPES = 'repo read:org read:user'
const MAX_JSON_BYTES = 20 * 1024 * 1024

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

/** The parsed answer: check its shape before use (see hosting/validate.ts). */
async function api(path: string, token: string | null): Promise<unknown> {
  return body(await request(API + path, token))
}

async function body(res: Response): Promise<unknown> {
  try {
    return await readJson(res, MAX_JSON_BYTES)
  } catch (e) {
    if (e instanceof TooLargeError)
      throw new GitHubError('GitHub sent an answer that is too large.', 0)
    if (e instanceof SyntaxError) throw new GitHubError('GitHub sent invalid JSON.', 0)
    throw new GitHubError('GitHub did not answer in time.', 0)
  }
}

/** Inside the API (parsed: encoded dot segments cannot leave it); the URL to request, or null. */
const inApi = (url: string): string | null => urlWithin(url, [API])

async function request(url: string, token: string | null): Promise<Response> {
  // The token only ever goes to the GitHub API host.
  const target = inApi(url)
  if (!target) throw new GitHubError(`Unexpected GitHub URL: ${url.slice(0, 300)}`, 0)
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GitDesk'
  }
  if (token) headers.Authorization = `Bearer ${token}`
  // Redirects (renamed repositories) are followed only inside the API: fetch would send
  // the Authorization header along to another origin.
  // One deadline for every hop and the body, so a stalled request cannot hang a caller.
  const signal = AbortSignal.timeout(API_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchWithin(netFetchManual, target, { headers, signal }, (u) => !!inApi(u))
  } catch (e) {
    if (e instanceof RedirectError) throw new GitHubError(`GitHub: ${e.message}`, 0)
    if (signal.aborted) throw new GitHubError('GitHub did not answer in time.', 0)
    throw e
  }
  if (res.status === 401 && token) {
    await res.body?.cancel().catch(() => undefined)
    throw new GitHubError(
      'GitHub refused the saved sign-in (expired or revoked). Sign in again.',
      401
    )
  }
  if (!res.ok) {
    let message = res.statusText
    try {
      message = str(obj(await readJson(res, 64 * 1024)).message, 500) ?? message
    } catch {
      /* not JSON, or too long */
    }
    throw new GitHubError(`GitHub: ${message} (${res.status})`, res.status)
  }
  return res
}

/** URL of the next page from a `Link` header, if any. */
function nextPage(link: string | null): string | null {
  const m = /<([^>]+)>;\s*rel="next"/.exec(link ?? '')
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Device flow: https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
// No client secret is involved, so nothing secret ships with the app.
// ---------------------------------------------------------------------------

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

async function postForm(url: string, form: Record<string, string>): Promise<Json> {
  const signal = AbortSignal.timeout(API_TIMEOUT_MS)
  let res: Response
  try {
    res = await net.fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal
    })
  } catch (e) {
    if (signal.aborted) throw new GitHubError('GitHub did not answer in time.', 0)
    throw e
  }
  if (res.status === 404) {
    throw new GitHubError('GitHub does not know this Client ID. Check it in Settings.', 404)
  }
  if (!res.ok) throw new GitHubError(`GitHub sign-in failed (${res.status})`, res.status)
  return obj(await body(res))
}

export async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
  const r = await postForm('https://github.com/login/device/code', {
    client_id: clientId,
    scope: SCOPES
  })
  if (r.error === 'device_flow_disabled') {
    throw new GitHubError(
      'Device flow is off for this OAuth App: tick "Enable Device Flow" in its settings on GitHub.',
      400
    )
  }
  if (r.error)
    throw new GitHubError(
      str(r.error_description, 500) ?? str(r.error, 100) ?? 'Sign-in failed',
      400
    )
  const userCode = str(r.user_code, 100)
  const uri = link(r.verification_uri)
  const deviceCode = str(r.device_code, 1000)
  if (!userCode || !uri || !deviceCode)
    throw new GitHubError('GitHub sent an unexpected answer.', 0)
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: uri,
    expires_in: Math.min(int(r.expires_in) ?? 900, 3600),
    interval: Math.min(int(r.interval) ?? 5, 60)
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new GitHubError('Sign-in cancelled', 0))
    })
  })

/**
 * Polls until the user approves the code on github.com, then returns the access token.
 * `expiresIn` is set when the OAuth App has "Expire user access tokens" ticked: such
 * tokens last 8 hours and refreshing them needs the client secret, which GitDesk does not have.
 */
export async function pollDeviceToken(
  clientId: string,
  code: DeviceCodeResponse,
  signal: AbortSignal
): Promise<{ token: string; expiresIn: number | null }> {
  let interval = Math.max(code.interval, 5)
  const deadline = Date.now() + code.expires_in * 1000
  while (Date.now() < deadline) {
    await sleep(interval * 1000, signal)
    const r = await postForm('https://github.com/login/oauth/access_token', {
      client_id: clientId,
      device_code: code.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
    const token = str(r.access_token, 10_000)
    if (token && !/\s/.test(token)) return { token, expiresIn: int(r.expires_in) || null }
    if (r.error === 'authorization_pending') continue
    if (r.error === 'slow_down') {
      interval = Math.min(int(r.interval) ?? interval + 5, 60)
      continue
    }
    if (r.error === 'access_denied') throw new GitHubError('Sign-in was refused on GitHub.', 403)
    if (r.error === 'expired_token') break
    throw new GitHubError(
      str(r.error_description, 500) ?? str(r.error, 100) ?? 'Sign-in failed',
      400
    )
  }
  throw new GitHubError('The code expired. Start the sign-in again.', 400)
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

export interface GitHubUser {
  login: string
  name: string | null
  /** null when GitHub did not send a usable picture URL. */
  avatar_url: string | null
}

/** The signed-in user; throws when GitHub does not name a usable login. */
export async function getUser(token: string): Promise<GitHubUser> {
  const u = mapGitHubUser(await api('/user', token))
  return { login: u.login, name: u.name, avatar_url: u.avatarUrl }
}

export async function listRepos(token: string, account: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = []
  for (let page = 1; page <= 10; page++) {
    const batch = list(
      await api(
        `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
        token
      )
    )
    for (const raw of batch) {
      const r = mapGitHubRepo(raw, 'github.com', account)
      if (r)
        repos.push({
          fullName: r.fullName,
          description: r.description,
          private: r.private,
          fork: r.fork,
          pushedAt: r.pushedAt,
          cloneUrl: r.cloneUrl,
          account
        })
    }
    if (batch.length < 100) break
  }
  return repos
}

/** "owner/repo" as two encoded API path segments (dot segments refused). */
const repoPath = (slug: string): string => `/repos/${slugPath(slug, 2)}`

export async function canAccess(token: string, slug: string): Promise<boolean> {
  try {
    await api(repoPath(slug), token)
    return true
  } catch {
    return false
  }
}

export interface GitHubIdentity {
  login: string
  avatarUrl: string
}

/** The GitHub user of a commit of the commits API (null when missing or odd). */
function commitUser(raw: unknown): GitHubIdentity | null {
  const author = obj(obj(raw).author)
  const login = userName(author.login)
  const avatarUrl = link(author.avatar_url)
  return login && avatarUrl ? { login, avatarUrl } : null
}

/** email -> GitHub user for the authors of the latest commits. */
export async function recentAuthors(
  slug: string,
  token: string | null
): Promise<Map<string, GitHubIdentity>> {
  const commits = list(await api(`${repoPath(slug)}/commits?per_page=100`, token))
  const map = new Map<string, GitHubIdentity>()
  for (const c of commits) {
    const email = str(obj(obj(obj(c).commit).author).email, 320)?.toLowerCase()
    const who = commitUser(c)
    if (email && who && !map.has(email)) map.set(email, who)
  }
  return map
}

/** GitHub user linked to one commit's author, if any. */
export async function commitAuthor(
  slug: string,
  sha: string,
  token: string | null
): Promise<GitHubIdentity | null> {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return null
  const commits = list(await api(`${repoPath(slug)}/commits?sha=${sha}&per_page=1`, token), 1)
  return commitUser(commits[0])
}

export interface ActivityEvent {
  id: number
  before: string
  after: string
  ref: string
  timestamp: string
  activity_type: string
  actor: { login: string; avatar_url: string } | null
}

/**
 * Pushes, force pushes, branch creations/deletions and pull request merges, with
 * who did them and when ("Repository activity" API, newest first, up to 3 months).
 */
export async function repoActivity(
  slug: string,
  token: string,
  sinceMs: number
): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = []
  let url: string | null = `${API}${repoPath(slug)}/activity?per_page=100&time_period=quarter`
  for (let page = 0; url && page < 10; page++) {
    const res = await request(url, token)
    const batch = list(await body(res)).flatMap((e) => activityEvent(e) ?? [])
    events.push(...batch)
    const oldest = batch[batch.length - 1]
    if (!oldest || Date.parse(oldest.timestamp) < sinceMs) break
    url = nextPage(res.headers.get('link'))
  }
  return events
}

const sha = (v: unknown): string | null =>
  typeof v === 'string' && /^[0-9a-f]{4,64}$/i.test(v) ? v : null

/** One event of the activity API, or null when a field is missing or odd. */
export function activityEvent(raw: unknown): ActivityEvent | null {
  const e = obj(raw)
  const id = int(e.id)
  const before = sha(e.before)
  const after = sha(e.after)
  const ref = refName(e.ref)
  const timestamp = str(e.timestamp, 64)
  const type = str(e.activity_type, 64)
  if (id === null || !before || !after || !ref || !timestamp || !type) return null
  const actor = obj(e.actor)
  const login = userName(actor.login)
  const avatar = link(actor.avatar_url)
  return {
    id,
    before,
    after,
    ref,
    timestamp,
    activity_type: type,
    actor: login && avatar ? { login, avatar_url: avatar } : null
  }
}

/** Open pull requests, most recently updated first, with their author's picture URL. */
export async function listPullRequests(
  slug: string,
  token: string | null
): Promise<{ pull: PullRequest; avatarUrl: string | null }[]> {
  const pulls = await api(
    `${repoPath(slug)}/pulls?state=open&per_page=50&sort=updated&direction=desc`,
    token
  )
  return list(pulls).flatMap((p) => mapGitHubPull(p) ?? [])
}
