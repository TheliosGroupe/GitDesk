import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  complete,
  endpointFor,
  isLoopbackHost,
  MAX_ANSWER_CHARS,
  parseSse,
  sseParser,
  type CompletionRequest,
  type SseEvent
} from '../../src/main/ai/providers'

// A fake server mimicking the Anthropic Messages API and the OpenAI Chat Completions API.

let server: Server
let base: string
const seen: { url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }[] =
  []

function sse(res: ServerResponse, events: { event?: string; data: unknown }[], delay = 0): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  let i = 0
  const next = (): void => {
    if (i >= events.length) return void res.end()
    const e = events[i++]
    res.write(
      `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`
    )
    setTimeout(next, delay)
  }
  next()
}

function anthropicStream(res: ServerResponse, text: string[], stop = 'end_turn'): void {
  sse(res, [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1' } } },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' }
      }
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'hmm' }
      }
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'ping', data: { type: 'ping' } },
    ...text.map((t) => ({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } }
    })),
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } }
    },
    { event: 'message_stop', data: { type: 'message_stop' } }
  ])
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      seen.push({ url: req.url ?? '', headers: req.headers, body })
      const model = String(body.model)
      if (req.url === '/v1/messages') {
        if (req.headers['x-api-key'] !== 'good') {
          res.writeHead(401, { 'content-type': 'application/json' })
          return res.end(
            JSON.stringify({
              type: 'error',
              error: { type: 'authentication_error', message: 'invalid x-api-key' }
            })
          )
        }
        if (model === 'missing') {
          res.writeHead(404, { 'content-type': 'application/json' })
          return res.end(
            JSON.stringify({
              type: 'error',
              error: { type: 'not_found_error', message: 'model: missing' }
            })
          )
        }
        if (model === 'busy') {
          res.writeHead(429, { 'content-type': 'application/json' })
          return res.end(
            JSON.stringify({
              type: 'error',
              error: { type: 'rate_limit_error', message: 'slow down' }
            })
          )
        }
        if (model === 'refuse') return anthropicStream(res, [], 'refusal')
        if (model === 'midstream-error')
          return sse(res, [
            {
              event: 'error',
              data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
            }
          ])
        return anthropicStream(res, ['Hello', ' world'])
      }
      if (req.url === '/v1/chat/completions') {
        if (model === 'plain') {
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ choices: [{ message: { content: 'plain answer' } }] }))
        }
        if (model === 'slow')
          return sse(
            res,
            [{ data: { choices: [{ delta: { content: 'a' } }] } }, { data: '[DONE]' }],
            2000
          )
        if (model === 'nope') {
          res.writeHead(404, { 'content-type': 'application/json' })
          return res.end(
            JSON.stringify({ error: { message: 'model "nope" not found, try pulling it first' } })
          )
        }
        // Misbehaving servers: bounded on our side, and each stops once the client goes away.
        if (model === 'no-separator' || model === 'endless') {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          let closed = false
          let sent = 0
          res.on('close', () => (closed = true))
          const piece =
            model === 'endless'
              ? `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(4000) } }] })}\n\n`
              : 'data: ' + 'y'.repeat(16 * 1024)
          const pump = (): void => {
            if (closed || sent > 4 * 1024 * 1024) return void res.end()
            sent += piece.length
            if (res.write(piece)) setImmediate(pump)
            else res.once('drain', pump)
          }
          return pump()
        }
        if (model === 'huge-error') {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'e'.repeat(1024 * 1024) } }))
        }
        if (model === 'plain-huge') {
          res.writeHead(200, { 'content-type': 'application/json' })
          const content = 'z'.repeat(5 * 1024 * 1024)
          return res.end(JSON.stringify({ choices: [{ message: { content } }] }))
        }
        return sse(res, [
          { data: { choices: [{ delta: { role: 'assistant' } }] } },
          { data: { choices: [{ delta: { content: 'Hi' } }] } },
          { data: { choices: [{ delta: { content: ' there' }, finish_reason: 'stop' }] } },
          { data: '[DONE]' }
        ])
      }
      res.writeHead(404)
      res.end('not here')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise((r) => s.close(r))
  return port
}

afterAll(() => {
  server.close()
})

