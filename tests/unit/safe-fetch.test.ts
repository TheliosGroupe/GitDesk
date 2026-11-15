// Credentials never follow a redirect to another origin; pictures only come from public hosts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createServer as createTcpServer, type AddressInfo } from 'net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { complete } from '../../src/main/ai/providers'
import { Api, downloadPicture, HostingError, setFetch } from '../../src/main/hosting/http'
import {
  fetchWithin,
  isPrivateAddress,
  isPublicHttpsUrl,
  pinnedFetch,
  publicLookup,
  readCapped,
  RedirectError,
  sameOrigin,
  TooLargeError
} from '../../src/main/safeFetch'

interface Hit {
  server: 'a' | 'b'
  method: string
  path: string
  auth: string | undefined
  apiKey: string | undefined
  body: string
}

let hits: Hit[] = []
let a: Server
let b: Server
let baseA = ''
let baseB = ''
/** Bytes the endless picture server managed to send, and whether the client hung up. */
let sent = 0
let endlessClosed = false

function listen(
  name: 'a' | 'b',
  handle: (req: IncomingMessage, res: ServerResponse) => void
): Promise<Server> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      hits.push({
        server: name,
        method: req.method!,
        path: req.url!,
        auth: req.headers.authorization,
        apiKey: req.headers['x-api-key'] as string | undefined,
        body
      })
      handle(req, res)
    })
  })
  return new Promise<Server>((r) => server.listen(0, '127.0.0.1', () => r(server)))
}

const port = (s: Server): number => (s.address() as AddressInfo).port

beforeAll(async () => {
  b = await listen('b', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"stolen":true}')
  })
  baseB = `http://127.0.0.1:${port(b)}`
  a = await listen('a', (req, res) => {
    const to = (location: string, status = 302): void => {
      res.writeHead(status, { location })
      res.end()
    }
    if (req.url === '/api/away') return to(`${baseB}/collect`)
    if (req.url === '/api/away-relative') return to(`//127.0.0.1:${port(b)}/collect`)
    if (req.url === '/api/moved') return to('/api/here', 301)
    if (req.url === '/api/loop') return to('/api/loop')
    if (req.url === '/api/see-other') return to('/api/here', 303)
    if (req.url === '/api/picture') return to(`${baseB}/picture.png`)
    if (req.url === '/v1/messages') return to(`${baseB}/v1/messages`, 307)
    // Headers, then nothing: the client has to give up by itself.
    if (req.url === '/api/stall') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"partial":')
      return
    }
    if (req.url === '/api/endless.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      const chunk = Buffer.alloc(64 * 1024, 1)
      const pump = (): void => {
        while (!res.destroyed && res.write(chunk)) sent += chunk.length
        if (!res.destroyed) res.once('drain', pump)
      }
      res.on('close', () => (endlessClosed = true))
      return pump()
    }
    if (req.url === '/api/declared-huge.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(50 << 20) })
      res.write(Buffer.alloc(1024))
      return
    }
    if (req.url === '/api/small.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(Buffer.from([137, 80, 78, 71]))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, method: req.method }))
  })
  baseA = `http://127.0.0.1:${port(a)}`
  setFetch(fetch)
})

afterAll(() => {
  a.closeAllConnections()
  a.close()
  b.close()
})

beforeEach(() => {
  hits = []
})

const api = (): Api => new Api('Fake', [`${baseA}/api`], { Authorization: 'Bearer secret' })

describe('Api redirects', () => {
  it('refuses a redirect to another origin and never sends the token there', async () => {
    const err = (await api()
      .json(`${baseA}/api/away`)
      .catch((e: unknown) => e)) as HostingError
    expect(err).toBeInstanceOf(HostingError)
    expect(err.message).toMatch(/redirected to http:\/\/127\.0\.0\.1:\d+; the request was not sent/)
    expect(err.redirect).toBe(`${baseB}/collect`)
    await expect(api().json(`${baseA}/api/away-relative`)).rejects.toThrow(/not sent there/)
    expect(hits.filter((h) => h.server === 'b')).toEqual([])
  })

  it('follows a redirect inside the API, with the token', async () => {
    expect(await api().json(`${baseA}/api/moved`)).toEqual({ path: '/api/here', method: 'GET' })
    expect(hits.map((h) => [h.path, h.auth])).toEqual([
      ['/api/moved', 'Bearer secret'],
      ['/api/here', 'Bearer secret']
    ])
  })

  it('turns a POST into a GET on 303, and stops redirect loops', async () => {
    expect(await api().json(`${baseA}/api/see-other`, { method: 'POST', body: { x: 1 } })).toEqual({
      path: '/api/here',
      method: 'GET'
    })
    expect(hits[1].body).toBe('')
    await expect(api().json(`${baseA}/api/loop`)).rejects.toThrow(/Too many redirects/)
  })

  it('does not follow a picture redirect to a local host, with or without the token', async () => {
    expect(await downloadPicture(`${baseA}/api/picture`, api())).toBeNull()
    expect(hits.filter((h) => h.server === 'b')).toEqual([])
  })
})

