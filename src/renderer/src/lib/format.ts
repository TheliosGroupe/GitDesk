// The UI is in English; en-GB keeps day-month-year order for dates.
export const LOCALE = 'en-GB'

const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' })

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60]
]

export function relativeTime(unixSeconds: number): string {
  const diff = unixSeconds - Date.now() / 1000
  for (const [unit, seconds] of UNITS) {
    if (Math.abs(diff) >= seconds) return rtf.format(Math.round(diff / seconds), unit)
  }
  return rtf.format(0, 'minute')
}

export function fullDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** Stable hue per author so the same person always gets the same avatar color. */
export function hueFor(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
  return h % 360
}

export function fileName(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

export function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i + 1)
}

export function repoName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Strips Electron's "Error invoking remote method 'api:x': Error:" prefix. */
export function errorMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '').trim()
}
