// Checks on paths and file contents coming from the UI. No Electron imports, so
// the unit tests can load this module directly.
import { existsSync, promises as fs, lstatSync, realpathSync, statSync, type Stats } from 'fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import type { ConflictFile } from '../shared/types'
import { GitError } from './git'

const WINDOWS = process.platform === 'win32'

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/** First segment of a path relative to its repository, compared case-insensitively. */
function isGitDir(rel: string): boolean {
  return rel.split(/[\\/]/)[0].toLowerCase() === '.git'
}

/**
 * realpath of `full`, or of its nearest existing parent with the rest appended
 * (new files). The native version also expands Windows 8.3 names (GIT~1 -> .git).
 */
function realTarget(full: string): string {
  let existing = full
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return full
    existing = parent
  }
  return join(realpathSync.native(existing), relative(existing, full))
}

// ---------------------------------------------------------------------------
// Canonical paths: the same folder under different names
// ---------------------------------------------------------------------------

// A folder can be named in several ways: by its Windows 8.3 short name (C:\Users\RUNNER~1),
// through a link (macOS's /var is /private/var, a junction), or in another case on Windows.
// git reports the name the file system gives, so GitDesk compares paths in that form.

/** How long a canonical form is reused (a folder rarely turns into a link, or back). */
const CANONICAL_TTL_MS = 10_000
const CANONICAL_MAX = 2000
const canonicalCache = new Map<string, { path: string; at: number }>()

/** \\server\share, //server/share, \\?\UNC\…; not a long local path (\\?\C:\…). */
const isUncLike = (p: string): boolean =>
  /^[\\/]{2}/.test(p) && !/^[\\/]{2}[?.][\\/][A-Za-z]:([\\/]|$)/.test(p)

/** realpath.native, except that a mapped network drive keeps its letter (git keeps it too). */
function nativeReal(p: string): string {
  const real = realpathSync.native(p)
  // Windows names a file on a mapped drive \\server\share\…: the JS version only follows
  // links, so Z:\ stays Z:\ (and does not read as a path on another computer).
  return WINDOWS && isUncLike(real) && !isUncLike(p) ? realpathSync(p) : real
}

function computeCanonical(abs: string): string {
  // Never a path on another computer: resolving it would connect there.
  if (WINDOWS && isUncLike(abs)) return abs
  try {
    return nativeReal(abs)
  } catch {
    /* missing (yet), or not readable: its nearest folder that is */
  }
  const rest: string[] = []
  for (let dir = abs; ;) {
    const parent = dirname(dir)
    if (parent === dir) return abs
    rest.unshift(basename(dir))
    dir = parent
    try {
      return join(nativeReal(dir), ...rest)
    } catch {
      /* further up */
    }
  }
}

/**
 * The absolute path as the file system names it, the way git reports it: links followed
 * (symlinks, junctions, /var -> /private/var), Windows 8.3 short names expanded, names in
 * their case on disk. The part of a path that does not exist (yet) is kept as given,
 * after the canonical form of its nearest existing folder. Never fails; a path on
 * another computer is only made absolute. Cached for a few seconds: registered
 * repositories are compared on every IPC call.
 */
export function canonicalPath(p: string): string {
  const abs = resolve(p)
  const now = Date.now()
  const hit = canonicalCache.get(abs)
  if (hit && now - hit.at < CANONICAL_TTL_MS) return hit.path
  if (canonicalCache.size >= CANONICAL_MAX) canonicalCache.clear()
  const path = computeCanonical(abs)
  canonicalCache.set(abs, { path, at: now })
  return path
}

/** For tests: forgets every cached canonical form. */
export function forgetCanonicalPaths(): void {
  canonicalCache.clear()
}

/** Equal for two paths to the same place: canonical, and lowercase on Windows. */
export function pathKey(p: string): string {
  const c = canonicalPath(p)
  return WINDOWS ? c.toLowerCase() : c
}

/** The text of a path as compared: lowercase on Windows (as its file systems compare names). */
export const textKey = (p: string): string => (WINDOWS ? p.toLowerCase() : p)

