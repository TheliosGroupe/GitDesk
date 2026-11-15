// HTTP for the provider clients: one place that decides where a token may go.

import { app } from 'electron'
import { netFetchManual, publicFetch } from '../netFetch'
import {
  API_TIMEOUT_MS,
  fetchWithin,
  isPublicHttpsUrl,
  PICTURE_TIMEOUT_MS,
  readCapped,
  readJson,
  RedirectError,
  TooLargeError,
  urlWithin,
  type FetchFn
} from '../safeFetch'

export type Fetch = FetchFn

/** Never follows redirects itself: every hop goes through fetchWithin. */
let fetchImpl: Fetch = netFetchManual
/** For picture URLs found in provider data: connects to public addresses only. */
let pictureFetchImpl: Fetch = publicFetch

/** Tests (plain Node, no Electron) use the global fetch (it honors `redirect: 'manual'`). */
export function setFetch(f: Fetch, pictures: Fetch = f): void {
  fetchImpl = f
  pictureFetchImpl = pictures
}

/** Largest JSON answer read from an API (a page of 100 repositories is well under 1 MB). */
const MAX_JSON_BYTES = 20 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
const MAX_PICTURE_BYTES = 256 * 1024

/**
 * API base URLs normally follow from the host. GITDESK_API_OVERRIDES (JSON
 * {"<host>": "<base URL>"}) points a host at a local fake server for tests. A packaged
 * build ignores it outside test mode (GITDESK_USER_DATA), so an environment variable
 * cannot redirect a user's tokens.
 */
let overrides: Record<string, string> | null = null
export function apiOverride(key: string): string | null {
  if (overrides === null) {
    if (app?.isPackaged && !process.env.GITDESK_USER_DATA) overrides = {}
    else
      try {
        const raw = JSON.parse(process.env.GITDESK_API_OVERRIDES ?? '{}')
        overrides = raw && typeof raw === 'object' ? raw : {}
      } catch {
        overrides = {}
      }
  }
  const v = overrides![key]
  return typeof v === 'string' ? v.replace(/\/+$/, '') : null
}

/** Only for tests. */
export function setApiOverrides(map: Record<string, string>): void {
  overrides = map
}

export class HostingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Set when the API redirected outside itself: where it pointed (not requested). */
    readonly redirect: string | null = null
  ) {
    super(message)
    this.name = 'HostingError'
  }
}

export interface ApiOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  /** Deadline for the whole request, body included (default 30 s). */
  timeoutMs?: number
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * A client bound to one API: requests outside `bases` are refused, so the token
 * cannot be sent anywhere else (a "next page" link pointing elsewhere, for example).
 */
export class Api {
  constructor(
    readonly label: string,
    readonly bases: string[],
    private readonly auth: Record<string, string>,
    private readonly extraHeaders: Record<string, string> = {}
  ) {}

  /** Compares parsed URLs: dot segments (also percent-encoded) cannot leave the API. */
  allowed(url: string): boolean {
    return urlWithin(url, this.bases) !== null
  }

  async request(url: string, opts: ApiOptions = {}): Promise<Response> {
    const target = urlWithin(url, this.bases)
    if (!target) throw new HostingError(`Unexpected ${this.label} URL: ${url.slice(0, 300)}`, 0)
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'GitDesk',
      ...this.extraHeaders,
      ...this.auth,
      ...opts.headers
    }
    let body: string | undefined
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }
    // One deadline for every hop and the body, so a stalled server cannot hang a caller.
    const signal = AbortSignal.timeout(opts.timeoutMs ?? API_TIMEOUT_MS)
    let res: Response
    try {
      // fetch would keep the Authorization header on a redirect to another origin, so
      // redirects are followed only inside this API.
      res = await fetchWithin(
        fetchImpl,
        target,
        { method: opts.method ?? 'GET', headers, body, signal },
        (u) => this.allowed(u)
      )
    } catch (e) {
      if (e instanceof RedirectError)
        throw new HostingError(`${this.label}: ${e.message}`, 0, e.location || null)
      if (signal.aborted) throw new HostingError(`${this.label} did not answer in time.`, 0)
      throw new HostingError(`Could not reach ${this.label}: ${message(e)}`, 0)
    }
    if (res.status === 401 || res.status === 203) {
      // Azure DevOps answers 203 with a sign-in page for a bad token.
      await res.body?.cancel().catch(() => undefined)
      throw new HostingError(
        `${this.label} refused the token (expired, revoked or missing a scope). Sign in again.`,
        401
      )
    }
    if (!res.ok) {
      let text = res.statusText
      try {
        const data = await readJson(res, MAX_ERROR_BYTES)
        if (data && typeof data === 'object')
          text = errorText(data as Record<string, unknown>) ?? text
      } catch {
        /* not JSON, or too long */
      }
      throw new HostingError(`${this.label}: ${text.slice(0, 500)} (${res.status})`, res.status)
    }
    return res
  }

  /** The parsed JSON answer: check its shape before use (see validate.ts). */
  async json<T = unknown>(url: string, opts?: ApiOptions): Promise<T> {
    const res = await this.request(url, opts)
    const type = res.headers.get('content-type') ?? ''
    if (!/json/i.test(type)) {
      await res.body?.cancel().catch(() => undefined)
      throw new HostingError(`${this.label} did not answer with JSON (check the host).`, res.status)
    }
    try {
      return (await readJson(res, MAX_JSON_BYTES)) as T
    } catch (e) {
      if (e instanceof TooLargeError)
        throw new HostingError(`${this.label} sent an answer that is too large.`, res.status)
      if (e instanceof SyntaxError)
        throw new HostingError(`${this.label} sent invalid JSON.`, res.status)
      const late = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
      throw new HostingError(
        late
          ? `${this.label} did not answer in time.`
          : `${this.label}: the answer was cut off (${message(e)}).`,
        0
      )
    }
  }
}

