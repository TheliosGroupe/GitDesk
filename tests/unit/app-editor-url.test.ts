import { describe, expect, it, vi } from 'vitest'

// ipc.ts registers handlers with Electron; only its pure link builder is tested here.
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  net: {},
  safeStorage: { isEncryptionAvailable: () => false },
  session: {},
  shell: {}
}))

const { editorUrl } = await import('../../src/main/ipc')

describe('"Open in editor" links', () => {
  it('Windows: one slash before the drive, forward slashes between folders', () => {
    expect(editorUrl('vscode', 'C:\\dev\\gitdesk', true)).toBe('vscode://file/C:/dev/gitdesk')
    expect(editorUrl('cursor', 'D:\\work\\app\\src\\main.ts', true)).toBe(
      'cursor://file/D:/work/app/src/main.ts'
    )
  })

  it('POSIX: the absolute path follows "file" without a double slash', () => {
    expect(editorUrl('vscode', '/Users/dev/project', false)).toBe('vscode://file/Users/dev/project')
    expect(editorUrl('cursor', '/home/dev/a/b.txt', false)).toBe('cursor://file/home/dev/a/b.txt')
  })

  it('encodes characters that would end or change the path', () => {
    expect(editorUrl('vscode', 'C:\\My Projects\\a#1\\why?.md', true)).toBe(
      'vscode://file/C:/My%20Projects/a%231/why%3F.md'
    )
    expect(editorUrl('vscode', '/srv/100% sure/x&y=z;w', false)).toBe(
      'vscode://file/srv/100%25%20sure/x%26y%3Dz%3Bw'
    )
    expect(editorUrl('vscode', '/home/dev/café/naïve', false)).toBe(
      'vscode://file/home/dev/caf%C3%A9/na%C3%AFve'
    )
  })

  it('keeps a backslash in a POSIX name as part of the name', () => {
    expect(editorUrl('vscode', '/tmp/odd\\name', false)).toBe('vscode://file/tmp/odd%5Cname')
  })

  it('round-trips: decoding the path gives the folder back', () => {
    for (const [target, windows] of [
      ['C:\\Program Files\\x [1]\\%20', true],
      ['/Users/dev/#hash/?query/%41', false]
    ] as const) {
      const url = new URL(editorUrl('vscode', target, windows))
      expect(url.protocol).toBe('vscode:')
      expect(url.host).toBe('file')
      const path = decodeURIComponent(url.pathname)
      expect(windows ? path.slice(1).replace(/\//g, '\\') : path).toBe(target)
    }
  })

  it('Windows network shares keep their two leading slashes', () => {
    expect(editorUrl('vscode', '\\\\server\\share\\repo', true)).toBe(
      'vscode://file//server/share/repo'
    )
  })
})
