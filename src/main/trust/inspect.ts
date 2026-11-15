// Inspects a repository's own git settings and the files that redirect where git reads
// (a .git file, commondir, alternates, worktree lists, nested repositories) with plain
// file reads, before any git command runs there: git itself would follow them (and run
// what they name). What git would read but GitDesk cannot check (a file too large or not
// a regular file, a link to another computer, more submodules than it looks at) is a
// finding too: not inspected counts as risky.

import { createHash } from 'crypto'
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync
} from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'path'
import { parseGitConfig, splitKey, type ConfigEntry } from './gitconfig'
import { classifyEntries, isInside, isLfsHook, isNetworkPath, type Finding } from './rules'

/** A file the inspection depends on and how it looked (size, time), to notice changes. */
export interface Stamp {
  path: string
  sig: string
}

export interface Inspection {
  repo: string
  /** null when the .git entry is unusable (git would refuse it too). */
  gitDir: string | null
  commonDir: string | null
  /** The repository's own settings, includes followed, in the order git reads them. */
  entries: ConfigEntry[]
  findings: Finding[]
  /** Identifies the set of findings: trusting a repository remembers it. */
  fingerprint: string
  stamps: Stamp[]
  /** Names of the submodules found (.gitmodules, config, modules/). */
  submoduleNames?: string[]
}

export interface InspectOptions {
  platform?: NodeJS.Platform
  home?: string
}

const MAX_FILE = 1 << 20 // settings files, alternates, .git files (git's own limit for those)
const MAX_HOOK = 64 << 10 // a Git LFS hook is a few hundred bytes
const MAX_INDEX = 64 << 20
const MAX_INCLUDE_DEPTH = 10 // git's own limit
const MAX_ALTERNATE_DEPTH = 5 // git's own limit
const MAX_SUBMODULES = 100
const MAX_SUBMODULE_DEPTH = 6
const MAX_LINKS = 20

/** Size and time of a file; for a folder its time (files added or removed) unless `kindOnly`. */
function signature(path: string, kindOnly = false): string {
  try {
    const s = statSync(path)
    if (kindOnly && s.isDirectory()) return 'd'
    return `${s.isDirectory() ? 'd' : 'f'}:${s.size}:${s.mtimeMs}`
  } catch {
    return '-'
  }
}

/**
 * Whether a path is a link, and its target, without following it (a link may lead to
 * another computer): notices an entry replaced by a link, or a link pointed elsewhere.
 */
function linkSignature(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink() ? `L:${readlinkSync(path)}` : 'L'
  } catch {
    return 'L-'
  }
}

/** The stamps still describe the files on disk. */
export function stampsCurrent(stamps: Stamp[]): boolean {
  return stamps.every(
    (s) =>
      (s.sig.startsWith('L') ? linkSignature(s.path) : signature(s.path, s.sig === 'd')) === s.sig
  )
}

type Read = Buffer | 'missing' | 'unsafe'

/**
 * Opens without waiting (a FIFO would block the main process forever) and keeps only
 * regular files: what `read` returns, or 'unsafe'.
 */
function withRegularFile<T>(
  path: string,
  read: (fd: number, size: number) => T
): T | 'missing' | 'unsafe' {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unsafe'
  }
  try {
    const s = fstatSync(fd)
    return s.isFile() ? read(fd, s.size) : 'unsafe'
  } catch {
    return 'unsafe'
  } finally {
    closeSync(fd)
  }
}

function readBytes(fd: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  let off = 0
  while (off < length) {
    const n = readSync(fd, buf, off, length - off, off)
    if (!n) break
    off += n
  }
  return buf.subarray(0, off)
}

/** A whole regular file of at most `max` bytes. */
function readFileAt(path: string, max: number): Read {
  return withRegularFile(path, (fd, size) => (size > max ? 'unsafe' : readBytes(fd, size)))
}

