import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AiStatus } from '../../../../shared/features/ai'
import { errorMessage } from '../../lib/format'

// One shared copy of aiStatus() for every component: refreshed when the window regains focus,
// when the main process says the keys changed ('ai:status'), and after AiSettings saves.

let current: AiStatus | null = null
let loading: Promise<void> | null = null
let subscribed = false
const listeners = new Set<() => void>()

function publish(next: AiStatus): void {
  current = next
  for (const l of listeners) l()
}

/** Re-reads the AI status (call after changing AI settings). */
export function refreshAiStatus(): Promise<void> {
  if (!loading) {
    loading = window.api
      .aiStatus()
      .then(publish, () => undefined)
      .finally(() => {
        loading = null
      })
  }
  return loading
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!subscribed) {
    subscribed = true
    window.addEventListener('focus', () => void refreshAiStatus())
    window.api.on('ai:status', publish)
  }
  if (!current) void refreshAiStatus()
  return () => listeners.delete(listener)
}

/** The provider settings (null until loaded). */
export function useAiStatus(): AiStatus | null {
  return useSyncExternalStore(subscribe, () => current)
}

/** True when a provider is configured with a key (or a local endpoint). */
export function useAiAvailable(): boolean {
  return !!useAiStatus()?.configured
}

let counter = 0

/** A fresh id for a streamed request. */
export function newRequestId(): string {
  counter++
  return `ai-${Date.now().toString(36)}-${counter}`
}

/** Text streamed so far for `requestId` (reset when it changes). */
export function useAiStream(requestId: string | null): string {
  const [state, setState] = useState<{ id: string | null; text: string }>({ id: null, text: '' })
  useEffect(() => {
    if (!requestId) return
    return window.api.on('ai:chunk', (chunk) => {
      if (chunk.requestId !== requestId) return
      setState((s) =>
        s.id === requestId
          ? { id: s.id, text: s.text + chunk.text }
          : { id: requestId, text: chunk.text }
      )
    })
  }, [requestId])
  return state.id === requestId ? state.text : ''
}

export interface AiRun<T> {
  /** Text streamed so far. */
  streamed: string
  result: T | null
  error: string | null
  done: boolean
  /** Stops the request (it ends with error "Cancelled."). */
  cancel(): void
}

/**
 * Runs `start` with a fresh request id whenever `key` changes (include a counter in the key
 * to run again), collecting the streamed text. Unmounting or a new key cancels the request.
 */
export function useAiRequest<T>(start: (requestId: string) => Promise<T>, key: string): AiRun<T> {
  const startRef = useRef(start)
  const idRef = useRef<string | null>(null)
  useEffect(() => {
    startRef.current = start
  })
  const [state, setState] = useState<{
    key: string
    streamed: string
    result: T | null
    error: string | null
    done: boolean
  } | null>(null)
  useEffect(() => {
    const id = newRequestId()
    idRef.current = id
    let live = true
    const empty = { key, streamed: '', result: null, error: null, done: false }
    const off = window.api.on('ai:chunk', (chunk) => {
      if (!live || chunk.requestId !== id) return
      setState((s) => {
        const base = s?.key === key ? s : empty
        return { ...base, streamed: base.streamed + chunk.text }
      })
    })
    startRef.current(id).then(
      (result) => {
        if (live) setState((s) => ({ ...(s?.key === key ? s : empty), result, done: true }))
      },
      (e) => {
        if (live)
          setState((s) => ({ ...(s?.key === key ? s : empty), error: errorMessage(e), done: true }))
      }
    )
    return () => {
      live = false
      off()
      void window.api.aiCancel(id)
    }
  }, [key])
  const current = state?.key === key ? state : null
  return {
    streamed: current?.streamed ?? '',
    result: current?.result ?? null,
    error: current?.error ?? null,
    done: current?.done ?? false,
    cancel: () => {
      if (idRef.current) void window.api.aiCancel(idRef.current)
    }
  }
}
