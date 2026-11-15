// Provider layer: one text completion (streamed) against the Anthropic Messages API, the
// OpenAI Chat Completions API, or a local Ollama / OpenAI-compatible server.
// No Electron import: the fetch function is passed in, so this runs in plain Node for tests.

import { isIP } from 'net'
import type { AiProviderId } from '../../shared/features/ai'
import { fetchWithin, RedirectError, sameOrigin, type FetchFn } from '../safeFetch'

export const DEFAULT_MODELS: Record<AiProviderId, string> = {
  // Fast and good at code: a sensible default for commit messages and explanations.
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-5-mini',
  ollama: 'llama3.1'
}

export const DEFAULT_ENDPOINTS: Record<AiProviderId, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1'
}

export const PROVIDER_NAMES: Record<AiProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'the local server'
}

export type { FetchFn }

export interface CompletionRequest {
  provider: AiProviderId
  model: string
  /** Base URL; '' = the provider's default. */
  baseUrl: string
  apiKey: string | null
  system: string
  user: string
  maxTokens: number
  /** How hard the model should think (Anthropic models that support effort). */
  effort: 'low' | 'medium' | 'high'
  onText?: (text: string) => void
  signal?: AbortSignal
  /** No byte for this long = timeout (ms). */
  idleTimeoutMs?: number
  /** Whole request (ms). */
  totalTimeoutMs?: number
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'AiError'
  }
}

/** localhost, 127.0.0.0/8 or ::1: a server on this computer. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (isIP(h) === 4) return h.startsWith('127.')
  return h === '::1'
}

/**
 * Base URL of a provider: the setting with trailing slashes removed, or the default.
 * Anthropic and OpenAI always carry an API key: they need https:// (http:// only to this
 * computer). The local provider may use http:// on the network.
 */