/** The same text, case-insensitively on Windows. */
const sameText = (a: string, b: string): boolean => textKey(a) === textKey(b)

/**
 * Whether two paths name the same folder or file: the same text (case-insensitively on
 * Windows) answers without the file system; two absolute paths are also compared in
 * their canonical form (a short name and its long name, a link and its target).
 */
export function samePath(a: string, b: string): boolean {
  if (sameText(a, b)) return true
  return isAbsolute(a) && isAbsolute(b) && pathKey(a) === pathKey(b)
}

/**
 * The entry of `list` that names the same place as `p` (see samePath), or undefined.
 * An entry with the same text wins; only then are canonical forms compared, which costs
 * a file system call per entry: for short lists of paths from elsewhere (git's list of
 * worktrees). Lists of paths GitDesk stored use findStoredPath.
 */
export function findSamePath(list: readonly string[], p: string): string | undefined {
  const text = list.find((x) => sameText(x, p))
  if (text !== undefined || !isAbsolute(p)) return text
  const key = pathKey(p)
  return list.find((x) => isAbsolute(x) && pathKey(x) === key)
}

/**
 * The entry of `list`, paths GitDesk stored, that names the same place as `p`, or
 * undefined. Stored paths are canonical (store.ts writes them so, and converts an older
 * state file once when loading it), so only `p` is put in canonical form: at most one
 * file system call however long the list, and none for an entry with the same text,
 * which wins. Lookups run on the main thread on every tab switch and git command: one
 * call per entry would add up, and freeze the app for a network drive that is offline.
 */
export function findStoredPath(list: readonly string[], p: string): string | undefined {
  const text = list.find((x) => sameText(x, p))
  if (text !== undefined || !isAbsolute(p)) return text
  const key = textKey(canonicalPath(p))
  return list.find((x) => textKey(x) === key)
}

/**
 * Checks that a path from the UI names a file of the working copy and returns its
 * absolute path. The path must be relative, without `..`, and once symlinks and
 * Windows short names are resolved it must stay inside the repository and out of .git.
 * `lexicalOnly` skips the file system: only for paths git reads from its objects or the
 * index, never from the working copy (git for Windows walks through directory junctions
 * there, which is what repoEntries checks).
 */
export function repoFile(repo: string, path: string, lexicalOnly = false): string {
  const invalid = new GitError(`Invalid file path: "${path}"`, null, '')
  if (typeof path !== 'string' || !path || /[\0\r\n]/.test(path)) throw invalid
  const parts = path.split(/[\\/]/)
  if (isAbsolute(path) || /^[a-z]:/i.test(path) || parts.includes('..')) throw invalid
  // Windows: "name:stream" is an NTFS alternate data stream (.git::$INDEX_ALLOCATION).
  if (WINDOWS && path.includes(':')) throw invalid
  // Windows drops trailing dots and spaces (".git." is .git): no real name ends with one.
  if (WINDOWS && parts.some((p) => p !== '.' && /[. ]$/.test(p))) throw invalid
  if (isGitDir(path)) throw invalid
  const full = resolve(repo, path)
  if (!inside(repo, full)) throw invalid
  if (lexicalOnly) return full
  let realRepo: string
  let real: string
  try {
    realRepo = realpathSync.native(repo)
    real = realTarget(full)
  } catch {
    throw invalid
  }
  // path.relative is case-insensitive on Windows, as the file system is.
  if (!inside(realRepo, real) || isGitDir(relative(realRepo, real))) throw invalid
  return full
}

/**
 * Checks paths from the UI that git will read, write or delete in the working copy
 * (stage, discard, conflicts, diffs of untracked files) and returns them unchanged.
 * Like repoFile, the folders on the way must really be inside the repository: git for
 * Windows walks through directory junctions. The last name may be a symlink to a file,
 * since git acts on the link itself, never on its target; on Windows a link to a folder
 * (a junction) is refused.
 */