interface Checks {
  platform: NodeJS.Platform
  /**
   * Reaching `p` would open a path on another computer: a UNC path, or a symbolic link
   * on the way to one. Folders up to `base` (the repository you chose) are not checked.
   */
  remote(p: string): boolean
  /**
   * Where reaching `p` first leads to another computer: the link on the way (its own
   * entry can be looked at without going there), or a network path itself; null if never.
   */
  remoteAt(p: string): string | null
  read(p: string, max: number): Read | 'remote'
}

function pathChecks(platform: NodeJS.Platform, base: string): Checks {
  const memo = new Map<string, boolean>()
  const remote = (p: string, depth = 0): string | null => {
    if (platform !== 'win32') return null
    if (isNetworkPath(p, platform)) return isInside(resolve(p), base) ? null : p
    if (depth > MAX_LINKS) return p
    const abs = resolve(p)
    let cur = isInside(abs, base) ? resolve(base) : parse(abs).root
    for (const part of relative(cur, abs).split(/[\\/]/).filter(Boolean)) {
      cur = join(cur, part)
      const key = cur.toLowerCase()
      let hit = memo.get(key)
      if (hit === undefined) {
        let link: string | null = null
        try {
          if (lstatSync(cur).isSymbolicLink()) link = readlinkSync(cur)
        } catch {
          return null // nothing further down exists
        }
        hit = link !== null && remote(resolve(dirname(cur), link), depth + 1) !== null
        memo.set(key, hit)
      }
      if (hit) return cur
    }
    return null
  }
  return {
    platform,
    remote: (p) => remote(p) !== null,
    remoteAt: (p) => remote(p),
    read: (p, max) => (remote(p) !== null ? 'remote' : readFileAt(p, max))
  }
}

/** git's validate_headref: HEAD names a ref under refs/, or holds a commit id. */
function validHead(path: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) return readlinkSync(path).startsWith('refs/')
  } catch {
    return false
  }
  // git reads the first 255 bytes, whatever the size.
  const head = withRegularFile(path, (fd, size) => readBytes(fd, Math.min(size, 255)))
  if (typeof head === 'string') return false
  const text = head.toString('latin1')
  return /^ref:[ \t\n\r]*refs\//.test(text) || /^[0-9a-f]{40}/i.test(text)
}

/** The common dir of a git dir (its commondir file, like git), or null when unreadable. */
function commonDirOf(gitDir: string, c: Checks): string | 'remote' | null {
  const r = c.read(join(gitDir, 'commondir'), MAX_FILE)
  if (r === 'missing') return gitDir
  if (r === 'remote') return 'remote'
  if (r === 'unsafe') return null
  const line = r.toString('utf8').replace(/[\r\n]+$/, '')
  if (!line) return gitDir
  const dir = resolve(gitDir, line)
  return isNetworkPath(line, c.platform) || c.remote(dir) ? 'remote' : dir
}

/** git's is_git_directory: a valid HEAD, and objects/ and refs/ in its common dir. */
function isGitDirectory(dir: string, c: Checks): 'yes' | 'no' | 'remote' {
  const head = join(dir, 'HEAD')
  if (c.remote(head)) return 'remote'
  if (!validHead(head)) return 'no'
  const common = commonDirOf(dir, c)
  if (common === 'remote') return 'remote'
  if (common === null) return 'no'
  for (const sub of ['objects', 'refs']) {
    const p = join(common, sub)
    if (c.remote(p)) return 'remote'
    try {
      accessSync(p, constants.X_OK)
    } catch {
      return 'no'
    }
  }
  return 'yes'
}

type Found =
  | { kind: 'none' }
  /** gitDir null: git refuses the repository (or GitDesk does: `problem`). */
  | { kind: 'repo'; gitDir: string | null; problem?: Finding }

/**
 * The git dir that `<dir>/.git` gives, as git reads it: a "gitdir: <path>" file, or a
 * folder that is a git dir. 'none' when git would look further (no .git, or a folder
 * that is not a git dir).
 */
