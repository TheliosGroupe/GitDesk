// Requests that carry credentials, and picture downloads from URLs found in provider data.
// No Electron import: the fetch function is passed in, so this runs in plain Node for tests.
//
// fetch (Electron's net.fetch included) keeps Authorization and custom headers such as
// x-api-key when it follows a redirect to another origin, so credentialed requests never
// let it follow redirects: each hop is checked here before it is requested.

import { lookup } from 'dns/promises'
import { Agent, request as httpsRequest } from 'https'
import { BlockList, isIP, type LookupFunction } from 'net'
import { Readable } from 'stream'
import { createSecureContext, getCACertificates, type SecureContext } from 'tls'

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export class RedirectError extends Error {
  constructor(
    message: string,
    /** Where the server wanted to send the request. */
    readonly location: string
  ) {
    super(message)
    this.name = 'RedirectError'
  }
}

const MAX_REDIRECTS = 5
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/**
 * fetch(url) with `redirect: 'manual'`, following a redirect only to a URL `allowed` accepts
 * (at most five). A redirect elsewhere throws a RedirectError: nothing is sent there.
 */
export async function fetchWithin(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  allowed: (url: string) => boolean | Promise<boolean>
): Promise<Response> {
  let current = url
  let req: RequestInit = { ...init, redirect: 'manual' }
  for (let hops = 0; ; hops++) {
    const res = await fetchFn(current, req)
    if (res.type === 'opaqueredirect')
      throw new RedirectError(`${originOf(current)} redirected the request elsewhere.`, '')
    const location = REDIRECT_STATUS.has(res.status) ? res.headers.get('location') : null
    if (!location) return res
    await res.body?.cancel().catch(() => undefined)
    let next: string
    try {
      next = new URL(location, current).toString()
    } catch {
      throw new RedirectError(`${originOf(current)} answered with an invalid redirect.`, location)
    }
    if (hops >= MAX_REDIRECTS)
      throw new RedirectError(`Too many redirects from ${originOf(url)}.`, next)
    if (!(await allowed(next)))
      throw new RedirectError(
        `${originOf(current)} redirected to ${originOf(next)}; the request was not sent there.`,
        next
      )
    // As fetch does: 303 (and 301/302 after a POST) become a GET without a body.
    const method = (req.method ?? 'GET').toUpperCase()
    if (
      (res.status === 303 && method !== 'HEAD') ||
      ((res.status === 301 || res.status === 302) && method === 'POST')
    ) {
      const headers = new Headers(req.headers)
      headers.delete('content-type')
      req = { ...req, method: 'GET', body: undefined, headers }
    }
    current = next
  }
}

/** Same scheme, host and port as `base`. */
export function sameOrigin(base: string): (url: string) => boolean {
  const origin = originOf(base)
  return (url) => originOf(url) === origin
}

/**
 * Is `url` under one of `bases` (same origin, path equal or below on a segment boundary)?
 * Compares the parsed URLs, so dot segments (also percent-encoded) cannot leave a base.
 * Returns the normalized URL to request, or null.
 */
export function urlWithin(url: string, bases: string[]): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.username || u.password) return null
  for (const b of bases) {
    let base: URL
    try {
      base = new URL(b)
    } catch {
      continue
    }
    const path = base.pathname.replace(/\/+$/, '')
    if (
      u.origin === base.origin &&
      (u.pathname === base.pathname || u.pathname.startsWith(path + '/'))
    )
      return u.href
  }
  return null
}

// Every range that is not a public unicast address. BlockList also applies the IPv4 rules
// to IPv4-mapped IPv6 addresses (::ffff:a.b.c.d, in dotted or hex form).
const NOT_PUBLIC = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3] // multicast, reserved, broadcast
] as const)
  NOT_PUBLIC.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['::ffff:0:0:0', 96], // IPv4-translated (SIIT): BlockList does not map it to IPv4
  ['64:ff9b::', 96], // NAT64 (embeds an IPv4 address)
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo (embeds an IPv4 address)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8] // multicast
] as const)
  NOT_PUBLIC.addSubnet(net, prefix, 'ipv6')

/** Loopback, private, link-local, CGNAT, multicast, unspecified… anything but a public address. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (!v) return true
  return NOT_PUBLIC.check(ip, v === 6 ? 'ipv6' : 'ipv4')
}

/** Host of a URL, lowercase, without IPv6 brackets. */
const hostOf = (u: URL): string => u.hostname.replace(/^\[|\]$/g, '').toLowerCase()

/**
 * An https URL on a public host (checked on the name and on the addresses it resolves to),
 * for requests made to URLs found in provider data such as profile pictures. Such requests
 * go through pinnedFetch, which checks again the address it actually connects to.
 */
