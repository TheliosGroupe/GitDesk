// canonicalPath, samePath and findSamePath (src/main/paths.ts): one folder under several
// names (a link, a Windows 8.3 short name, another case) is one folder. Everything
// happens in a temp folder.
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalPath,
  findSamePath,
  forgetCanonicalPaths,
  pathKey,
  samePath
} from '../../src/main/paths'

const WINDOWS = process.platform === 'win32'
const root = mkdtempSync(join(tmpdir(), 'gitdesk-paths-canonical-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => forgetCanonicalPaths())

let counter = 0
/** A new folder with a long name (it gets an 8.3 short name where the volume makes them). */
function folder(): string {
  const dir = join(root, `Long Folder Name ${counter++}`)
  mkdirSync(dir)
  return dir
}

/** A link to a folder: a junction on Windows (no special rights needed), a symlink elsewhere. */
function link(target: string): string {
  const at = join(root, `link-${counter++}`)
  symlinkSync(target, at, WINDOWS ? 'junction' : 'dir')
  return at
}

/** The Windows 8.3 short name of a folder, or null (other systems, or none on this volume). */
function shortName(p: string): string | null {
  if (!WINDOWS) return null
  // cmd's own quoting: the whole command line is passed as it is.
  const r = spawnSync('cmd', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true
  })
  const out = r.status === 0 ? r.stdout.trim() : ''
  return out && out.toLowerCase() !== p.toLowerCase() ? out : null
}

describe('canonicalPath', () => {
  it('names a folder as the file system does', () => {
    const dir = folder()
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
    expect(canonicalPath(join(dir, '.'))).toBe(realpathSync.native(dir))
  })

  it('follows links (a junction, /var to /private/var)', () => {
    const dir = folder()
    const alias = link(dir)
    expect(canonicalPath(alias)).toBe(realpathSync.native(dir))
    expect(pathKey(alias)).toBe(pathKey(dir))
  })

  it('keeps what does not exist yet, after the canonical form of the folder above', () => {
    const dir = folder()
    const alias = link(dir)
    expect(canonicalPath(join(alias, 'new', 'file.txt'))).toBe(
      join(realpathSync.native(dir), 'new', 'file.txt')
    )
  })

  it.runIf(WINDOWS)('expands Windows short names (C:\\Users\\RUNNER~1)', (ctx) => {
    const dir = folder()
    const short = shortName(dir)
    if (!short) return ctx.skip() // 8.3 names are turned off on this volume
    expect(canonicalPath(short)).toBe(realpathSync.native(dir))
    expect(canonicalPath(join(short, 'missing'))).toBe(join(realpathSync.native(dir), 'missing'))
    expect(samePath(short, dir)).toBe(true)
  })

  it.runIf(WINDOWS)('leaves a path on another computer alone (no connection)', () => {
    const unc = '\\\\gitdesk-test.invalid\\share\\repo'
    const started = Date.now()
    expect(canonicalPath(unc)).toBe(unc)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('reuses what it found for a few seconds (no system call per comparison)', () => {
    const one = folder()
    const two = folder()
    const alias = link(one)
    expect(canonicalPath(alias)).toBe(realpathSync.native(one))
    rmSync(alias, { recursive: false, force: true })
    symlinkSync(two, alias, WINDOWS ? 'junction' : 'dir')
    expect(canonicalPath(alias)).toBe(realpathSync.native(one))
    forgetCanonicalPaths()
    expect(canonicalPath(alias)).toBe(realpathSync.native(two))
  })
})

describe('samePath', () => {
  it('compares texts first, case-insensitively on Windows', () => {
    const dir = folder()
    expect(samePath(dir, dir)).toBe(true)
    expect(samePath(dir, dir.toUpperCase())).toBe(WINDOWS)
    expect(samePath(dir, folder())).toBe(false)
  })

  it('knows a folder through a link', () => {
    const dir = folder()
    expect(samePath(link(dir), dir)).toBe(true)
    expect(samePath(join(link(dir), 'missing'), join(dir, 'missing'))).toBe(true)
  })

  it('never resolves a relative path (against the current folder)', () => {
    expect(samePath('.', process.cwd())).toBe(false)
    expect(samePath('', process.cwd())).toBe(false)
  })
})

describe('findSamePath', () => {
  it('returns the entry with the same text, else the one naming the same folder', () => {
    const dir = folder()
    const alias = link(dir)
    const other = folder()
    expect(findSamePath([other, dir, alias], alias)).toBe(alias)
    expect(findSamePath([other, dir], alias)).toBe(dir)
    expect(findSamePath([other, alias], realpathSync.native(dir))).toBe(alias)
    expect(findSamePath([other], alias)).toBeUndefined()
    expect(findSamePath([process.cwd()], '.')).toBeUndefined()
  })
})