export function repoEntries(repo: string, paths: unknown): string[] {
  if (!Array.isArray(paths)) throw new GitError('Invalid file list', null, '')
  let realRepo: string
  try {
    realRepo = realpathSync.native(repo)
  } catch {
    throw new GitError(`Invalid repository: "${repo}"`, null, '')
  }
  const realDirs = new Map<string, string>([[resolve(repo), realRepo]])
  const realDir = (dir: string): string => {
    let real = realDirs.get(dir)
    if (real === undefined) {
      real = realTarget(dir)
      realDirs.set(dir, real)
    }
    return real
  }
  for (const path of paths as unknown[]) {
    const full = repoFile(repo, path as string, true)
    const invalid = new GitError(
      `${path} is reached through a folder link that leads outside the repository (or into ` +
        '.git): GitDesk will not stage, discard or diff it.',
      null,
      ''
    )
    let real: string
    try {
      const entry = lstatOrNull(full)
      real = join(realDir(dirname(full)), basename(full))
      if (entry?.isSymbolicLink()) {
        // git for Windows walks through a junction as if it were a folder.
        if (WINDOWS && statOrNull(full)?.isDirectory())
          throw new GitError(
            `${path} is a link to a folder (a junction): GitDesk will not stage, discard or diff it.`,
            null,
            ''
          )
      } else if (entry && dirname(full) === resolve(repo)) {
        real = realpathSync.native(full) // top-level short names (GIT~1 is .git)
      }
    } catch (e) {
      throw e instanceof GitError ? e : invalid
    }
    if (!inside(realRepo, real) || isGitDir(relative(realRepo, real))) throw invalid
  }
  return paths as string[]
}

function lstatOrNull(full: string): Stats | null {
  try {
    return lstatSync(full)
  } catch {
    return null
  }
}

function statOrNull(full: string): Stats | null {
  try {
    return statSync(full)
  } catch {
    return null
  }
}

