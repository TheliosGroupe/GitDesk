// Runtime checks for the JSON of hosting services and issue trackers. The TypeScript types
// say what an API promises; these make sure of it before anything is stored or reaches the
// UI. A wrong-typed field becomes null (or a default) and an item without what identifies
// it is skipped, so one odd answer cannot break a list, a settings page or a sign-in.
// No Electron imports (unit tested).

export type Json = Record<string, unknown>

const EMPTY: Json = Object.freeze(Object.create(null))

/** v as an object (never an array), else an empty one, so obj(obj(p).head).ref is safe. */
export const obj = (v: unknown): Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : EMPTY

/** v as an array of at most `max` items, else []. */
export const list = (v: unknown, max = 1000): unknown[] => (Array.isArray(v) ? v.slice(0, max) : [])

/** A string cut to `max` characters, else null. */
export const str = (v: unknown, max = 1000): string | null =>
  typeof v === 'string' ? v.slice(0, max) : null

/** A non-negative safe integer, else null. */
export const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null

/** An http(s) URL of reasonable length, as given; else null. */
export function link(v: unknown, max = 2048): string | null {
  if (typeof v !== 'string' || v.length > max || !/^https?:\/\//i.test(v)) return null
  try {
    new URL(v)
    return v
  } catch {
    return null
  }
}

/** Does s hold a control character (newline, NUL, DEL…)? */
export function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 32 || code === 127) return true
  }
  return false
}

/** A login or display name: trimmed, 1 to 200 characters, no control characters; else null. */
export function userName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s && s.length <= 200 && !hasControl(s) ? s : null
}

/** true only for true. */
export const bool = (v: unknown): boolean => v === true

/** A non-empty string of at most `max` characters, else null. */
export const nonEmpty = (v: unknown, max = 1000): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null

/** A branch or ref name as a provider reports it: non-empty, bounded, no control characters. */
export const refName = (v: unknown): string | null =>
  typeof v === 'string' && v && v.length <= REF_MAX && !hasControl(v) ? v : null

/**
 * A repository path from provider data ("owner/repo", "group/sub/repo"): segments that are
 * not empty, not dots only, without spaces, backslashes or control characters; else null.
 */
export function repoSlug(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > SLUG_MAX || /[\s\\]/.test(v) || hasControl(v)) return null
  const segments = v.split('/')
  return segments.length >= 2 && segments.every((s) => s && !dotsOnly(s)) ? v : null
}

/** "." and ".." (and "..."): never a path segment of an API URL. */
export const dotsOnly = (s: string): boolean => /^\.+$/.test(s)

/**
 * A repository slug as URL path segments, each one encoded. Refuses empty and dot segments,
 * so a slug cannot move an API request to another path. `parts`: exact number of segments.
 */
export function slugPath(slug: string, parts?: number): string {
  const segments = slug.split('/')
  if ((parts && segments.length !== parts) || segments.some((s) => !s || dotsOnly(s)))
    throw new Error(`Invalid repository ${slug.slice(0, 200)}`)
  return segments.map(encodeURIComponent).join('/')
}

export const TITLE_MAX = 1000
export const REF_MAX = 255
export const SLUG_MAX = 300
