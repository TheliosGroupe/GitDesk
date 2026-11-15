import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  mayRunWhenOpened,
  openAction,
  repoEntries,
  systemOpenAction,
  type OpenTarget
} from '../../src/main/paths'

const root = mkdtempSync(join(tmpdir(), 'gitdesk-repo-ops-paths-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A folder link: a junction on Windows (no privilege needed), a symlink elsewhere. */
function linkFolder(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

/** A file symlink, or false when the system does not allow creating one (Windows). */
function linkFile(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch {
    return false
  }
}

describe('repoEntries', () => {
  const repo = join(root, 'repo')
  const outside = join(root, 'outside')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(repo, 'src', 'a.txt'), 'a')
  writeFileSync(join(outside, 'secret.txt'), 'outside')
  linkFolder(outside, join(repo, 'linked'))
  linkFolder(join(repo, 'src'), join(repo, 'inner'))

  it('accepts files of the working copy, existing or deleted', () => {
    expect(repoEntries(repo, ['src/a.txt', 'src/gone.txt', 'new/file.txt'])).toEqual([
      'src/a.txt',
      'src/gone.txt',
      'new/file.txt'
    ])
  })

  it('refuses paths that leave the repository or enter .git', () => {
    for (const p of ['../outside/secret.txt', join(outside, 'secret.txt'), '.git/config', ''])
      expect(() => repoEntries(repo, [p]), p).toThrow(/Invalid file path/)
    expect(() => repoEntries(repo, 'src/a.txt')).toThrow(/Invalid file list/)
  })

  it('refuses files reached through a folder link (junction) leading out', () => {
    expect(() => repoEntries(repo, ['linked/secret.txt'])).toThrow(/leads outside the repository/)
    expect(() => repoEntries(repo, ['linked/deleted.txt'])).toThrow(/leads outside the repository/)
    // A link to a folder: git for Windows would walk through it (a junction); git
    // elsewhere acts on the link itself.
    for (const link of ['linked', 'inner']) {
      if (process.platform === 'win32')
        expect(() => repoEntries(repo, [link])).toThrow(/is a link to a folder/)
      else expect(repoEntries(repo, [link])).toEqual([link])
    }
    // One bad path refuses the whole list.
    expect(() => repoEntries(repo, ['src/a.txt', 'linked/secret.txt'])).toThrow()
  })

  it('accepts files under a link that stays inside', () => {
    expect(repoEntries(repo, ['inner/a.txt'])).toEqual(['inner/a.txt'])
  })

  it('accepts a symlink to a file, whatever it points to (git acts on the link)', () => {
    if (!linkFile(join(outside, 'secret.txt'), join(repo, 'src', 'link.txt'))) return
    expect(repoEntries(repo, ['src/link.txt'])).toEqual(['src/link.txt'])
  })
})

describe('mayRunWhenOpened', () => {
  it('flags files that start programs or reach the network when opened', () => {
    for (const f of [
      'a.rdp',
      'b.searchConnector-ms',
      'c.website',
      'd.psc1',
      'e.vsto',
      'f.mht',
      'g.docm',
      'h.xlam',
      'i.accdb',
      'j.webloc',
      'k.inetloc',
      'l.fileloc',
      'm.prefPane',
      'n.mobileconfig',
      'o.flatpakref',
      'p.flatpakrepo',
      'q.jnlp',
      'r.wsb'
    ]) {
      expect(mayRunWhenOpened(f, 'win32', ''), f).toBe(true)
      expect(mayRunWhenOpened(f, 'darwin', ''), f).toBe(true)
      expect(mayRunWhenOpened(f, 'linux', ''), f).toBe(true)
    }
  })
})

describe('openAction', () => {
  const file = (mode = 0o644): OpenTarget => ({ isDirectory: false, isFile: true, mode })
  const dir = { isDirectory: true, isFile: false, mode: 0o755 }

  it('opens known documents and source files', () => {
    for (const f of ['README.md', 'notes.txt', 'photo.PNG', 'doc.pdf', 'src/app.ts', 'a.json'])
      for (const platform of ['win32', 'darwin', 'linux'])
        expect(openAction(f, file(), platform, '.EXE'), `${f} ${platform}`).toBe('open')
  })

  it('reveals programs, and any file type it does not know', () => {
    for (const f of ['run.bat', 'App.exe', 'x.rdp', 'y.webloc', 'z.unknownext', 'w.docx'])
      expect(openAction(f, file(), 'win32', '.EXE;.BAT'), f).toBe('reveal')
  })

  it('reveals executables on macOS and Linux, whatever their name', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(openAction('build/run', file(0o755), platform), platform).toBe('reveal')
      expect(openAction('notes.txt', file(0o744), platform), platform).toBe('reveal')
      expect(openAction('Makefile', file(0o644), platform), platform).toBe('open')
    }
    // Windows has no exec bit: an extensionless file is still revealed there.
    expect(openAction('Makefile', file(0o644), 'win32', '')).toBe('reveal')
  })

  it('reveals folders on macOS (app bundles launch) and folders named like programs', () => {
    expect(openAction('/repos/project', dir, 'darwin')).toBe('reveal')
    expect(openAction('/repos/Tool.app', dir, 'darwin')).toBe('reveal')
    expect(openAction('/repos/Tool.app', dir, 'linux')).toBe('reveal')
    expect(openAction('C:\\repos\\Tool.app', dir, 'win32', '')).toBe('reveal')
    expect(openAction('C:\\repos\\x.{21EC2020-3AEA-1069-A2DD-08002B30309D}', dir, 'win32')).toBe(
      'reveal'
    )
    expect(openAction('/repos/project', dir, 'linux')).toBe('open')
    expect(openAction('C:\\repos\\project', dir, 'win32', '')).toBe('open')
    expect(openAction('C:\\repos\\my.project', dir, 'win32', '')).toBe('open')
  })

  it('reveals what is neither a file nor a folder', () => {
    expect(openAction('fifo', { isDirectory: false, isFile: false, mode: 0 }, 'linux')).toBe(
      'reveal'
    )
  })
})

describe('systemOpenAction', () => {
  const dir = join(root, 'open')
  mkdirSync(join(dir, 'Tool.app'), { recursive: true })
  writeFileSync(join(dir, 'notes.txt'), 'notes')
  writeFileSync(join(dir, 'Shell.terminal'), 'x')

  it('opens a plain document', () => {
    expect(systemOpenAction(join(dir, 'notes.txt'), 'linux')).toBe('open')
  })

  it('judges a link by its target too', () => {
    linkFolder(join(dir, 'Tool.app'), join(dir, 'docs'))
    expect(systemOpenAction(join(dir, 'docs'), 'linux')).toBe('reveal')
    // macOS opens a link by its target's type: a .txt link to a .terminal file runs it.
    if (!linkFile(join(dir, 'Shell.terminal'), join(dir, 'readme.txt'))) return
    expect(systemOpenAction(join(dir, 'readme.txt'), 'darwin')).toBe('reveal')
  })
})