describe('AI redirects', () => {
  it('never sends the API key to another origin', async () => {
    await expect(
      complete(fetch, {
        provider: 'anthropic',
        model: 'm',
        baseUrl: baseA,
        apiKey: 'sk-secret',
        system: 's',
        user: 'u',
        maxTokens: 10,
        effort: 'low'
      })
    ).rejects.toThrow(/not sent there.*base URL/)
    expect(hits.map((h) => [h.server, h.apiKey])).toEqual([['a', 'sk-secret']])
  })
})

describe('fetchWithin', () => {
  it('reports where a refused redirect pointed', async () => {
    const err = (await fetchWithin(fetch, `${baseA}/api/away`, {}, sameOrigin(baseA)).catch(
      (e: unknown) => e
    )) as RedirectError
    expect(err).toBeInstanceOf(RedirectError)
    expect(err.location).toBe(`${baseB}/collect`)
  })
})

describe('public hosts', () => {
  it('recognizes non-public addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      '::ffff:0:7f00:1', // IPv4-translated 127.0.0.1
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      // IPv4-mapped in hex (how URL parsing writes it), IPv4-compatible, NAT64, 6to4,
      // Teredo, site-local, multicast, documentation and benchmark ranges
      '::ffff:7f00:1',
      '::ffff:a00:1',
      '0:0:0:0:0:ffff:7f00:1',
      '::7f00:1',
      '64:ff9b::7f00:1',
      '64:ff9b::808:808',
      '64:ff9b:1::1',
      '2002:7f00:1::',
      '2001:0:4136:e378::1',
      'fec0::1',
      'ff02::1',
      '2001:db8::1',
      '198.18.0.1',
      '192.0.2.1',
      '240.0.0.1',
      '255.255.255.255',
      'not-an-ip',
      ''
    ])
      expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of [
      '8.8.8.8',
      '140.82.112.3',
      '2606:4700::1111',
      '172.32.0.1',
      '::ffff:808:808',
      '2a00:1450:4007::1'
    ])
      expect(isPrivateAddress(ip), ip).toBe(false)
  })

  it('accepts https URLs on hosts that resolve to public addresses only', async () => {
    const dns = (map: Record<string, string[]>) => async (host: string) => map[host] ?? []
    const resolve = dns({
      'avatars.example.com': ['140.82.112.3'],
      'rebind.example.com': ['140.82.112.3', '127.0.0.1']
    })
    expect(await isPublicHttpsUrl('https://avatars.example.com/u/1', resolve)).toBe(true)
    expect(await isPublicHttpsUrl('http://avatars.example.com/u/1', resolve)).toBe(false)
    expect(await isPublicHttpsUrl('https://rebind.example.com/x', resolve)).toBe(false)
    expect(await isPublicHttpsUrl('https://unknown.example.com/x', resolve)).toBe(false)
    expect(await isPublicHttpsUrl('https://localhost/x', resolve)).toBe(false)
    expect(await isPublicHttpsUrl('https://127.0.0.1/x', resolve)).toBe(false)
    expect(await isPublicHttpsUrl('https://[::1]/x', resolve)).toBe(false)
    for (const host of [
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[::ffff:169.254.169.254]',
      '[::7f00:1]',
      '[64:ff9b::7f00:1]',
      '[fec0::1]',
      '[2002:a00:1::]'
    ])
      expect(await isPublicHttpsUrl(`https://${host}/x`, resolve), host).toBe(false)
    expect(await isPublicHttpsUrl('https://169.254.169.254/latest', resolve)).toBe(false)
    expect(await isPublicHttpsUrl('https://intranet/x', resolve)).toBe(false)
    expect(await isPublicHttpsUrl('https://8.8.8.8/x', resolve)).toBe(true)
  })

  it('does not fetch pictures from local hosts without an account', async () => {
    expect(await downloadPicture(`${baseB}/picture.png`)).toBeNull()
    expect(hits).toEqual([])
  })
})

