// Auto-update from GitHub Releases (electron-updater). Packaged builds only:
// electron-builder writes the feed (app-update.yml) next to the app from the
// `publish` section of electron-builder.yml, and each release carries the
// latest*.yml files the updater reads.
//
// Nothing installs without the user: a found update downloads in the background, then
// waits for "Restart to install" (installUpdate). Builds are not code-signed yet, so the
// only check on a download is the sha512 listed in the same GitHub release.
import { execFile } from 'child_process'
import { app, BrowserWindow, shell } from 'electron'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'
import { resolve } from 'path'
import { UPDATE_STATUS_CHANNEL } from '../shared/api'
import type { UpdateStatus } from '../shared/types'
import { loadState } from './store'

/** Where an update is downloaded by hand when this build cannot install it itself. */
export const RELEASES_URL = 'https://github.com/TheliosGroupe/GitDesk/releases/latest'
/** First automatic check once the window is up, then every few hours. */
const FIRST_CHECK_MS = 10_000
const RECHECK_MS = 6 * 60 * 60 * 1000

let status: UpdateStatus = { state: 'idle' }
let updater: Promise<AppUpdater> | null = null
let pending: Promise<UpdateStatus> | null = null
let selfInstall: Promise<boolean> | null = null
let timers: NodeJS.Timeout[] = []

function setStatus(next: UpdateStatus): void {
  status = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(UPDATE_STATUS_CHANNEL, status)
  }
}

function describe(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  // No app-update.yml: the build was made without a `publish` configuration.
  if (/app-update\.yml/.test(text) && /ENOENT|no such file/i.test(text)) {
    return 'Updates are not configured for this build.'
  }
  // electron-updater errors can carry whole HTTP responses: keep the first line.
  return text.split('\n')[0].trim() || 'Update check failed.'
}

/** Updates are off when running from source and during test runs. */
function disabled(): boolean {
  return !app.isPackaged || !!process.env.GITDESK_USER_DATA
}

/** `codesign -dv` output of an app signed with a Developer ID (not ad hoc, not unsigned). */
export function developerIdSigned(codesignOutput: string): boolean {
  return /^Authority=Developer ID Application:/m.test(codesignOutput)
}

/**
 * Whether this build can install an update itself. macOS (Squirrel.Mac) rejects every
 * update of an app without a Developer ID signature, so an unsigned build would download
 * each release and then fail: it points to the release page instead.
 */
function canSelfInstall(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(true)
  // …/GitDesk.app/Contents/MacOS/GitDesk → …/GitDesk.app
  const bundle = resolve(process.execPath, '../../..')
  selfInstall ??= new Promise((done) =>
    execFile('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], (error, stdout, stderr) =>
      done(!error && developerIdSigned(`${stdout}\n${stderr}`))
    )
  )
  return selfInstall
}

type UpdaterModule = typeof import('electron-updater')

/**
 * electron-updater is CommonJS and defines `autoUpdater` with a getter, which Node's
 * import() does not expose as a named export: it is only on the default export.
 */
export function autoUpdaterOf(m: UpdaterModule): AppUpdater {
  return ((m as { default?: UpdaterModule }).default ?? m).autoUpdater
}

/** Loaded on the first check: electron-updater and its ~160 modules stay out of startup. */
function getUpdater(): Promise<AppUpdater> {
  updater ??= import('electron-updater').then((m) => {
    const autoUpdater = autoUpdaterOf(m)
    // Never on quit: the user installs with "Restart to install".
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
    autoUpdater.on('update-available', (info: UpdateInfo) =>
      setStatus({ state: 'available', version: info.version })
    )
    autoUpdater.on('update-not-available', () => setStatus({ state: 'none' }))
    autoUpdater.on('download-progress', (p: ProgressInfo) =>
      setStatus({
        state: 'downloading',
        version: status.version,
        percent: Math.round(p.percent)
      })
    )
    autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
      setStatus({ state: 'ready', version: info.version })
    )
    autoUpdater.on('error', (e: Error) =>
      setStatus({ state: 'error', version: status.version, error: describe(e) })
    )
    return autoUpdater
  })
  return updater
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/**
 * Checks GitHub Releases now; a found update downloads in the background where this build
 * can install it, and stays 'available' otherwise. Never throws.
 */
export function checkForUpdates(): Promise<UpdateStatus> {
  if (disabled()) {
    if (status.state !== 'disabled') setStatus({ state: 'disabled' })
    return Promise.resolve(status)
  }
  // Already downloading or downloaded: nothing new to check.
  if (status.state === 'downloading' || status.state === 'ready') return Promise.resolve(status)
  if (pending) return pending
  const check = (async () => {
    // Start asynchronously: a synchronous throw must not run the cleanup below before
    // `pending` is even assigned (it would then stay set forever).
    await Promise.resolve()
    try {
      const u = await getUpdater()
      u.autoDownload = await canSelfInstall()
      const result = await u.checkForUpdates()
      // null: the updater is inactive (for example no feed configured).
      if (!result && status.state === 'checking') setStatus({ state: 'none' })
    } catch (e) {
      setStatus({ state: 'error', version: status.version, error: describe(e) })
    }
    return status
  })()
  pending = check
  void check.finally(() => {
    if (pending === check) pending = null
  })
  return check
}

/**
 * The user's go-ahead. A downloaded update: quit and install it. A found one: download it,
 * or open the release page when this build cannot install it itself (unsigned macOS).
 */
export async function installUpdate(): Promise<void> {
  if (disabled() || !updater) return
  const u = await updater
  if (status.state === 'ready') {
    // Let the IPC reply go out before the windows close.
    setImmediate(() => u.quitAndInstall())
  } else if (status.state === 'available') {
    if (await canSelfInstall())
      void u.downloadUpdate().catch(() => {}) // reported by 'error'
    else await shell.openExternal(RELEASES_URL)
  }
}

/** A check the user did not ask for: only while "automatic updates" is on. */
function automaticCheck(): void {
  if (loadState().settings.autoUpdate) void checkForUpdates()
}

function stopTimers(): void {
  timers.forEach(clearTimeout)
  timers = []
}

/**
 * Follows the "automatic updates" setting right away: on, it checks (after `delay`) and
 * then every few hours; off, it stops checking. Nothing ever installs without the user.
 */
export function applyUpdateSetting(enabled: boolean, delay = 0): void {
  stopTimers()
  if (disabled() || !enabled) return
  const first = setTimeout(automaticCheck, delay)
  const again = setInterval(automaticCheck, RECHECK_MS)
  first.unref?.()
  again.unref?.()
  timers = [first, again]
}

/** Called once the main window exists. */
export function initUpdater(): void {
  if (disabled()) {
    setStatus({ state: 'disabled' })
    return
  }
  applyUpdateSetting(loadState().settings.autoUpdate, FIRST_CHECK_MS)
}
