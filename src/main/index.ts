import { app, BrowserWindow, Menu, nativeTheme, protocol, session, shell } from 'electron'
import type { MenuItemConstructorOptions, WebContents } from 'electron'
import { readFile } from 'fs/promises'
import { writeFileSync } from 'fs'
import { extname, join } from 'path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { tokenFor } from './accounts'
import { setAuthResolver } from './git'
import { registerIpc } from './ipc'
import {
  APP_SCHEME,
  APP_URL,
  appFilePath,
  externalUrl,
  navigationAllowed,
  permissionAllowed,
  setAppOrigin
} from './ipcGuard'
import { cleanupRebaseFiles } from './repo'
import { accountFor, loadState } from './store'
import { scheduleSync, syncAll } from './sync'
import { initUpdater } from './updater'
import { unwatchAll } from './watcher'

// Repositories cloned through GitDesk authenticate with their GitHub account;
// every other repository keeps using your own git credentials.
setAuthResolver((cwd) => {
  const login = accountFor(cwd)
  const token = login ? tokenFor(login) : null
  return login && token ? { login, token } : null
})

// Lets a test run use its own settings instead of your real repository list.
if (process.env.GITDESK_USER_DATA) app.setPath('userData', process.env.GITDESK_USER_DATA)

/** The Vite dev server (`npm run dev`); otherwise the bundle, served on app:// below. */
const devServer = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
if (devServer) setAppOrigin(devServer)

// Standard + secure: a real origin (CSP 'self' = the bundle only), module scripts, storage.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true }
  }
])

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

/** app://gitdesk/<path>: files of out/renderer, nothing outside it. */
function serveRenderer(): void {
  const root = join(__dirname, '../renderer')
  protocol.handle(APP_SCHEME, async (request) => {
    const file = appFilePath(root, request.url)
    if (!file) return new Response('Not found', { status: 404 })
    try {
      const body = new Uint8Array(await readFile(file))
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
      return new Response(body, { headers: { 'content-type': type } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/** Window color before the page paints, matching the chosen theme (no white or dark flash). */
function windowBackground(): string {
  const theme = loadState().settings.theme
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
  return dark ? '#1b1e24' : '#ffffff'
}

/**
 * Every page GitDesk shows stays GitDesk's: no navigation away (a link, a dropped file),
 * no new windows (https links open in the browser), no <webview>.
 */
function guardContents(contents: WebContents): void {
  const openOutside = (url: string): void => {
    const safe = externalUrl(url)
    if (safe) void shell.openExternal(safe)
  }
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url)
    return { action: 'deny' }
  })
  const block = (e: Electron.Event, url: string, mainFrame = true): void => {
    if (navigationAllowed(url)) return
    e.preventDefault()
    if (mainFrame) openOutside(url)
  }
  contents.on('will-navigate', (e) => block(e, e.url))
  contents.on('will-redirect', (e) => block(e, e.url, false))
  contents.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame) block(e, e.url, false)
  })
  contents.on('will-attach-webview', (e) => e.preventDefault())
}

/** Clipboard for the app's own page; camera, microphone, location, devices… denied. */
function denyPermissions(): void {
  const s = session.defaultSession
  s.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(permissionAllowed(permission, details.requestingUrl))
  )
  s.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    permissionAllowed(permission, requestingOrigin)
  )
  s.setDevicePermissionHandler(() => false)
}

/** Packaged builds: no Reload or Developer Tools entries (the default menu has both). */
function productionMenu(): void {
  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }
  // Windows and Linux: Ctrl+W closes a tab (or deletes a word in the terminal) and Ctrl+M
  // is Enter in the terminal, so these Window entries carry no accelerator. Alt+F4 still
  // closes the window; File holds Exit (Quit, Ctrl+Q on Linux).
  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { label: 'Minimize', click: (_item, win) => win?.minimize() },
      { label: 'Close Window', click: (_item, win) => win?.close() }
    ]
  }
  const template: MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [{ role: 'appMenu' }, { role: 'editMenu' }, view, { role: 'windowMenu' }]
      : [{ role: 'fileMenu' }, { role: 'editMenu' }, view, windowMenu]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * A crashed or killed renderer (out of memory on a huge answer or diff) would leave the
 * window blank until GitDesk restarts: reload it, at most 3 times a minute, so a page
 * that crashes on every load does not loop.
 */
function reloadAfterCrash(win: BrowserWindow): void {
  const recent: number[] = []
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`GitDesk: the window's renderer stopped (${details.reason})`)
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    const now = Date.now()
    while (recent.length && now - recent[0] > 60_000) recent.shift()
    if (recent.length >= 3) {
      console.error('GitDesk: the renderer keeps crashing; not reloading again')
      return
    }
    recent.push(now)
    win.webContents.reload()
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    show: false,
    title: 'GitDesk',
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  reloadAfterCrash(mainWindow)

  // GITDESK_SCREENSHOT=<file.png>: capture the window once the UI has settled, then quit.
  const screenshot = process.env.GITDESK_SCREENSHOT
  if (screenshot) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(
        async () => {
          const image = await mainWindow.webContents.capturePage()
          writeFileSync(screenshot, image.toPNG())
          app.quit()
        },
        Number(process.env.GITDESK_SCREENSHOT_DELAY ?? 4000)
      )
    })
  }

  void mainWindow.loadURL(devServer ?? APP_URL)
}

/** Another launch on the same profile: bring this window forward instead. */
function focusWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    if (app.isReady()) createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// One process per profile: two would overwrite each other's gitdesk.json and accounts.
// The lock belongs to the user-data folder, so test runs with GITDESK_USER_DATA can overlap.
if (!app.requestSingleInstanceLock()) {
  console.log(
    'GitDesk is already running with this profile (set GITDESK_USER_DATA to run another).'
  )
  app.quit()
} else {
  app.on('second-instance', focusWindow)

  app.on('web-contents-created', (_, contents) => guardContents(contents))

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('group.thelios.gitdesk')

    // F12 opens DevTools in development; Ctrl+R reload is disabled in production.
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
    if (app.isPackaged) productionMenu()

    denyPermissions()
    serveRenderer()
    registerIpc()
    createWindow()

    // Packaged builds look for a new GitHub release unless auto-update is turned off.
    initUpdater()

    // Temp files of interactive rebases that ended while GitDesk was closed.
    void cleanupRebaseFiles().catch(() => {})

    // Follow GitHub repositories: fetch shortly after start, then on the configured interval.
    scheduleSync()
    setTimeout(() => void syncAll(), 15_000)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    unwatchAll()
    if (process.platform !== 'darwin') app.quit()
  })
}