/** Refuses to write through a symlink (it could point anywhere). */
export async function assertNotSymlink(full: string): Promise<void> {
  try {
    if ((await fs.lstat(full)).isSymbolicLink())
      throw new GitError(`${full} is a symbolic link: GitDesk does not write through it.`, null, '')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/** git's own test: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8000).includes(0)
}

/** Decodes UTF-8 strictly; a byte-order mark is kept so writing the text back keeps it too. */
export function decodeText(data: Uint8Array): ConflictFile {
  if (isBinary(data)) return { content: null, binary: true, encodingProblem: false }
  try {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
    return { content, binary: false, encodingProblem: false }
  } catch {
    return { content: null, binary: false, encodingProblem: true }
  }
}

// Files the system would run rather than show (Windows, macOS and Linux launchers),
// or that make it start a program or reach the network (remote desktop, search
// connectors, location files, installers, macro-enabled Office files).
const RUNNABLE = new Set(
  (
    '.exe .com .bat .cmd .ps1 .psm1 .psd1 .ps1xml .psc1 .vbs .vbe .js .jse .wsf .wsh .wsc .hta ' +
    '.msi .msp .mst .msu .scr .pif .cpl .lnk .url .website .reg .jar .jnlp .gadget .application ' +
    '.appref-ms .vsto .msc .inf .ins .isp .scf .sct .settingcontent-ms .library-ms .search-ms ' +
    '.searchconnector-ms .rdp .wsb .xbap .vb .chm .hlp .mht .mhtml .dll .sys .ocx .cer .crt ' +
    '.diagcab .theme .themepack .appx .msix .msixbundle .appinstaller .xll .xla .xlam .xlsm ' +
    '.xltm .docm .dotm .pptm .potm .ppam .ppsm .sldm .mdb .mde .accdb .accde .ade .adp .iqy .slk ' +
    '.app .command .tool .terminal .workflow .action .pkg .mpkg .dmg .prefpane .mobileconfig ' +
    '.webloc .inetloc .fileloc .sh .bash .zsh .csh .desktop .appimage .run .bin .deb .rpm ' +
    '.flatpakref .flatpakrepo .py .pyw .pyz .pyzw .pyc .pl .rb'
  ).split(' ')
)

/** Whether opening `file` with its default application could run it (from its name alone). */
export function mayRunWhenOpened(
  file: string,
  platform: string = process.platform,
  pathext: string = process.env.PATHEXT ?? ''
): boolean {
  const ext = extname(file).toLowerCase()
  // Windows picks the program from the extension: without one, nothing says it is a document.
  if (!ext) return platform === 'win32'
  if (RUNNABLE.has(ext)) return true
  return platform === 'win32' && pathext.toLowerCase().split(';').includes(ext)
}

// What the "System default app" editor opens: text, source code, images, audio, video, PDF.
// Anything else (and every program) is shown in its folder instead.
const OPENABLE = new Set(
  (
    '.txt .text .md .markdown .mdx .rst .adoc .org .log .csv .tsv .json .jsonc .json5 .yaml .yml ' +
    '.toml .ini .cfg .conf .properties .env .lock .ts .tsx .mts .cts .jsx .css .scss .sass .less ' +
    '.styl .vue .svelte .astro .c .h .cc .cpp .cxx .hpp .hh .hxx .cs .java .kt .kts .scala .go .rs ' +
    '.swift .m .mm .sql .graphql .gql .proto .r .dart .ex .exs .erl .hrl .hs .elm .clj .cljs .tf ' +
    '.hcl .nix .cmake .mk .diff .patch .tex .bib .po .pot .srt .vtt .svg .png .jpg .jpeg .gif .webp .bmp .ico .tif .tiff .avif .heic .pdf .mp3 .wav .ogg .oga .flac .m4a .aac ' +
    '.opus .mp4 .m4v .mov .webm .mkv .avi .ttf .otf .woff .woff2'
  ).split(' ')
)

/** What the file system says about a path to open: a folder, a regular file and its mode. */
export interface OpenTarget {
  isDirectory: boolean
  isFile: boolean
  mode: number
}

// macOS package folders, which Finder and `open` launch or install instead of showing.
const PACKAGE_DIR =
  /\.(app|bundle|framework|plugin|kext|prefpane|qlgenerator|mdimporter|saver|workflow|action|pkg|mpkg|xpc|appex)$/i

/**
 * How to "open" a path with the system: 'open' with its default application, or
 * 'reveal' it in the file manager because opening it could run something. Folders are
 * revealed on macOS (LaunchServices launches application bundles, whatever their name)
 * and when named like a program or a Windows shell folder (name.{CLSID}); files are
 * opened only when they are known documents and, on macOS and Linux, not executable.
 */
export function openAction(
  path: string,
  target: OpenTarget,
  platform: string = process.platform,
  pathext: string = process.env.PATHEXT ?? ''
): 'open' | 'reveal' {
  const name = basename(path)
  if (target.isDirectory) {
    if (platform === 'darwin' || PACKAGE_DIR.test(name)) return 'reveal'
    if (extname(name) && mayRunWhenOpened(name, platform, pathext)) return 'reveal'
    return platform === 'win32' && /\.\{[^}]*\}$/.test(name) ? 'reveal' : 'open'
  }
  if (!target.isFile || mayRunWhenOpened(name, platform, pathext)) return 'reveal'
  // macOS runs an executable in Terminal; Linux file managers may run it too.
  if (platform !== 'win32' && (target.mode & 0o111) !== 0) return 'reveal'
  const ext = extname(name).toLowerCase()
  // An extensionless file or a dotfile (Makefile, .env): plain text off Windows.
  if (!ext) return 'open'
  return OPENABLE.has(ext) ? 'open' : 'reveal'
}

/**
 * openAction for a path on disk. A symlink is judged by its own name and by its target's:
 * macOS opens the target by the target's type (a notes.txt link to a .terminal file runs it).
 */
export function systemOpenAction(
  path: string,
  platform: string = process.platform,
  pathext: string = process.env.PATHEXT ?? ''
): 'open' | 'reveal' {
  const st = statSync(path) // what the system would open, links followed
  const target = { isDirectory: st.isDirectory(), isFile: st.isFile(), mode: st.mode }
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    return 'reveal'
  }
  const names = real === path ? [path] : [path, real]
  return names.some((name) => openAction(name, target, platform, pathext) === 'reveal')
    ? 'reveal'
    : 'open'
}