function dotGitAt(dir: string, c: Checks): Found {
  const dotGit = join(dir, '.git')
  const remoteData = (value: string): Found => ({
    kind: 'repo',
    gitDir: null,
    problem: {
      key: '.git',
      value,
      file: dotGit,
      effect: 'blocked',
      text: `Keeps its git data on another computer (${value})`
    }
  })
  if (c.remote(dotGit)) return remoteData(dotGit)
  let isFile: boolean
  try {
    isFile = statSync(dotGit).isFile()
  } catch {
    return { kind: 'none' } // missing, or a broken link: git looks further
  }
  if (!isFile) {
    const v = isGitDirectory(dotGit, c)
    if (v === 'remote') return remoteData(dotGit)
    return v === 'yes' ? { kind: 'repo', gitDir: dotGit } : { kind: 'none' }
  }
  // A linked worktree or a submodule. git refuses a bad one (it does not look further).
  const unusable: Found = { kind: 'repo', gitDir: null }
  const r = c.read(dotGit, MAX_FILE)
  if (r === 'remote') return remoteData(dotGit)
  if (typeof r === 'string') return unusable
  const text = r.toString('utf8')
  if (!text.startsWith('gitdir: ')) return unusable
  const path = text.slice(8).replace(/[\r\n]+$/, '')
  if (!path) return unusable
  const target = resolve(dir, path)
  if (isNetworkPath(path, c.platform) || c.remote(target)) return remoteData(path)
  const v = isGitDirectory(target, c)
  if (v === 'remote') return remoteData(path)
  return v === 'yes' ? { kind: 'repo', gitDir: target } : unusable
}

/** The repository git finds in `dir` itself: its .git, or `dir` as a bare repository. */
function gitDirAt(dir: string, c: Checks): Found {
  const found = dotGitAt(dir, c)
  if (found.kind === 'repo') return found
  const bare = isGitDirectory(dir, c)
  if (bare === 'remote')
    return {
      kind: 'repo',
      gitDir: null,
      problem: {
        key: 'commondir',
        value: dir,
        file: join(dir, 'commondir'),
        effect: 'blocked',
        text: 'Keeps its git data on another computer'
      }
    }
  return bare === 'yes' ? { kind: 'repo', gitDir: dir } : { kind: 'none' }
}

/** Where an include.path points, like git: "~/" is your home, relative is next to the file. */
export function includeTarget(value: string, fromFile: string, home: string): string | null {
  // ~user/ and %(prefix)/ are not resolved here: GitDesk cannot check what they name.
  if (!value || value.startsWith('%(prefix)')) return null
  if (value === '~' || value.startsWith('~/')) return join(home, value.slice(1))
  if (value.startsWith('~')) return null
  return isAbsolute(value) || /^[\\/]{2}/.test(value) ? value : resolve(dirname(fromFile), value)
}

/** git's unquote_c_style on bytes: the string and where it ends, or null when malformed. */
export function unquoteC(buf: Buffer, start: number): { bytes: Buffer; end: number } | null {
  if (buf[start] !== 0x22) return null
  const simple: Record<string, number> = {
    a: 7,
    b: 8,
    f: 12,
    n: 10,
    r: 13,
    t: 9,
    v: 11,
    '\\': 0x5c,
    '"': 0x22
  }
  const out: number[] = []
  const octal = (b: number | undefined): boolean => b !== undefined && b >= 0x30 && b <= 0x37
  for (let i = start + 1; i < buf.length;) {
    const ch = buf[i++]
    if (ch === 0x22) return { bytes: Buffer.from(out), end: i }
    if (ch !== 0x5c) {
      out.push(ch)
      continue
    }
    const e = buf[i++]
    if (e === undefined) return null
    const s = simple[String.fromCharCode(e)]
    if (s !== undefined) out.push(s)
    else if (e >= 0x30 && e <= 0x33 && octal(buf[i]) && octal(buf[i + 1])) {
      out.push(((e - 0x30) << 6) | ((buf[i] - 0x30) << 3) | (buf[i + 1] - 0x30))
      i += 2
    } else return null
  }
  return null
}