export async function isPublicHttpsUrl(
  url: string,
  resolve: (host: string) => Promise<string[]> = defaultResolve
): Promise<boolean> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const host = hostOf(u)
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false
  if (isIP(host)) return !isPrivateAddress(host)
  // A single label ("intranet") is a local name.
  if (!host.includes('.') || /\.(local|internal|lan|home\.arpa)$/.test(host)) return false
  try {
    const addresses = await resolve(host)
    return addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a))
  } catch {
    return false
  }
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((a) => a.address)
}

/**
 * A socket `lookup` that only hands out public addresses: the name is resolved once, here,
 * and the socket connects to what was checked. A DNS answer that changes between the check
 * and the connection (DNS rebinding) therefore cannot point it at the local network.
 */
export function publicLookup(
  resolve: (host: string) => Promise<string[]> = defaultResolve
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((addresses) => {
        const family = options.family === 4 || options.family === 6 ? options.family : 0
        const usable = addresses.filter((a) => !family || isIP(a) === family)
        if (!usable.length || addresses.some(isPrivateAddress))
          throw new Error(`${hostname} is not a public host.`)
        const list = usable.map((address) => ({ address, family: isIP(address) }))
        if (options.all) callback(null, list)
        else callback(null, list[0].address, list[0].family)
      })
      .catch((e: NodeJS.ErrnoException) => callback(e, '', 0))
  }
}

/**
 * One TLS context trusting the system's certificates as well as Node's (as Chromium does),
 * built on first use: building it parses a few hundred certificates, too slow per socket.
 */
let context: SecureContext | undefined | null = null
function trustedContext(): SecureContext | undefined {
  if (context === null) {
    try {
      const ca = [...new Set([...getCACertificates('bundled'), ...getCACertificates('system')])]
      context = createSecureContext({ ca })
    } catch {
      context = undefined // Node's own roots
    }
  }
  return context
}

const NO_BODY = new Set([101, 204, 205, 304])

/**
 * fetch for URLs found in provider data (pictures): https only, never follows a redirect
 * (fetchWithin checks each hop) and connects only to public addresses (publicLookup).
 * The certificate is checked against the URL's host name as usual.
 */
export function pinnedFetch(
  resolve: (host: string) => Promise<string[]> = defaultResolve
): FetchFn {
  // Its own pool, made on first use: every socket in it was opened through publicLookup (an
  // agent's options win over a request's, so the lookup cannot be swapped) with the shared
  // TLS context. Idle sockets close after 30 s.
  let agent: Agent | null = null
  const pool = (): Agent =>
    (agent ??= new Agent({
      keepAlive: true,
      timeout: 30_000,
      maxSockets: 6,
      lookup: publicLookup(resolve),
      secureContext: trustedContext()
    }))
  return (url, init) =>
    new Promise<Response>((done, fail) => {
      let u: URL
      try {
        u = new URL(url)
      } catch {
        return fail(new TypeError('Invalid URL.'))
      }
      const host = hostOf(u)
      if (u.protocol !== 'https:' || (isIP(host) && isPrivateAddress(host)))
        return fail(new Error(`${u.origin} is not a public https address.`))
      const body = init.body
      if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array))
        return fail(new TypeError('Unsupported request body.'))
      const method = (init.method ?? 'GET').toUpperCase()
      const req = httpsRequest(
        u,
        {
          method,
          headers: Object.fromEntries(new Headers(init.headers)),
          signal: init.signal ?? undefined,
          agent: pool()
        },
        (res) => {
          const status = res.statusCode ?? 0
          const headers = new Headers()
          for (const [k, v] of Object.entries(res.headers))
            for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v])
              headers.append(k, value)
          const stream =
            method === 'HEAD' || NO_BODY.has(status)
              ? null
              : (Readable.toWeb(res) as ReadableStream<Uint8Array>)
          if (!stream) res.resume()
          try {
            done(new Response(stream, { status, statusText: res.statusMessage, headers }))
          } catch (e) {
            res.destroy()
            fail(e)
          }
        }
      )
      req.on('error', fail)
      req.end(body ?? undefined)
    })
}

// ---------------------------------------------------------------------------
// Bounded answers
// ---------------------------------------------------------------------------

/** Deadlines; one covers every redirect hop and the whole body. */
export const API_TIMEOUT_MS = 30_000
export const PICTURE_TIMEOUT_MS = 15_000

export class TooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The answer is larger than ${Math.round(limit / 1024)} KB.`)
    this.name = 'TooLargeError'
  }
}

/**
 * The body, read as it streams and dropped as soon as it passes `max` bytes (a declared
 * Content-Length above `max` is refused before anything is read).
 */
export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined)
    throw new TooLargeError(max)
  }
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new TooLargeError(max)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** A JSON body of at most `max` bytes (TooLargeError, or SyntaxError when it is not JSON). */
export async function readJson(res: Response, max: number): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readCapped(res, max)))
}