export function endpointFor(provider: AiProviderId, baseUrl: string): string {
  const raw = baseUrl.trim()
  if (!raw) return DEFAULT_ENDPOINTS[provider]
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AiError(`“${raw}” is not a valid URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new AiError('The base URL must start with http:// or https://.')
  if (url.username || url.password)
    throw new AiError('The base URL must not contain a user name or password.')
  if (provider !== 'ollama' && url.protocol === 'http:' && !isLoopbackHost(url.hostname))
    throw new AiError(
      'The base URL must start with https://, so the API key is never sent unencrypted (http:// works only for a server on this computer).'
    )
  let s = url.toString().replace(/\/+$/, '')
  // "http://localhost:11434" → the OpenAI-compatible API lives under /v1.
  if (provider !== 'anthropic' && (url.pathname === '/' || url.pathname === '')) s += '/v1'
  return s
}

export function modelFor(provider: AiProviderId, model: string): string {
  return model.trim() || DEFAULT_MODELS[provider]
}

/** Anthropic models that take output_config.effort (Opus 4.5+, Sonnet 4.6, every 5.x model). */
function supportsEffort(model: string): boolean {
  return /^claude-((opus|sonnet|haiku|fable|mythos)-[5-9]|opus-4-[5-9]|sonnet-4-6)/.test(model)
}

/** Models with server-side refusal fallback ("default" mode) on the Claude API. */
function supportsDefaultFallback(model: string): boolean {
  return /^claude-(opus|sonnet)-5-5$/.test(model) || /^claude-(opus-5|fable-5(-1)?)$/.test(model)
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

export interface SseEvent {
  event: string
  data: string
}

/** One event at most this long (characters): a stream without separators is refused. */
export const MAX_SSE_EVENT_CHARS = 1024 * 1024
/** The whole answer at most this long (characters). */
export const MAX_ANSWER_CHARS = 1024 * 1024
/** Error bodies are read up to this many bytes. */
const MAX_ERROR_BYTES = 64 * 1024
/** A plain (not streamed) JSON answer up to this many bytes. */
const MAX_PLAIN_BYTES = 4 * 1024 * 1024
const TOO_LONG = 'The answer is too long: GitDesk stopped reading it (more than 1 MB of text).'

function parseEvent(block: string): SseEvent | null {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  return data.length ? { event, data: data.join('\n') } : null
}

/** Splits an SSE buffer into complete events; returns them and the unfinished remainder. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const blocks = buffer.replace(/\r\n?/g, '\n').split('\n\n')
  const rest = blocks.pop() ?? ''
  const events = blocks.map(parseEvent).filter((e): e is SseEvent => e !== null)
  return { events, rest }
}

/**
 * Incremental SSE parser: feed it decoded chunks, it returns the events they complete.
 * Linear in the input (only new text is searched for a separator); an event longer than
 * `maxEvent` throws instead of growing without end.
 */
export function sseParser(maxEvent = MAX_SSE_EVENT_CHARS): (chunk: string) => SseEvent[] {
  let parts: string[] = []
  let size = 0
  let last = '' // last character of the pending text
  let cr = false // the previous chunk ended with '\r' (maybe half of '\r\n')
  return (chunk) => {
    let text = cr ? '\r' + chunk : chunk
    cr = text.endsWith('\r')
    if (cr) text = text.slice(0, -1)
    text = text.replace(/\r\n?/g, '\n')
    const events: SseEvent[] = []
    const emit = (tail: string): void => {
      const ev = parseEvent(parts.join('') + tail)
      if (ev) events.push(ev)
      parts = []
      size = 0
      last = ''
    }
    let from = 0
    // The pending text ends with '\n' and this chunk starts with one: a separator across chunks.
    if (last === '\n' && text.startsWith('\n')) {
      parts = [parts.join('').slice(0, -1)]
      emit('')
      from = 1
    }
    for (;;) {
      const at = text.indexOf('\n\n', from)
      if (at === -1) break
      emit(text.slice(from, at))
      from = at + 2
    }
    const rest = text.slice(from)
    if (rest) {
      parts.push(rest)
      size += rest.length
      last = rest[rest.length - 1]
    }
    if (size > maxEvent) throw new AiError('The server sent an event too large to read.')
    return events
  }
}

/** A response body as text, read up to `maxBytes` (the rest is not downloaded). */
export async function readCapped(
  res: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { text: text + decoder.decode(), truncated: false }
    bytes += value.length
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined)
      const keep = value.subarray(0, value.length - (bytes - maxBytes))
      return { text: text + decoder.decode(keep), truncated: true }
    }
    text += decoder.decode(value, { stream: true })
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function serverMessage(body: string): string {
  try {
    const json = JSON.parse(body)
    const m = json?.error?.message ?? json?.message ?? json?.error
    if (typeof m === 'string') return m.trim().slice(0, 300)
  } catch {
    /* not JSON */
  }
  return body.trim().slice(0, 300)
}

export function httpError(
  provider: AiProviderId,
  status: number,
  body: string,
  model: string,
  endpoint: string
): AiError {
  const detail = serverMessage(body)
  const suffix = detail ? `\n${detail}` : ''
  const name = PROVIDER_NAMES[provider]
  if (status === 401)
    return new AiError(
      `The API key was rejected by ${name} (401). Check it in Settings → AI.${suffix}`,
      status
    )
  if (status === 403)
    return new AiError(
      `${name} refused the request (403): this key may not have access to ${model}.${suffix}`,
      status
    )
  if (status === 404) {
    const modelHint = /model/i.test(detail) || provider === 'anthropic'
    return new AiError(
      modelHint
        ? `Model “${model}” was not found, or your account cannot use it (404). Check the model name in Settings → AI.${suffix}`
        : `Nothing answers at ${endpoint} (404). Check the base URL and the model in Settings → AI.${suffix}`,
      status
    )
  }
  if (status === 429)
    return new AiError(
      `Rate limit or quota reached at ${name} (429). Wait a moment and try again.${suffix}`,
      status,
      true
    )
  if (status === 413)
    return new AiError(`The request is too large for ${name} (413).${suffix}`, status)
  if (status === 400) return new AiError(`${name} rejected the request (400).${suffix}`, status)
  if (status === 402)
    return new AiError(
      `Billing problem at ${name} (402): check your account’s credits.${suffix}`,
      status
    )
  if (status >= 500)
    return new AiError(
      `${name} is overloaded or unavailable (${status}). Try again shortly.${suffix}`,
      status,
      true
    )
  return new AiError(`${name} answered with an error (${status}).${suffix}`, status)
}

function networkError(provider: AiProviderId, endpoint: string, e: unknown): AiError {
  const err = e as { cause?: { code?: string; message?: string }; message?: string; code?: string }
  const code = err?.cause?.code ?? err?.code ?? ''
  const msg = err?.cause?.message ?? err?.message ?? String(e)
  const local = provider === 'ollama'
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(code + msg))
    return new AiError(
      local
        ? `Could not connect to ${endpoint}. Is Ollama (or your local server) running?`
        : `Could not connect to ${endpoint}.`,
      null,
      false
    )
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/.test(code + msg))
    return new AiError(`Could not reach ${endpoint}: check your internet connection.`, null, true)
  return new AiError(`Could not reach ${endpoint}: ${msg}`, null, true)
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface Built {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  /** Text and stop info from one parsed SSE event. */
  read(ev: SseEvent): { text?: string; done?: boolean; error?: string; refusal?: boolean }
}

function buildAnthropic(req: CompletionRequest, endpoint: string, model: string): Built {
  const official = endpoint === DEFAULT_ENDPOINTS.anthropic
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': req.apiKey ?? ''
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    stream: true
  }
  if (supportsEffort(model)) body.output_config = { effort: req.effort }
  if (official && supportsDefaultFallback(model)) {
    // On a safety decline the API re-runs the request on Anthropic's recommended model.
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'
    body.fallbacks = 'default'
  }
  return {
    url: `${endpoint}/v1/messages`,
    headers,
    body,
    read(ev) {
      let json: Record<string, unknown>
      try {
        json = JSON.parse(ev.data)
      } catch {
        return {}
      }
      const type = json.type
      if (type === 'content_block_delta') {
        const delta = json.delta as { type?: string; text?: string } | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string')
          return { text: delta.text }
      } else if (type === 'message_delta') {
        const stop = (json.delta as { stop_reason?: string } | undefined)?.stop_reason
        if (stop === 'refusal') return { refusal: true }
      } else if (type === 'message_stop') return { done: true }
      else if (type === 'error') {
        const e = json.error as { type?: string; message?: string } | undefined
        return { error: `${e?.type ?? 'error'}: ${e?.message ?? 'unknown error'}` }
      }
      return {}
    }
  }
}

function buildOpenAi(req: CompletionRequest, endpoint: string, model: string): Built {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`
  return {
    url: `${endpoint}/chat/completions`,
    headers,
    body: {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user }
      ],
      stream: true
    },
    read(ev) {
      if (ev.data.trim() === '[DONE]') return { done: true }
      let json: Record<string, unknown>
      try {
        json = JSON.parse(ev.data)
      } catch {
        return {}
      }
      if (json.error) {
        const e = json.error as { message?: string } | string
        return { error: typeof e === 'string' ? e : (e.message ?? 'unknown error') }
      }
      const choice = (
        json.choices as { delta?: { content?: string }; finish_reason?: string }[]
      )?.[0]
      const text = choice?.delta?.content
      if (choice?.finish_reason === 'content_filter') return { refusal: true }
      return typeof text === 'string' && text ? { text } : {}
    }
  }
}