/**
 * objects/info/alternates, parsed like git: one entry per line, "#" comments, C-quoted
 * entries (after which git skips one character, whatever it is), nothing after a NUL.
 * `undecodable`: a quoted entry git would read some other way.
 */
export function parseAlternates(raw: Buffer): { paths: string[]; undecodable: boolean } {
  const nul = raw.indexOf(0)
  const buf = nul < 0 ? raw : raw.subarray(0, nul)
  const paths: string[] = []
  let undecodable = false
  const lineEnd = (from: number): number => {
    const nl = buf.indexOf(0x0a, from)
    return nl < 0 ? buf.length : nl
  }
  for (let i = 0; i < buf.length;) {
    let entry: Buffer | null = null
    let end: number
    const quoted = buf[i] === 0x22 ? unquoteC(buf, i) : null
    if (buf[i] === 0x23) end = lineEnd(i)
    else if (quoted) {
      entry = quoted.bytes
      end = quoted.end
    } else {
      if (buf[i] === 0x22) undecodable = true
      end = lineEnd(i)
      entry = buf.subarray(i, end)
    }
    if (entry?.length) paths.push(entry.toString('utf8'))
    i = end < buf.length ? end + 1 : buf.length
  }
  return { paths, undecodable }
}

/** git's decode_varint (index v4 path compression). */
function varint(buf: Buffer, at: number): [number, number] | null {
  let i = at
  let c = buf[i++]
  if (c === undefined) return null
  let val = c & 127
  while (c & 128) {
    val += 1
    c = buf[i++]
    if (c === undefined || val > 2 ** 40) return null
    val = val * 128 + (c & 127)
  }
  return [val, i]
}

/**
 * Paths of the submodules (gitlinks) recorded in an index file (versions 2 to 4), or
 * null when it cannot be read. Split-index entries without a name are skipped: their
 * names are in the shared index, read too.
 */
export function indexGitlinks(buf: Buffer, hashLength = 20): string[] | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'DIRC') return null
  const version = buf.readUInt32BE(4)
  if (version < 2 || version > 4) return null
  const count = buf.readUInt32BE(8)
  const links: string[] = []
  let off = 12
  let prev: Buffer = Buffer.alloc(0)
  for (let n = 0; n < count; n++) {
    const start = off
    if (off + 42 + hashLength > buf.length) return null
    const mode = buf.readUInt32BE(off + 24)
    off += 40 + hashLength
    const flags = buf.readUInt16BE(off)
    off += 2
    if (version >= 3 && flags & 0x4000) off += 2
    let path: Buffer
    if (version === 4) {
      const strip = varint(buf, off)
      if (!strip || strip[0] > prev.length) return null
      const nul = buf.indexOf(0, strip[1])
      if (nul < 0) return null
      path = Buffer.concat([prev.subarray(0, prev.length - strip[0]), buf.subarray(strip[1], nul)])
      prev = path
      off = nul + 1
    } else {
      const nul = buf.indexOf(0, off)
      if (nul < 0) return null
      path = buf.subarray(off, nul)
      off = start + ((off - start + path.length + 8) & ~7)
    }
    if ((mode & 0o170000) === 0o160000 && path.length) links.push(path.toString('utf8'))
  }
  return links
}