function req(over: Partial<CompletionRequest>): CompletionRequest {
  return {
    provider: 'anthropic',
    model: '',
    baseUrl: base,
    apiKey: 'good',
    system: 'sys',
    user: 'hi',
    maxTokens: 100,
    effort: 'low',
    ...over
  }
}

describe('parseSse', () => {
  it('splits events and keeps the unfinished rest', () => {
    const { events, rest } = parseSse(
      'event: a\ndata: 1\n\n: comment\ndata: x\ndata: y\n\nevent: b\nda'
    )
    expect(events).toEqual([
      { event: 'a', data: '1' },
      { event: 'message', data: 'x\ny' }
    ])
    expect(rest).toBe('event: b\nda')
    expect(parseSse('data: 1\r\n\r\n').events).toEqual([{ event: 'message', data: '1' }])
  })
})

describe('sseParser', () => {
  const all = (chunks: string[]): SseEvent[] => {
    const parse = sseParser()
    return chunks.flatMap((c) => parse(c))
  }

  it('gives the same events as parseSse, whatever the chunk boundaries', () => {
    const text = 'event: a\r\ndata: 1\r\n\r\n: comment\ndata: x\ndata: y\n\nevent: b\ndata: 2\n\n'
    const expected = parseSse(text).events
    expect(expected).toHaveLength(3)
    expect(all([text])).toEqual(expected)
    // Every split point, a "\r\n" or a "\n\n" cut in half included.
    for (let i = 1; i < text.length; i++)
      expect(all([text.slice(0, i), text.slice(i)])).toEqual(expected)
    expect(all(text.split(''))).toEqual(expected)
  })

  it('refuses an event without end, in linear time', () => {
    const parse = sseParser(1024 * 1024)
    const chunk = 'data: ' + 'y'.repeat(1024)
    const start = performance.now()
    expect(() => {
      for (let i = 0; i < 8 * 1024; i++) parse(chunk)
    }).toThrow(/too large/)
    expect(performance.now() - start).toBeLessThan(1000)
  })
})

