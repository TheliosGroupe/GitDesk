// A small global store kept in localStorage, shared by every repository tab (like panelWidths).
// Storage may be blocked or corrupted: reading falls back to the defaults, writing is best effort.

import { useSyncExternalStore } from 'react'

export interface LayoutStore<T> {
  get(): T
  set(update: T | ((current: T) => T)): void
  use(): T
}

/** `sanitize` turns whatever was saved (unknown shape) into a valid value. */
export function createLayoutStore<T>(key: string, sanitize: (saved: unknown) => T): LayoutStore<T> {
  const listeners = new Set<() => void>()
  let value: T
  try {
    const raw = localStorage.getItem(key)
    value = sanitize(raw === null ? undefined : JSON.parse(raw))
  } catch {
    value = sanitize(undefined)
  }
  const subscribe = (l: () => void): (() => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }
  const get = (): T => value
  return {
    get,
    set(update) {
      const next = typeof update === 'function' ? (update as (c: T) => T)(value) : update
      if (next === value) return
      value = next
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // Not persisted; still applied for this session.
      }
      listeners.forEach((l) => l())
    },
    use: () => useSyncExternalStore(subscribe, get)
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v))