/** Runs one completion and returns its whole text (also streamed to onText). */
export async function complete(fetchFn: FetchFn, req: CompletionRequest): Promise<string> {
  const endpoint = endpointFor(req.provider, req.baseUrl)
  const model = modelFor(req.provider, req.model)
  if (req.provider !== 'ollama' && !req.apiKey)
    throw new AiError(`Add your ${PROVIDER_NAMES[req.provider]} API key in Settings → AI first.`)
  const built =
    req.provider === 'anthropic'
      ? buildAnthropic(req, endpoint, model)
      : buildOpenAi(req, endpoint, model)

  let attempt = 0
  for (;;) {
    try {
      return await once(fetchFn, req, built, endpoint, model)
    } catch (e) {
      // One retry for overload / rate limits, after a short pause.
      if (
        e instanceof AiError &&
        e.retryable &&
        e.status !== null &&
        attempt === 0 &&
        !req.signal?.aborted
      ) {
        attempt++
        await new Promise((r) => setTimeout(r, 1500))
        continue
      }
      throw e
    }
  }
}

async function once(
  fetchFn: FetchFn,
  req: CompletionRequest,
  built: Built,
  endpoint: string,
  model: string
): Promise<string> {
  const controller = new AbortController()
  const idleMs = req.idleTimeoutMs ?? 90_000
  const totalMs = req.totalTimeoutMs ?? 300_000
  let timedOut: string | null = null
  const abort = (why: string): void => {
    timedOut = why
    controller.abort()
  }
  let idle = setTimeout(() => abort(`No answer from ${endpoint} after ${idleMs / 1000} s.`), idleMs)
  const bump = (): void => {
    clearTimeout(idle)
    idle = setTimeout(() => abort(`${endpoint} stopped answering for ${idleMs / 1000} s.`), idleMs)
  }
  const total = setTimeout(
    () => abort(`The request took longer than ${Math.round(totalMs / 60000)} minutes.`),
    totalMs
  )
  const onCancel = (): void => controller.abort()
  req.signal?.addEventListener('abort', onCancel)
  const fail = (e: unknown): never => {
    if (req.signal?.aborted) throw new AiError('Cancelled.')
    if (timedOut) throw new AiError(timedOut, null, false)
    if (e instanceof AiError) throw e
    if (e instanceof RedirectError)
      throw new AiError(
        `${e.message} GitDesk does not send your API key to another address: check the base URL in Settings → AI.`
      )
    throw networkError(req.provider, endpoint, e)
  }
  try {
    if (req.signal?.aborted) throw new AiError('Cancelled.')
    let res: Response
    try {
      // The API key travels in a header that fetch would keep on a redirect to another
      // origin: redirects are followed only on the endpoint's own origin.
      res = await fetchWithin(
        fetchFn,
        built.url,
        {
          method: 'POST',
          headers: built.headers,
          body: JSON.stringify(built.body),
          signal: controller.signal
        },
        sameOrigin(built.url)
      )
    } catch (e) {
      return fail(e)
    }
    bump()
    if (!res.ok) {
      const { text } = await readCapped(res, MAX_ERROR_BYTES).catch(() => ({ text: '' }))
      throw httpError(req.provider, res.status, text, model, endpoint)
    }
    const type = res.headers.get('content-type') ?? ''
    // A server that ignored "stream": a plain JSON answer.
    if (!type.includes('text/event-stream')) {
      const { text, truncated } = await readCapped(res, MAX_PLAIN_BYTES)
      if (truncated) throw new AiError('The server’s answer is too large to read.')
      const out = plainAnswer(req.provider, text)
      if (out.length > MAX_ANSWER_CHARS) throw new AiError(TOO_LONG)
      if (out) req.onText?.(out)
      return out
    }
    if (!res.body) throw new AiError('Empty answer from the server.')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parse = sseParser()
    let out = ''
    let refused = false
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (e) {
        return fail(e)
      }
      if (chunk.done) break
      bump()
      for (const ev of parse(decoder.decode(chunk.value, { stream: true }))) {
        const r = built.read(ev)
        if (r.error)
          throw new AiError(
            `${PROVIDER_NAMES[req.provider]} reported an error: ${r.error}`,
            null,
            /overload/i.test(r.error)
          )
        if (r.refusal) refused = true
        if (r.text) {
          out += r.text
          if (out.length > MAX_ANSWER_CHARS) throw new AiError(TOO_LONG)
          req.onText?.(r.text)
        }
      }
    }
    if (refused && !out.trim())
      throw new AiError('The model declined this request. Try again or use another model.')
    if (!out.trim()) throw new AiError('The model returned an empty answer.')
    return out
  } catch (e) {
    return fail(e)
  } finally {
    clearTimeout(idle)
    clearTimeout(total)
    req.signal?.removeEventListener('abort', onCancel)
    // Stops the download when reading ended early (a cap, an error event); no-op otherwise.
    controller.abort()
  }
}

function plainAnswer(provider: AiProviderId, body: string): string {
  try {
    const json = JSON.parse(body)
    if (provider === 'anthropic') {
      if (json.stop_reason === 'refusal')
        throw new AiError('The model declined this request. Try again or use another model.')
      return (json.content ?? [])
        .filter((b: { type?: string }) => b.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join('')
    }
    return json.choices?.[0]?.message?.content ?? ''
  } catch (e) {
    if (e instanceof AiError) throw e
    throw new AiError('The server’s answer could not be read.')
  }
}