/** The message in an error body of GitHub, GitLab, Bitbucket, Azure DevOps, Jira, Linear. */
export function errorText(data: Record<string, unknown>): string | null {
  const pick = (v: unknown): string | null => {
    if (typeof v === 'string') return v
    if (Array.isArray(v) && v.length)
      return v
        .map((x) => pick(x) ?? '')
        .filter(Boolean)
        .join('; ')
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return pick(o.message) ?? pick(o.error) ?? null
    }
    return null
  }
  const errors = Array.isArray(data.errors)
    ? data.errors
        .map((e) => pick(e) ?? '')
        .filter(Boolean)
        .join('; ')
    : null
  return (
    pick(data.message) ??
    pick(data.error_description) ??
    pick(data.error) ??
    (errors || null) ??
    pick(data.errorMessages) ??
    null
  )
}

/** Basic auth header value (btoa handles Latin-1 only, so encode UTF-8 first). */
export function basic(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `Basic ${btoa(bin)}`
}

/** An ISO date (or anything else) -> unix seconds; 0 when it is not a date. */
export const unix = (iso: unknown): number => {
  const t = typeof iso === 'string' && iso.length <= 64 ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? Math.max(0, Math.floor(t / 1000)) : 0
}

/** Runs `fn` on the items, `size` at a time. */
export async function pool<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

/**
 * A profile picture as a data: URL (raster images only: an SVG could carry markup).
 * The token goes along only when the picture is served by the account's own API (and
 * not to where that API redirects: the picture is then fetched again without it).
 * Without the token, only https URLs on public hosts are fetched: the URLs come from
 * provider data, which should not make the app probe the local network. At most 256 KB,
 * within 15 seconds.
 */
export async function downloadPicture(url: string, api?: Api): Promise<string | null> {
  if (typeof url !== 'string' || url.length > 4096 || !/^https?:\/\//i.test(url)) return null
  try {
    let res: Response
    if (api && api.allowed(url)) {
      try {
        res = await api.request(url, {
          headers: { Accept: 'image/*' },
          timeoutMs: PICTURE_TIMEOUT_MS
        })
      } catch (e) {
        if (e instanceof HostingError && e.redirect) return await downloadPicture(e.redirect)
        throw e
      }
    } else {
      if (!(await isPublicHttpsUrl(url))) return null
      res = await fetchWithin(
        pictureFetchImpl,
        url,
        { headers: { 'User-Agent': 'GitDesk' }, signal: AbortSignal.timeout(PICTURE_TIMEOUT_MS) },
        (u) => isPublicHttpsUrl(u)
      )
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) {
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    const bytes = await readCapped(res, MAX_PICTURE_BYTES)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return `data:${type};base64,${btoa(bin)}`
  } catch {
    return null
  }
}

/** Pictures by URL for this session (Launchpad, issues); a miss is tried again after 10 minutes. */
const pictureCache = new Map<string, Promise<string | null>>()
const RETRY_PICTURE_MS = 10 * 60_000

export function cachedPicture(url: string | null, api?: Api): Promise<string | null> {
  if (typeof url !== 'string' || !url) return Promise.resolve(null)
  let p = pictureCache.get(url)
  if (!p) {
    const started = downloadPicture(url, api).catch(() => null)
    p = started
    pictureCache.set(url, started)
    void started.then((data) => {
      if (data !== null) return
      const t = setTimeout(() => {
        if (pictureCache.get(url) === started) pictureCache.delete(url)
      }, RETRY_PICTURE_MS)
      t.unref?.()
    })
    if (pictureCache.size > 500) pictureCache.delete(pictureCache.keys().next().value!)
  }
  return p
}
