import { join, resolve, sep } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_URL,
  appFilePath,
  externalUrl,
  isAppUrl,
  isTrustedSender,
  navigationAllowed,
  permissionAllowed,
  setAppOrigin
} from '../../src/main/ipcGuard'

type Event = Parameters<typeof isTrustedSender>[0]
const top = { url: APP_URL, parent: null }
const event = (frame: unknown): Event => ({ senderFrame: frame }) as unknown as Event

afterEach(() => setAppOrigin('app://gitdesk'))

describe('isTrustedSender', () => {
  it('accepts the top frame of the app page', () => {
    expect(isTrustedSender(event(top))).toBe(true)
    expect(isTrustedSender(event({ ...top, url: `${APP_URL}#tab` }))).toBe(true)
  })

  it('refuses another page, a subframe, or a frame that is gone', () => {
    expect(isTrustedSender(event({ url: 'file:///C:/repo/page.html', parent: null }))).toBe(false)
    expect(isTrustedSender(event({ url: 'https://example.com/', parent: null }))).toBe(false)
    expect(isTrustedSender(event({ url: 'app://other/index.html', parent: null }))).toBe(false)
    expect(isTrustedSender(event({ url: APP_URL, parent: top }))).toBe(false)
    expect(isTrustedSender(event(null))).toBe(false)
    expect(isTrustedSender(event({ url: '', parent: null }))).toBe(false)
  })

  it('follows the dev server in development', () => {
    setAppOrigin('http://localhost:5173')
    expect(isTrustedSender(event({ url: 'http://localhost:5173/', parent: null }))).toBe(true)
    expect(isTrustedSender(event(top))).toBe(false)
    expect(isTrustedSender(event({ url: 'http://localhost:5174/', parent: null }))).toBe(false)
  })
})

describe('navigation and links', () => {
  it('keeps the window on the app', () => {
    expect(navigationAllowed(APP_URL)).toBe(true)
    expect(navigationAllowed('file:///home/me/repo/readme.html')).toBe(false)
    expect(navigationAllowed('https://github.com/')).toBe(false)
    expect(navigationAllowed('javascript:alert(1)')).toBe(false)
    expect(navigationAllowed('about:blank')).toBe(false)
  })

  it('opens only plain https links outside', () => {
    expect(externalUrl('https://github.com/TheliosGroupe/GitDesk')).toBe(
      'https://github.com/TheliosGroupe/GitDesk'
    )
    expect(externalUrl('http://example.com/')).toBeNull()
    expect(externalUrl('https://user:pw@example.com/')).toBeNull()
    expect(externalUrl('file:///etc/passwd')).toBeNull()
    expect(externalUrl('not a url')).toBeNull()
    expect(externalUrl(`https://example.com/${'a'.repeat(5000)}`)).toBeNull()
  })
})

describe('permissionAllowed', () => {
  it('grants clipboard access to the app page only', () => {
    expect(permissionAllowed('clipboard-sanitized-write', APP_URL)).toBe(true)
    expect(permissionAllowed('clipboard-read', 'app://gitdesk')).toBe(true)
    expect(permissionAllowed('clipboard-read', 'https://example.com')).toBe(false)
    expect(permissionAllowed('clipboard-read', undefined)).toBe(false)
  })

  it('denies everything else', () => {
    for (const p of ['media', 'geolocation', 'notifications', 'midi', 'hid', 'openExternal'])
      expect(permissionAllowed(p, APP_URL)).toBe(false)
  })
})

describe('appFilePath', () => {
  const root = resolve('/bundle/renderer')

  it('maps app:// paths into the bundle', () => {
    expect(appFilePath(root, APP_URL)).toBe(join(root, 'index.html'))
    expect(appFilePath(root, 'app://gitdesk/')).toBe(join(root, 'index.html'))
    expect(appFilePath(root, 'app://gitdesk/assets/index-x.js?v=1')).toBe(
      join(root, 'assets', 'index-x.js')
    )
    expect(appFilePath(root, 'app://gitdesk/assets/a%20b.css')).toBe(
      join(root, 'assets', 'a b.css')
    )
  })

  it('refuses anything outside it', () => {
    for (const url of [
      'app://gitdesk/../secret.txt',
      'app://gitdesk/%2e%2e/secret.txt',
      'app://gitdesk/assets/..%2f..%2fsecret.txt',
      'app://gitdesk/assets/..%5c..%5csecret.txt',
      'app://gitdesk/%00.html',
      'app://gitdesk/%E0%A4%A',
      'app://other/index.html',
      'file:///bundle/renderer/index.html'
    ]) {
      // URL parsing folds plain ".." away; decoded ones must not escape either. (On POSIX a
      // backslash is part of a file name, so that path stays inside the bundle.)
      const file = appFilePath(root, url)
      if (file !== null) expect(file.startsWith(root + sep)).toBe(true)
    }
    expect(appFilePath(root, 'app://gitdesk/%2e%2e/secret.txt')).not.toBe(
      resolve(root, '../secret.txt')
    )
    expect(appFilePath(root, 'app://gitdesk/assets/..%2f..%2fsecret.txt')).toBeNull()
    expect(appFilePath(root, 'app://gitdesk/%00.html')).toBeNull()
    expect(appFilePath(root, 'app://gitdesk/%E0%A4%A')).toBeNull()
    expect(appFilePath(root, 'app://other/index.html')).toBeNull()
    expect(appFilePath(root, 'file:///bundle/renderer/index.html')).toBeNull()
  })
})

describe('isAppUrl', () => {
  it('compares scheme, host and port', () => {
    expect(isAppUrl('app://gitdesk/x')).toBe(true)
    expect(isAppUrl('app://gitdesk.evil/x')).toBe(false)
    expect(isAppUrl('app:gitdesk')).toBe(false)
    expect(isAppUrl(null)).toBe(false)
  })
})
