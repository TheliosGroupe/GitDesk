// What counts as GitDesk's own page, for the IPC bridge, navigation, permissions and the
// app:// scheme the packaged UI is served from (see index.ts). Pure functions: unit-tested.
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { isAbsolute, relative, resolve, sep } from 'path'

/**
 * The packaged UI loads from app://gitdesk/, served only from the renderer bundle. Under
 * file:// the CSP's 'self' would match every file on disk, cloned repositories included.
 */
export const APP_SCHEME = 'app'
export const APP_HOST = 'gitdesk'
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

let appBase = `${APP_SCHEME}://${APP_HOST}`

/** Development: the UI comes from the Vite dev server (ELECTRON_RENDERER_URL) instead. */
export function setAppOrigin(url: string): void {
  appBase = baseOf(url) ?? appBase
}

/** "scheme://host[:port]", compared by hand: Node gives custom schemes a "null" origin. */
function baseOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.host ? `${u.protocol}//${u.host}` : null
  } catch {
    return null
  }
}

/** A URL (or origin) of GitDesk's own page. */
export function isAppUrl(url: string | undefined | null): boolean {
  return !!url && baseOf(url) === appBase
}

/**
 * Whether an IPC request comes from GitDesk's own page. Every API call goes through it
 * (see registerIpc in ipc.ts), so a page the window was navigated to, or a frame inside
 * it, cannot use the API.
 */
export function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = event.senderFrame
  // Top frame only: the preload never runs in subframes, but same-origin ones could reach it.
  return !!frame && !frame.parent && isAppUrl(frame.url)
}

/** The window never leaves the app: links and dropped files do not replace the UI. */
export function navigationAllowed(url: string): boolean {
  return isAppUrl(url)
}

/** A link that may open in the browser: https only, no user name or password in it. */
export function externalUrl(url: string): string | null {
  if (url.length > 4000) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null
  } catch {
    return null
  }
}

/** Clipboard copy and the terminal's paste: everything else (camera, location…) is denied. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'clipboard-read'])

export function permissionAllowed(permission: string, requestingUrl: string | undefined): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingUrl)
}

/** The bundle file an app:// URL names, or null when it is not one or leaves `root`. */
export function appFilePath(root: string, url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST) return null
  let path: string
  try {
    path = decodeURIComponent(u.pathname)
  } catch {
    return null
  }
  if (path.includes('\0')) return null
  if (path === '' || path === '/') path = '/index.html'
  const file = resolve(root, `.${path}`)
  const rel = relative(root, file)
  // Encoded ".." or "\" segments only show up after decoding: check the resolved path.
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return file
}