/** The repository's git settings and risky findings, or null when git finds none there. */
export function inspectRepo(repo: string, opts: InspectOptions = {}): Inspection | null {
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? homedir()
  const c = pathChecks(platform, repo)
  const stamps: Stamp[] = []
  const findings: Finding[] = []
  const stamp = (path: string, kindOnly = false): void => {
    // Never through a link to another computer: the link itself is watched instead.
    const at = c.remoteAt(path)
    if (at === null) stamps.push({ path, sig: signature(path, kindOnly) })
    else if (!isNetworkPath(at, platform)) stampLink(at)
  }
  const stampLink = (path: string): void => {
    stamps.push({ path, sig: linkSignature(path) })
  }
  const remote = (p: string): boolean => c.remote(p)
  const blocked = (key: string, value: string, file: string, text: string): Finding => ({
    key,
    value,
    file,
    effect: 'blocked',
    text
  })
  const cannotCheck = (file: string, why: 'remote' | 'unsafe', what: string): Finding =>
    blocked(
      basename(file),
      file,
      file,
      why === 'remote'
        ? `Reads ${what} from another computer`
        : `Has ${what} GitDesk cannot check (${basename(file)}: too large or not a regular file)`
    )
  const same = (a: string, b: string): boolean =>
    platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : a === b

  // git writes in .git all the time (index, HEAD): only a switch to a .git file matters.
  stamp(join(repo, '.git'), true)
  const found = gitDirAt(repo, c)
  if (found.kind === 'none') return null
  if (found.problem) findings.push(found.problem)
  const gitDir = found.gitDir
  let commonDir: string | null = null
  if (gitDir) {
    stamp(join(gitDir, 'commondir'))
    const common = commonDirOf(gitDir, c)
    commonDir = typeof common === 'string' && common !== 'remote' ? common : null
  }

  /** Reads one config file and the files it includes, like git (every includeIf followed). */
  const readConfig = (file: string, out: ConfigEntry[], into: Finding[], depth = 0): void => {
    stamp(file)
    const r = c.read(file, MAX_FILE)
    if (r === 'missing') return
    if (typeof r === 'string') {
      into.push(cannotCheck(file, r, 'settings'))
      return
    }
    for (const e of parseGitConfig(r.toString('utf8')).entries) {
      out.push({ ...e, file })
      const include = e.key === 'include.path' || /^includeif\..+\.path$/.test(e.key)
      if (!include || !e.value || depth >= MAX_INCLUDE_DEPTH) continue
      const target = includeTarget(e.value, file, home)
      if (!target || isNetworkPath(e.value, platform)) {
        into.push(
          blocked(
            e.key,
            e.value,
            file,
            target
              ? `Reads settings from another computer (${e.value})`
              : `Reads settings from a file GitDesk cannot check (${e.value})`
          )
        )
        continue
      }
      readConfig(target, out, into, depth + 1)
    }
  }

  /**
   * Entries of a git dir that are links (symbolic links, junctions) to another computer:
   * packed-refs, logs/, info/, objects/pack, shallow… git would read them there. The
   * entries checked on their own elsewhere (HEAD, objects/, refs/, config, commondir,
   * hooks/, worktrees/, modules/, the index) are left to those checks. Windows only, like
   * every check for another computer.
   */
  const linksElsewhere = (git: string, common: string): Finding[] => {
    if (platform !== 'win32') return []
    const out: Finding[] = []
    const ownChecks = new Set([
      'head',
      'objects',
      'refs',
      'config',
      'config.worktree',
      'commondir',
      'hooks',
      'worktrees',
      'modules',
      'index'
    ])
    const seen = new Set<string>()
    const look = (dir: string, label: string, top: boolean): void => {
      const k = resolve(dir).toLowerCase()
      if (seen.has(k) || remote(dir)) return // a remote folder itself is reported by its parent
      seen.add(k)
      let names: string[]
      try {
        names = readdirSync(dir).sort()
      } catch {
        return
      }
      for (const name of names) {
        if (top && (ownChecks.has(name.toLowerCase()) || /^sharedindex\./i.test(name))) continue
        const p = join(dir, name)
        // Every top entry is watched (one may become a link); deeper ones only when links.
        const link = lstatSafe(p)?.isSymbolicLink() ?? false
        if (top || link) stampLink(p)
        if (link && remote(p))
          out.push(
            blocked(
              label + name,
              (() => {
                try {
                  return readlinkSync(p)
                } catch {
                  return p
                }
              })(),
              p,
              `Reads part of its git data from another computer (${label + name})`
            )
          )
      }
    }
    for (const dir of new Set([resolve(git), resolve(common)])) {
      look(dir, '', true)
      look(join(dir, 'objects'), 'objects/', false)
      look(join(dir, 'info'), 'info/', false)
    }
    return out
  }

  /** Hook scripts git would run from a hooks folder (not the .sample files, nor Git LFS's). */
  const hooksIn = (dir: string): string[] => {
    stamp(dir)
    if (remote(dir)) return ['a folder on another computer']
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    return names
      .filter((n) => !n.endsWith('.sample'))
      .filter((n) => {
        const file = join(dir, n)
        if (remote(file)) return true
        let size: number
        try {
          const s = statSync(file)
          if (!s.isFile() || (platform !== 'win32' && (s.mode & 0o111) === 0)) return false
          size = s.size
        } catch {
          return false
        }
        if (size > MAX_HOOK) return true
        // Rewriting it in place does not change the folder: watch the file itself.
        stamp(file)
        const r = readFileAt(file, MAX_HOOK)
        return typeof r === 'string' || !isLfsHook(n, r.toString('utf8'))
      })
      .sort()
  }

  /**
   * Settings, hooks and object redirections of one git dir. `submodule`: its label, for a
   * submodule (whose core.worktree may point anywhere inside the repository).
   */
  const inspectGitDir = (
    git: string,
    common: string,
    submodule?: string
  ): { entries: ConfigEntry[]; findings: Finding[] } => {
    const entries: ConfigEntry[] = []
    const found: Finding[] = []
    found.push(...linksElsewhere(git, common))
    readConfig(join(common, 'config'), entries, found)
    // Per-worktree settings (extensions.worktreeConfig); read whenever present.
    readConfig(join(git, 'config.worktree'), entries, found)
    found.push(
      ...classifyEntries(entries, repo, platform).filter((f) => {
        if (f.key !== 'core.worktree' || f.effect !== 'ignored') return true
        // git resolves it from the git dir. Its own folder is where git works anyway;
        // `git submodule add` writes one pointing to the submodule's folder.
        const target = resolve(git, f.value)
        return submodule ? !isInside(target, repo) || same(target, repo) : !same(target, repo)
      })
    )
    if (!entries.some((e) => e.key === 'core.hookspath')) {
      const hooks = hooksIn(join(common, 'hooks'))
      if (hooks.length)
        found.push({
          key: 'hooks',
          value: hooks.join(', '),
          file: join(common, 'hooks'),
          effect: 'ignored',
          text: `Runs hook scripts from .git/hooks (${hooks.join(', ')})`
        })
    }
    // Object stores borrowed from elsewhere (objects/info/alternates, followed like git).
    const walkAlternates = (objects: string, depth: number): void => {
      const file = join(objects, 'info', 'alternates')
      stamp(file)
      const r = c.read(file, MAX_FILE)
      if (r === 'missing') return
      if (typeof r === 'string') {
        found.push(cannotCheck(file, r, 'its history'))
        return
      }
      const { paths, undecodable } = parseAlternates(r)
      if (undecodable)
        found.push(
          blocked(
            'objects/info/alternates',
            '',
            file,
            'Lists a borrowed history GitDesk cannot read'
          )
        )
      for (const target of paths) {
        const abs = resolve(objects, target)
        if (isNetworkPath(target, platform) || remote(abs)) {
          found.push(
            blocked(
              'objects/info/alternates',
              target,
              file,
              `Reads its history from another computer (${target})`
            )
          )
        } else if (depth < MAX_ALTERNATE_DEPTH) walkAlternates(abs, depth + 1)
      }
    }
    walkAlternates(join(common, 'objects'), 0)
    const http = join(common, 'objects', 'info', 'http-alternates')
    stamp(http)
    const h = c.read(http, MAX_FILE)
    if (h !== 'missing' && (typeof h === 'string' || h.toString('utf8').trim()))
      found.push({
        key: 'objects/info/http-alternates',
        value: '',
        file: http,
        effect: 'network',
        text: 'Downloads history from extra web addresses'
      })
    return {
      entries,
      findings: submodule
        ? found.map((f) => ({ ...f, submodule, text: `Submodule ${submodule}: ${f.text}` }))
        : found
    }
  }

  let entries: ConfigEntry[] = []
  const names = new Set<string>()
  if (gitDir && commonDir) {
    const own = inspectGitDir(gitDir, commonDir)
    entries = own.entries
    findings.push(...own.findings)
    for (const e of entries) {
      const { section, sub } = splitKey(e.key)
      if (section === 'submodule' && sub) names.add(sub)
    }

    // Linked worktrees: `git worktree list` and `prune` (and gc) look at each one's path.
    const worktrees = join(commonDir, 'worktrees')
    stamp(worktrees)
    let ids: string[] = []
    if (remote(worktrees)) findings.push(cannotCheck(worktrees, 'remote', 'its worktree list'))
    else
      try {
        ids = readdirSync(worktrees).sort()
      } catch {
        /* none */
      }
    for (const id of ids) {
      const file = join(worktrees, id, 'gitdir')
      stamp(file)
      const r = c.read(file, MAX_FILE)
      if (r === 'missing') continue
      if (typeof r === 'string') {
        findings.push(cannotCheck(file, r, 'a worktree list'))
        continue
      }
      const path = r.toString('utf8').trim()
      if (path && (isNetworkPath(path, platform) || remote(resolve(dirname(file), path))))
        findings.push(
          blocked('worktrees', path, file, `Lists a worktree on another computer (${path})`)
        )
    }

    // Submodules and nested repositories: git runs in them too (status, fetch), with
    // their own settings. Found from the work tree (.gitmodules, gitlinks in the index)
    // and from <common>/modules.
    const visited = new Set<string>()
    const key = (p: string): string =>
      platform === 'win32' ? resolve(p).toLowerCase() : resolve(p)
    let count = 0
    let unchecked = ''
    const hashLength = (list: ConfigEntry[]): number =>
      list.some((e) => e.key === 'extensions.objectformat' && e.value?.toLowerCase() === 'sha256')
        ? 32
        : 20

    /** Paths of the nested repositories git may go into from a work tree. */
    const nestedPaths = (workTree: string, git: string, common: string, hash: number): string[] => {
      const paths = new Set<string>()
      const gitmodules = join(workTree, '.gitmodules')
      stamp(gitmodules)
      const r = c.read(gitmodules, MAX_FILE)
      if (typeof r === 'string' && r !== 'missing') unchecked = 'its .gitmodules file'
      else if (r !== 'missing')
        for (const e of parseGitConfig(r.toString('utf8')).entries) {
          const { section, sub, name } = splitKey(e.key)
          if (section !== 'submodule' || !sub) continue
          names.add(sub)
          if (name === 'path' && e.value) paths.add(e.value)
        }
      const indexes = [join(git, 'index')]
      for (const dir of new Set([git, common]))
        try {
          for (const f of readdirSync(dir))
            if (/^sharedindex\.[0-9a-f]+$/.test(f)) indexes.push(join(dir, f))
        } catch {
          /* no folder */
        }
      for (const file of indexes) {
        stamp(file)
        const ix = c.read(file, MAX_INDEX)
        if (ix === 'missing') continue
        // Every status reads it: one on another computer is not opened at all.
        if (ix === 'remote') {
          findings.push(cannotCheck(file, 'remote', 'its staging area'))
          continue
        }
        const links = typeof ix === 'string' ? null : indexGitlinks(ix, hash)
        if (links) for (const l of links) paths.add(l)
        else unchecked = 'its staging area (index)'
      }
      return [...paths].sort()
    }

    const inspectModule = (
      git: string,
      label: string,
      depth: number,
      workTree: string | null
    ): void => {
      if (visited.has(key(git))) return
      if (count >= MAX_SUBMODULES || depth > MAX_SUBMODULE_DEPTH) {
        unchecked = `more than ${MAX_SUBMODULES} submodules, or nested too deep`
        return
      }
      visited.add(key(git))
      count++
      const common = commonDirOf(git, c)
      if (typeof common !== 'string' || common === 'remote') {
        if (common === 'remote')
          findings.push({
            ...blocked('commondir', git, join(git, 'commondir'), ''),
            submodule: label,
            text: `Submodule ${label}: Keeps its git data on another computer`
          })
        return
      }
      const own = inspectGitDir(git, common, label)
      findings.push(...own.findings)
      if (workTree) walkTree(workTree, git, common, hashLength(own.entries), `${label}/`, depth)
      scanModules(join(common, 'modules'), `${label}/`, depth + 1)
    }

    const walkTree = (
      workTree: string,
      git: string,
      common: string,
      hash: number,
      prefix: string,
      depth: number
    ): void => {
      for (const path of nestedPaths(workTree, git, common, hash)) {
        const at = resolve(workTree, path)
        if (!isInside(at, workTree) || same(at, workTree)) continue // git refuses those
        stamp(join(at, '.git'), true)
        // git goes into <path>/.git only (GIT_DIR=.git), never further up.
        const sub = dotGitAt(at, c)
        if (sub.kind === 'none') continue
        const label = prefix + path
        if (sub.problem)
          findings.push({
            ...sub.problem,
            submodule: label,
            text: `Submodule ${label}: ${sub.problem.text}`
          })
        if (sub.gitDir) inspectModule(sub.gitDir, label, depth + 1, at)
      }
    }

    /** Git dirs kept in a modules/ folder (submodule names may contain slashes). */
    const scanModules = (dir: string, prefix: string, depth: number, name = ''): void => {
      if (remote(dir)) {
        // git goes into the submodules kept there (status, fetch): not on another computer.
        stamp(dir)
        findings.push(cannotCheck(dir, 'remote', 'submodules'))
        return
      }
      stamp(dir)
      let entriesHere: string[]
      try {
        entriesHere = readdirSync(dir).sort()
      } catch {
        return
      }
      for (const entry of entriesHere) {
        const sub = join(dir, entry)
        if (lstatSafe(join(sub, 'HEAD'))) {
          if (!depth) names.add(name + entry)
          inspectModule(sub, prefix + name + entry, depth, null)
        } else if (lstatSafe(sub)?.isDirectory()) {
          if (depth + name.split('/').length > MAX_SUBMODULE_DEPTH * 2) {
            unchecked = `more than ${MAX_SUBMODULES} submodules, or nested too deep`
            return
          }
          scanModules(sub, prefix, depth, `${name}${entry}/`)
        }
      }
    }

    if (gitDir !== repo && !same(gitDir, repo))
      walkTree(repo, gitDir, commonDir, hashLength(entries), '', 0) // not a bare repository
    scanModules(join(commonDir, 'modules'), '', 0)
    if (unchecked)
      findings.push({
        key: 'submodules',
        value: unchecked,
        file: join(commonDir, 'modules'),
        effect: 'ignored',
        text: `Has submodules GitDesk could not check (${unchecked}); git does not go into them`
      })
  }

  return {
    repo,
    gitDir,
    commonDir,
    entries,
    findings,
    fingerprint: fingerprint(findings),
    stamps,
    submoduleNames: [...names].sort()
  }
}

/**
 * The repository a command run in `dir` uses: `dir` or the nearest folder above it where
 * git finds one, with git's own rules (a .git folder must be a real git dir, otherwise
 * git looks further up; a bad .git file stops it).
 */
export function findRepoRoot(
  dir: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const start = resolve(dir)
  const c = pathChecks(platform, start)
  for (let d = start; ;) {
    if (gitDirAt(d, c).kind === 'repo') return d
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

function lstatSafe(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** The same findings give the same fingerprint, whatever their order. */
export function fingerprint(findings: Finding[]): string {
  const lines = [
    ...new Set(findings.map((f) => JSON.stringify([f.effect, f.submodule ?? '', f.key, f.value])))
  ].sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
}