describe('connecting only to public addresses', () => {
  /** A TCP listener on 127.0.0.1 that only counts connections (nothing must reach it). */
  async function counter(): Promise<{ port: number; count: () => number; close: () => void }> {
    let n = 0
    const server = createTcpServer((socket) => {
      n++
      socket.destroy()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return {
      port: (server.address() as AddressInfo).port,
      count: () => n,
      close: () => server.close()
    }
  }

  it('hands sockets only the public addresses it checked', async () => {
    const lookupWith = (addresses: string[]): Promise<{ err: Error | null; address: unknown }> =>
      new Promise<{ err: Error | null; address: unknown }>((resolve) =>
        publicLookup(async () => addresses)('h.example.test', { all: true }, (err, address) =>
          resolve({ err, address })
        )
      )
    expect((await lookupWith(['140.82.112.3'])).address).toEqual([
      { address: '140.82.112.3', family: 4 }
    ])
    for (const bad of [['127.0.0.1'], ['140.82.112.3', '10.0.0.1'], ['::ffff:7f00:1'], []])
      expect((await lookupWith(bad)).err, bad.join()).toBeInstanceOf(Error)
  })

  it('never connects to a local address, even when DNS changes its answer after the check', async () => {
    const target = await counter()
    try {
      // First answer public (the URL check passes), every later one local.
      let calls = 0
      const rebinding = async (): Promise<string[]> => (calls++ ? ['127.0.0.1'] : ['140.82.112.3'])
      const url = `https://rebind.example.test:${target.port}/a.png`
      expect(await isPublicHttpsUrl(url, rebinding)).toBe(true)
      await expect(pinnedFetch(rebinding)(url, {})).rejects.toThrow(/not a public host/)
      await expect(pinnedFetch()(`https://127.0.0.1:${target.port}/a.png`, {})).rejects.toThrow(
        /not a public/
      )
      await expect(
        pinnedFetch(async () => ['127.0.0.1'])(`http://x.example.test:${target.port}/`, {})
      ).rejects.toThrow()
      expect(target.count()).toBe(0)
    } finally {
      target.close()
    }
  })
})

describe('bounded answers', () => {
  const streamOf = (chunks: number, size: number): { res: Response; pulled: () => number } => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled++ >= chunks) c.close()
        else c.enqueue(new Uint8Array(size))
      }
    })
    return { res: new Response(body), pulled: () => pulled }
  }

  it('stops reading as soon as a body passes the limit', async () => {
    const { res, pulled } = streamOf(1_000_000, 64 * 1024)
    await expect(readCapped(res, 256 * 1024)).rejects.toBeInstanceOf(TooLargeError)
    expect(pulled()).toBeLessThan(10)
    const small = streamOf(3, 1000)
    expect((await readCapped(small.res, 256 * 1024)).length).toBe(3000)
    const declared = new Response('x', { headers: { 'content-length': String(10 << 20) } })
    await expect(readCapped(declared, 1024)).rejects.toBeInstanceOf(TooLargeError)
  })

  it('gives up on an endless or oversized picture quickly', async () => {
    sent = 0
    endlessClosed = false
    const started = Date.now()
    expect(await downloadPicture(`${baseA}/api/endless.png`, api())).toBeNull()
    expect(Date.now() - started).toBeLessThan(5000)
    await new Promise((r) => setTimeout(r, 100))
    expect(endlessClosed).toBe(true)
    expect(sent).toBeLessThan(32 << 20)
    expect(await downloadPicture(`${baseA}/api/declared-huge.png`, api())).toBeNull()
    expect(await downloadPicture(`${baseA}/api/small.png`, api())).toBe(
      'data:image/png;base64,iVBORw=='
    )
  })

  it('gives up on an API that stops answering', async () => {
    const started = Date.now()
    await expect(api().json(`${baseA}/api/stall`, { timeoutMs: 300 })).rejects.toThrow(
      /did not answer in time/
    )
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
