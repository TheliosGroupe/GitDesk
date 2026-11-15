import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertNotSymlink,
  decodeText,
  isBinary,
  mayRunWhenOpened,
  repoFile
} from '../../src/main/paths'

let work: string
let repo: string
let outside: string

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'gitdesk-paths-'))
  repo = join(work, 'repo')
  outside = join(work, 'outside')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'src'))
  mkdirSync(outside)
  writeFileSync(join(repo, '.git', 'config'), '')
  writeFileSync(join(repo, 'src', 'a.txt'), 'a')
  writeFileSync(join(outside, 'secret.txt'), 's')
  // Junctions need no special rights on Windows; elsewhere they are plain symlinks.
  symlinkSync(outside, join(repo, 'link-out'), 'junction')
  symlinkSync(join(repo, '.git'), join(repo, 'link-git'), 'junction')
})

afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('repoFile', () => {
  it('accepts files of the working copy, existing or new', () => {
    expect(repoFile(repo, 'src/a.txt')).toBe(join(repo, 'src', 'a.txt'))
    expect(repoFile(repo, 'src/new/file.txt')).toBe(join(repo, 'src', 'new', 'file.txt'))
    expect(repoFile(repo, 'foo~bar.txt')).toBe(join(repo, 'foo~bar.txt'))
    expect(repoFile(repo, '.gitignore')).toBe(join(repo, '.gitignore'))
  })

  it('refuses paths that leave the repository', () => {
    for (const p of ['', '../x', 'src/../../x', '/etc/passwd', 'C:/x', 'a\0b', 'a\nb'])
      expect(() => repoFile(repo, p), p).toThrow(/Invalid file path/)
  })

  it('refuses .git, whatever the case', () => {
    for (const p of ['.git/config', '.GIT/config', '.Git'])
      expect(() => repoFile(repo, p), p).toThrow(/Invalid file path/)
  })

  it('refuses symlinks leading out of the repository or into .git', () => {
    expect(() => repoFile(repo, 'link-out/secret.txt')).toThrow(/Invalid file path/)
    expect(() => repoFile(repo, 'link-out/new.txt')).toThrow(/Invalid file path/)
    expect(() => repoFile(repo, 'link-git/config')).toThrow(/Invalid file path/)
  })

  it('lexicalOnly skips the file system checks', () => {
    expect(repoFile(repo, 'link-out/secret.txt', true)).toBe(join(repo, 'link-out', 'secret.txt'))
    expect(() => repoFile(repo, '.git/config', true)).toThrow(/Invalid file path/)
  })

  it.runIf(process.platform === 'win32')('refuses NTFS streams and 8.3 names of .git', () => {
    expect(() => repoFile(repo, '.git::$INDEX_ALLOCATION/config')).toThrow(/Invalid file path/)
    expect(() => repoFile(repo, 'src/a.txt:stream')).toThrow(/Invalid file path/)
    expect(() => repoFile(repo, '.git./config')).toThrow(/Invalid file path/)
    expect(() => repoFile(repo, '.git /config')).toThrow(/Invalid file path/)
    // Only when the volume generates short names.
    if (existsSync(join(repo, 'GIT~1')))
      expect(() => repoFile(repo, 'GIT~1/config')).toThrow(/Invalid file path/)
  })
})

describe('assertNotSymlink', () => {
  it('passes for files and missing files, refuses links', async () => {
    await expect(assertNotSymlink(join(repo, 'src', 'a.txt'))).resolves.toBeUndefined()
    await expect(assertNotSymlink(join(repo, 'missing.txt'))).resolves.toBeUndefined()
    await expect(assertNotSymlink(join(repo, 'link-out'))).rejects.toThrow(/symbolic link/)
  })
})

describe('decodeText', () => {
  const bytes = (...b: number[]): Uint8Array => new Uint8Array(b)

  it('decodes UTF-8 text', () => {
    const text = 'café <<<<<<< ours\n'
    expect(decodeText(new TextEncoder().encode(text))).toEqual({
      content: text,
      binary: false,
      encodingProblem: false
    })
  })

  it('keeps a byte-order mark, so writing the text back keeps it', () => {
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0x61)).content).toBe('\ufeffa')
  })

  it('flags binary content (a NUL in the first 8000 bytes)', () => {
    expect(decodeText(bytes(0x89, 0x50, 0x4e, 0x47, 0, 1))).toEqual({
      content: null,
      binary: true,
      encodingProblem: false
    })
    const late = new Uint8Array(9000).fill(0x61)
    late[8500] = 0
    expect(isBinary(late)).toBe(false)
  })

  it('flags text that is not valid UTF-8 (Latin-1)', () => {
    expect(decodeText(bytes(0x63, 0x61, 0x66, 0xe9))).toEqual({
      content: null,
      binary: false,
      encodingProblem: true
    })
  })
})

describe('mayRunWhenOpened', () => {
  const PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC;.CPL'

  it('flags programs and scripts on every system', () => {
    for (const f of ['run.bat', 'x.CMD', 'a.js', 'b.vbs', 'c.hta', 'd.lnk', 'e.url', 'f.ps1'])
      expect(mayRunWhenOpened(f, 'win32', PATHEXT), f).toBe(true)
    for (const f of ['tool.sh', 'App.app', 'x.desktop', 'y.command'])
      expect(mayRunWhenOpened(f, 'linux', ''), f).toBe(true)
  })

  it('also flags PATHEXT entries and files without an extension on Windows', () => {
    expect(mayRunWhenOpened('x.custom', 'win32', '.CUSTOM;.EXE')).toBe(true)
    expect(mayRunWhenOpened('Makefile', 'win32', PATHEXT)).toBe(true)
    expect(mayRunWhenOpened('Makefile', 'linux', '')).toBe(false)
  })

  it('lets documents open', () => {
    for (const f of ['README.md', 'notes.txt', 'photo.png', 'doc.pdf', 'src/app.ts', 'a.json'])
      expect(mayRunWhenOpened(f, 'win32', PATHEXT), f).toBe(false)
  })
})
