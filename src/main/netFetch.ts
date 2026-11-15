// fetch over Electron's network stack (system proxy and certificates) that never follows
// a redirect: a 3xx comes back as a response with its Location header, for safeFetch.ts
// to check. net.fetch cannot do this: with `redirect: 'manual'` it rejects ("Redirect was
// cancelled") without telling where the redirect pointed.

import { net, session } from 'electron'
import { pinnedFetch, type FetchFn } from './safeFetch'

const NO_BODY = new Set([101, 204, 205, 304])

export const netFetchManual: FetchFn = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const signal = init.signal ?? undefined
    const aborted = (): Error => new DOMException('The operation was aborted.', 'AbortError')
    if (signal?.aborted) return reject(aborted())
    const body = init.body
    if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array))
      return reject(new TypeError('Unsupported request body.'))
    const method = (init.method ?? 'GET').toUpperCase()
    const req = net.request({ url, method, redirect: 'manual' })
    new Headers(init.headers).forEach((value, key) => req.setHeader(key, value))
    let settled = false
    const done = (f: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      f()
    }
    const onAbort = (): void => {
      req.abort()
      done(() => reject(aborted()))
    }
    signal?.addEventListener('abort', onAbort)

    req.on('redirect', (status, _method, redirectUrl, responseHeaders) => {
      req.abort()
      const headers = toHeaders(responseHeaders)
      headers.set('location', redirectUrl)
      done(() => resolve(new Response(null, { status, headers })))
    })
    req.on('response', (res) => {
      const status = res.statusCode
      let stream: ReadableStream<Uint8Array> | null = null
      if (method !== 'HEAD' && !NO_BODY.has(status)) {
        stream = new ReadableStream<Uint8Array>({
          start(c) {
            let closed = false
            const close = (e?: Error): void => {
              if (closed) return
              closed = true
              if (e) c.error(e)
              else c.close()
            }
            res.on('data', (d: Buffer) => {
              if (!closed) c.enqueue(new Uint8Array(d))
            })
            res.on('end', () => close())
            res.on('error', (e: Error) => close(e))
            res.on('aborted', () => close(new Error('The connection was closed.')))
            signal?.addEventListener('abort', () => close(aborted()))
          },
          cancel() {
            req.abort()
          }
        })
      }
      done(() =>
        resolve(
          new Response(stream, {
            status,
            statusText: res.statusMessage,
            headers: toHeaders(res.headers)
          })
        )
      )
      // Keep a cancel on the signal working while the body streams.
      if (signal) signal.addEventListener('abort', () => req.abort(), { once: true })
    })
    req.on('error', (e) => done(() => reject(e)))

    if (body != null) req.write(typeof body === 'string' ? body : Buffer.from(body))
    req.end()
  })

function toHeaders(raw: Record<string, string | string[]>): Headers {
  const headers = new Headers()
  for (const [k, v] of Object.entries(raw))
    for (const value of Array.isArray(v) ? v : [v]) headers.append(k, value)
  return headers
}

const direct = pinnedFetch()

/**
 * fetch for URLs found in provider data (pictures). Without a proxy, it connects itself and
 * only to the public addresses it checked (see pinnedFetch). Through a system proxy, the
 * proxy resolves the name and decides what it reaches: the URL check is all GitDesk can do.
 */
export const publicFetch: FetchFn = async (url, init) => {
  const proxy = await session.defaultSession.resolveProxy(url).catch(() => 'DIRECT')
  return /^\s*DIRECT\s*$/i.test(proxy) ? direct(url, init) : netFetchManual(url, init)
}
