import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A stand-in for electron-updater: a check finds v9.9.9 and, when autoDownload is on,
// "downloads" it at once.
class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  checkForUpdates = vi.fn(async () => {
    this.emit('checking-for-update')
    this.emit('update-available', { version: '9.9.9' })
    if (this.autoDownload) await this.downloadUpdate()
    return { updateInfo: { version: '9.9.9' } }
  })
  downloadUpdate = vi.fn(async () => {
    this.emit('update-downloaded', { version: '9.9.9' })
    return []
  })
  quitAndInstall = vi.fn()
}

const h = vi.hoisted(() => ({
  loaded: false,
  updater: null as unknown as FakeUpdater,
  autoUpdate: true,
  codesign: '',
  openExternal: (() => {}) as (url: string) => void
}))

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: async (url: string) => h.openExternal(url) }
}))
vi.mock('../../src/main/store', () => ({
  loadState: () => ({ settings: { autoUpdate: h.autoUpdate } })
}))
vi.mock('child_process', () => ({
  execFile: (_cmd: string, _args: string[], done: (e: null, out: string, err: string) => void) =>
    done(null, '', h.codesign)
}))

type Updater = typeof import('../../src/main/updater')
const load = async (): Promise<Updater> => import('../../src/main/updater')
const platform = process.platform
const setPlatform = (p: string): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
const userData = process.env.GITDESK_USER_DATA

beforeEach(() => {
  vi.resetModules()
  // Registered per test: the factory runs again (and flags the load) after resetModules.
  // Shaped like the real module under Node's import(): no named `autoUpdater` export,
  // only a getter on the CommonJS default export.
  vi.doMock('electron-updater', () => {
    h.loaded = true
    h.updater = new FakeUpdater()
    return {
      default: {
        get autoUpdater() {
          return h.updater
        }
      }
    }
  })
  h.loaded = false
  h.updater = null as unknown as FakeUpdater
  h.autoUpdate = true
  h.codesign = ''
  h.openExternal = vi.fn()
  delete process.env.GITDESK_USER_DATA
  setPlatform('win32')
})

afterEach(() => {
  vi.useRealTimers()
  setPlatform(platform)
  if (userData !== undefined) process.env.GITDESK_USER_DATA = userData
})

describe('updater', () => {
  it('loads electron-updater only for the first check, a few seconds after start', async () => {
    vi.useFakeTimers()
    const u = await load()
    u.initUpdater()
    expect(h.loaded).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    vi.useRealTimers()
    await vi.waitFor(() => expect(u.getUpdateStatus().state).toBe('ready'))
    expect(h.loaded).toBe(true)
  })

  it('never installs on quit: only the user starts the install', async () => {
    const u = await load()
    expect((await u.checkForUpdates()).state).toBe('ready')
    expect(h.updater.autoInstallOnAppQuit).toBe(false)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
    await u.installUpdate()
    await new Promise((r) => setImmediate(r))
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('does not download on unsigned macOS builds and points to the release page', async () => {
    setPlatform('darwin')
    h.codesign = 'Executable=/Applications/GitDesk.app/Contents/MacOS/GitDesk\nSignature=adhoc\n'
    const u = await load()
    expect(await u.checkForUpdates()).toEqual({ state: 'available', version: '9.9.9' })
    expect(h.updater.autoDownload).toBe(false)
    expect(h.updater.downloadUpdate).not.toHaveBeenCalled()
    await u.installUpdate()
    expect(h.openExternal).toHaveBeenCalledWith(u.RELEASES_URL)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('updates itself on macOS once builds are signed with a Developer ID', async () => {
    setPlatform('darwin')
    h.codesign = 'Authority=Developer ID Application: Someone (TEAMID)\nAuthority=Apple Root CA\n'
    const u = await load()
    expect((await u.checkForUpdates()).state).toBe('ready')
    expect(h.updater.autoDownload).toBe(true)
  })

  it('stops checking as soon as the setting is turned off', async () => {
    vi.useFakeTimers()
    const u = await load()
    u.initUpdater()
    u.applyUpdateSetting(false)
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
    expect(h.loaded).toBe(false)
  })

  it('checks right away when turned on', async () => {
    h.autoUpdate = false
    vi.useFakeTimers()
    const u = await load()
    u.initUpdater()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.loaded).toBe(false)

    h.autoUpdate = true
    vi.useRealTimers()
    u.applyUpdateSetting(true)
    await vi.waitFor(() => expect(h.updater?.checkForUpdates).toHaveBeenCalledTimes(1))
  })

  it('checks again every six hours while the setting stays on', async () => {
    // Unsigned macOS: the found update stays 'available', so later checks still run.
    setPlatform('darwin')
    vi.useFakeTimers()
    const u = await load()
    u.initUpdater()
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(h.updater?.checkForUpdates).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    await vi.waitFor(() => expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(2))
  })

  it('re-reads the setting before an automatic check', async () => {
    vi.useFakeTimers()
    const u = await load()
    u.initUpdater()
    h.autoUpdate = false
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.loaded).toBe(false)
  })

  it('stays off in test runs', async () => {
    process.env.GITDESK_USER_DATA = 'x'
    const u = await load()
    u.initUpdater()
    expect((await u.checkForUpdates()).state).toBe('disabled')
    await u.installUpdate()
    expect(h.loaded).toBe(false)
  })
})

describe('electron-updater module shape', () => {
  // The real package as the built main process loads it (a native import()). Reading
  // autoUpdater would construct it, which needs Electron: only its presence is checked.
  it('has autoUpdater on the default export, which autoUpdaterOf reads', async () => {
    // child_process is mocked above for the updater: this needs the real one.
    const cp = await vi.importActual<typeof import('child_process')>('child_process')
    const script = `import('electron-updater').then((m) => {
      const d = Object.getOwnPropertyDescriptor(m.default ?? {}, 'autoUpdater')
      console.log(JSON.stringify(!!d && typeof d.get === 'function'))
    })`
    const out = cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })
    expect(JSON.parse(out)).toBe(true)
  })

  it('autoUpdaterOf takes the default export first, then a named one', async () => {
    const { autoUpdaterOf } = await load()
    const a = {} as never
    expect(autoUpdaterOf({ default: { autoUpdater: a } } as never)).toBe(a)
    expect(autoUpdaterOf({ autoUpdater: a } as never)).toBe(a)
  })
})

describe('developerIdSigned', () => {
  it('recognizes a Developer ID signature only', async () => {
    const { developerIdSigned } = await load()
    expect(developerIdSigned('Authority=Developer ID Application: X (T)\n')).toBe(true)
    expect(developerIdSigned('Signature=adhoc\n')).toBe(false)
    expect(developerIdSigned('code object is not signed at all')).toBe(false)
  })
})