describe('endpointFor', () => {
  it('normalizes base URLs', () => {
    expect(endpointFor('ollama', '')).toBe('http://localhost:11434/v1')
    expect(endpointFor('ollama', 'http://box:11434/')).toBe('http://box:11434/v1')
    expect(endpointFor('openai', 'http://localhost:1234/v1/')).toBe('http://localhost:1234/v1')
    expect(endpointFor('anthropic', '')).toBe('https://api.anthropic.com')
    expect(() => endpointFor('openai', 'file:///etc')).toThrow(/http/)
    expect(() => endpointFor('openai', 'not a url')).toThrow(/valid URL/)
  })

  it('sends keyed providers over https only (http just to this computer)', () => {
    expect(() => endpointFor('openai', 'http://proxy.example.test/v1')).toThrow(/https:\/\//)
    expect(() => endpointFor('anthropic', 'http://10.0.0.5')).toThrow(/https:\/\//)
    expect(endpointFor('openai', 'https://proxy.example.test/v1')).toBe(
      'https://proxy.example.test/v1'
    )
    expect(endpointFor('anthropic', 'http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(endpointFor('openai', 'http://[::1]:8080/v1')).toBe('http://[::1]:8080/v1')
    // The local provider may use a server elsewhere on the network.
    expect(endpointFor('ollama', 'http://192.168.1.20:11434')).toBe('http://192.168.1.20:11434/v1')
    expect(() => endpointFor('openai', 'https://user:pw@proxy.example.test')).toThrow(/user name/)
  })

  it('recognizes loopback hosts', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.8.9.10', '[::1]'])
      expect(isLoopbackHost(h)).toBe(true)
    for (const h of ['10.0.0.1', 'localhost.example.test', '128.0.0.1', '[::2]', 'example.test'])
      expect(isLoopbackHost(h)).toBe(false)
  })
})

describe('complete (misbehaving servers)', () => {
  const oa = (model: string): CompletionRequest =>
    req({ provider: 'ollama', baseUrl: base, apiKey: null, model })

  it('stops a stream that never ends an event', async () => {
    await expect(complete(fetch, oa('no-separator'))).rejects.toThrow(/event too large/)
  }, 15_000)

  it('stops an answer that never ends', async () => {
    let received = 0
    const r = { ...oa('endless'), onText: (t: string) => (received += t.length) }
    await expect(complete(fetch, r)).rejects.toThrow(/too long/)
    expect(received).toBeLessThanOrEqual(MAX_ANSWER_CHARS)
  }, 15_000)

  it('reads only the start of a huge error body or plain answer', async () => {
    const e = await complete(fetch, oa('huge-error')).catch((x: Error) => x)
    expect(e).toBeInstanceOf(Error)
    expect((e as Error).message).toMatch(/rejected the request \(400\)/)
    expect((e as Error).message.length).toBeLessThan(500)
    await expect(complete(fetch, oa('plain-huge'))).rejects.toThrow(/too large to read/)
  }, 15_000)
})

describe('complete (Anthropic)', () => {
  it('streams text, skips thinking, sends the right request', async () => {
    const chunks: string[] = []
    const text = await complete(fetch, req({ onText: (t) => chunks.push(t) }))
    expect(text).toBe('Hello world')
    expect(chunks).toEqual(['Hello', ' world'])
    const last = seen[seen.length - 1]
    expect(last.headers['anthropic-version']).toBe('2023-06-01')
    expect(last.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 100,
      system: 'sys',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      output_config: { effort: 'low' }
    })
    // Not the official endpoint: no beta fallback parameter.
    expect(last.body.fallbacks).toBeUndefined()
    expect(last.body.temperature).toBeUndefined()
  })

  it('explains errors', async () => {
    await expect(complete(fetch, req({ apiKey: 'bad' }))).rejects.toThrow(
      /API key was rejected.*401/
    )
    await expect(complete(fetch, req({ model: 'missing' }))).rejects.toThrow(
      /Model “missing” was not found/
    )
    await expect(complete(fetch, req({ model: 'busy' }))).rejects.toThrow(/Rate limit.*429/)
    await expect(complete(fetch, req({ model: 'refuse' }))).rejects.toThrow(/declined/)
    await expect(complete(fetch, req({ model: 'midstream-error' }))).rejects.toThrow(
      /overloaded_error/
    )
    await expect(complete(fetch, req({ apiKey: null }))).rejects.toThrow(
      /Add your Anthropic API key/
    )
  }, 15_000)

  it('retries a 429 once', async () => {
    const before = seen.filter((s) => s.body.model === 'busy').length
    await expect(complete(fetch, req({ model: 'busy' }))).rejects.toThrow()
    expect(seen.filter((s) => s.body.model === 'busy').length - before).toBe(2)
  }, 15_000)
})

describe('complete (OpenAI-compatible)', () => {
  const oa = (over: Partial<CompletionRequest>): CompletionRequest =>
    req({ provider: 'ollama', baseUrl: base, apiKey: null, model: 'llama3.1', ...over })

  it('streams chat completions without a key for a local server', async () => {
    expect(await complete(fetch, oa({}))).toBe('Hi there')
    const last = seen[seen.length - 1]
    expect(last.url).toBe('/v1/chat/completions')
    expect(last.headers.authorization).toBeUndefined()
    expect(last.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ])
  })

  it('sends the key as a bearer token for OpenAI', async () => {
    expect(await complete(fetch, oa({ provider: 'openai', apiKey: 'sk-1' }))).toBe('Hi there')
    expect(seen[seen.length - 1].headers.authorization).toBe('Bearer sk-1')
  })

  it('accepts a non-streamed JSON answer', async () => {
    expect(await complete(fetch, oa({ model: 'plain' }))).toBe('plain answer')
  })

  it('reports a missing model, a dead server, timeouts and cancellation', async () => {
    await expect(complete(fetch, oa({ model: 'nope' }))).rejects.toThrow(
      /Model “nope” was not found/
    )
    const closed = await freePort()
    await expect(complete(fetch, oa({ baseUrl: `http://127.0.0.1:${closed}` }))).rejects.toThrow(
      new RegExp(`Could not connect to http://127.0.0.1:${closed}/v1. Is Ollama`)
    )
    await expect(complete(fetch, oa({ model: 'slow', idleTimeoutMs: 300 }))).rejects.toThrow(
      /stopped answering|No answer/
    )
    const controller = new AbortController()
    const p = complete(fetch, oa({ model: 'slow', signal: controller.signal }))
    setTimeout(() => controller.abort(), 100)
    await expect(p).rejects.toThrow('Cancelled.')
  }, 15_000)
})
