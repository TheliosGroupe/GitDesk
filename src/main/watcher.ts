import { createHash } from 'crypto'
import { BrowserWindow } from 'electron'
import { lstat } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import { Worker } from 'worker_threads'
import { REPO_CHANGED_CHANNEL } from '../shared/api'
import { runGit } from './git'
import { parseStatusV2 } from './gitextras/parse'
import { canonicalPath, samePath } from './paths'
import { noteChanged } from './repo'

// Live refresh of the open repositories.
// - The folders are watched in a worker thread: a recursive watch of a big working tree
//   (npm install, a build) delivers thousands of events, which would otherwise keep the
//   main thread, and so every IPC call, busy. The worker drops what never changes the
//   view (node_modules, git's object store and logs, lock files, a folder's own
//   timestamps) and sends the other names in batches, at most every 100 ms.
// - Here, a burst of changes notifies once it has been quiet for QUIET_MS, and at least
//   every MAX_WAIT_MS while it lasts (a dev server writing a log every 200 ms must not
//   hold back a commit made in the terminal).
// - Files git ignores (build output, logs, caches) never notify: one `git check-ignore`
//   per burst sorts them out.
// - A linked worktree (or a repository whose .git folder is elsewhere) has its HEAD,
//   index and refs outside the working tree: those folders are watched too.

export const QUIET_MS = 400
export const MAX_WAIT_MS = 1500
/** More names than this in one burst: compare fingerprints instead of checking each one. */
const MAX_CHECKED = 20_000

/** What the worker watches for one repository (several folders for a linked worktree). */
export interface WatchTarget {
  dir: string
  /** Prepended to the names it reports, so that they read like the working tree's own. */
  prefix: string
  recursive: boolean
  /** Report only these names (direct children). */
  only?: string[]
}

// CommonJS run by `new Worker(source, { eval: true })`, so it needs no bundler entry.
// Messages in: { watch: id, targets } | { add: id, targets } | { unwatch: id }.
// Messages out: { id, names, unknown } (unknown: the system dropped some names) | { id, error }.
export const WORKER_SOURCE = String.raw`
const { parentPort } = require('worker_threads')
const { watch, lstatSync } = require('fs')
const { join } = require('path')
const LIMIT = ${MAX_CHECKED}
const DIRS_LIMIT = 10000
const GIT_NOISE = new Set(['objects', 'logs', 'lfs', 'hooks', 'gk', 'rr-cache', 'FETCH_HEAD',
  'COMMIT_EDITMSG', 'description', 'gc.log', 'gc.pid'])
const repos = new Map()

function isNoise(f) {
  if (f.endsWith('.lock')) return true
  const parts = f.split('/')
  if (parts.includes('node_modules')) return true
  const git = parts.indexOf('.git')
  if (git < 0) return false
  // .git itself only "changes" when its entries do; a nested repository's own files
  if (git > 0 || parts.length === 1) return true
  let i = 1
  if (parts[1] === 'refs') return false
  if (parts[1] === 'worktrees') i = 3 // .git/worktrees/<name>/HEAD
  if (parts[1] === 'modules') return !parts.includes('refs') && parts.some((p) => GIT_NOISE.has(p))
  const top = parts[i]
  return top !== undefined && (GIT_NOISE.has(top) || top.startsWith('fsmonitor'))
}

// Folders seen lately (parents of reported names, lstat results): once a folder is
// deleted it can no longer be told apart, and git matches "dist/" patterns only with the /.
function rememberDir(repo, d) {
  if (repo.dirs.size >= DIRS_LIMIT) repo.dirs.clear()
  repo.dirs.add(d)
}

// Folders are told apart at the end of each batch: the event callbacks stay short, so
// the system's event buffer is read again quickly (on overflow it drops the names).
function flush(repo) {
  repo.timer = null
  const names = new Set()
  for (const f of repo.raw.keys()) {
    if (f.startsWith('.git/')) continue
    for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) rememberDir(repo, f.slice(0, i))
  }
  for (const [f, change] of repo.raw) {
    let dir = false
    if (!f.startsWith('.git/')) {
      try {
        dir = lstatSync(join(repo.root, f)).isDirectory()
        if (dir) rememberDir(repo, f)
        else repo.dirs.delete(f)
      } catch {
        // gone (a deletion or the old name of a rename): a folder if it was one lately
        dir = repo.dirs.delete(f)
      }
    }
    // A folder "changes" when its entries do: those are reported on their own.
    if (dir && change) continue
    names.add(dir ? f + '/' : f)
  }
  repo.raw.clear()
  if (!repo.unknown && !names.size) return
  parentPort.postMessage({ id: repo.id, names: [...names], unknown: repo.unknown })
  repo.unknown = false
}

function onEvent(repo, target, event, name) {
  if (name == null) {
    repo.unknown = true
  } else {
    name = String(name).replace(/\\/g, '/')
    if (target.only && !target.only.includes(name)) return
    const f = target.prefix + name
    if (isNoise(f)) return
    // true while only "change" events were seen for this name
    repo.raw.set(f, event === 'change' && repo.raw.get(f) !== false)
    if (repo.raw.size > LIMIT) {
      repo.unknown = true
      repo.raw.clear()
    }
  }
  if (!repo.timer) repo.timer = setTimeout(flush, 100, repo)
}

function start(repo, target, main) {
  try {
    const w = watch(target.dir, { recursive: target.recursive }, (event, name) =>
      onEvent(repo, target, event, name)
    )
    w.on('error', () => {
      w.close()
      if (main) parentPort.postMessage({ id: repo.id, error: true })
    })
    repo.watchers.push(w)
  } catch {
    if (main) parentPort.postMessage({ id: repo.id, error: true })
  }
}

parentPort.on('message', (m) => {
  if (m.watch !== undefined) {
    const root = m.targets[0].dir
    const repo = { id: m.watch, root, watchers: [], raw: new Map(), dirs: new Set(), unknown: false, timer: null }
    repos.set(m.watch, repo)
    m.targets.forEach((t, i) => start(repo, t, i === 0))
  } else if (m.add !== undefined) {
    const repo = repos.get(m.add)
    if (repo) for (const t of m.targets) start(repo, t, false)
  } else if (m.unwatch !== undefined) {
    const repo = repos.get(m.unwatch)
    if (!repo) return
    repos.delete(m.unwatch)
    if (repo.timer) clearTimeout(repo.timer)
    for (const w of repo.watchers) w.close()
  }
})
`

interface Entry {
  id: number
  repo: string
  /** Names reported since the last notification. */
  pending: Set<string>
  /** The system dropped some names: something may have changed. */
  unknown: boolean
  burstStart: number
  lastEvent: number
  timer: NodeJS.Timeout | null
  /** Bursts are checked one after the other. */
  chain: Promise<void>
  /** viewFingerprint when the last burst with lost names was checked, if nothing notified since. */
  fingerprint: string | null
  closed: boolean
}

const watchers = new Map<string, Entry>()
const byId = new Map<number, Entry>()
let nextId = 1
let worker: Worker | null = null
let restarts = 0

function notify(repo: string): void {
  noteChanged(repo)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(REPO_CHANGED_CHANNEL, repo)
}

function startWorker(): Worker {
  const w = new Worker(WORKER_SOURCE, { eval: true })
  w.unref() // never keeps the app running
  w.on('message', (m: { id: number; names?: string[]; unknown?: boolean; error?: boolean }) => {
    const entry = byId.get(m.id)
    if (!entry) return
    if (m.error) return unwatchRepo(entry.repo)
    collect(entry, m.names ?? [], !!m.unknown)
  })
  // A crashed worker is started again (a few times) and given back the open repositories.
  w.on('error', () => undefined)
  w.on('exit', () => {
    if (worker !== w) return
    worker = null
    if (!watchers.size || restarts++ >= 3) return
    for (const entry of watchers.values()) {
      byId.delete(entry.id)
      entry.id = nextId++
      byId.set(entry.id, entry)
      send({ watch: entry.id, targets: [{ dir: entry.repo, prefix: '', recursive: true }] })
      void watchGitDirs(entry)
    }
  })
  return w
}

function send(message: unknown): void {
  worker ??= startWorker()
  worker.postMessage(message)
}

function collect(entry: Entry, names: string[], unknown: boolean): void {
  for (const n of names) entry.pending.add(n)
  // Too many to check one by one: the end of the burst compares fingerprints instead.
  if (entry.pending.size > MAX_CHECKED) {
    entry.pending.clear()
    unknown = true
  }
  if (unknown) entry.unknown = true
  schedule(entry)
}

/** For tests: as if the worker had reported these names for `repo`. */
export function reported(repo: string, names: string[], unknown = false): void {
  const entry = watchers.get(repo)
  if (entry) collect(entry, names, unknown)
}

function schedule(entry: Entry): void {
  const now = Date.now()
  if (!entry.timer) entry.burstStart = now
  entry.lastEvent = now
  if (entry.timer) clearTimeout(entry.timer)
  const due = Math.min(now + QUIET_MS, entry.burstStart + MAX_WAIT_MS)
  entry.timer = setTimeout(() => tick(entry), Math.max(0, due - now))
}

function tick(entry: Entry): void {
  entry.timer = null
  const now = Date.now()
  const quiet = now - entry.lastEvent >= QUIET_MS - 5
  const names = [...entry.pending]
  entry.pending.clear()
  // Lost names wait for the end of the burst (see viewFingerprint).
  const unknown = entry.unknown && quiet
  if (!quiet) {
    entry.burstStart = now
    if (entry.unknown) {
      entry.timer = setTimeout(() => tick(entry), entry.lastEvent + QUIET_MS - now)
    }
  } else entry.unknown = false
  if (!unknown && !names.length) return
  entry.chain = entry.chain.then(async () => {
    let changed = names.length > 0 && (await mayChangeView(entry.repo, names))
    if (changed) entry.fingerprint = null
    else if (unknown) {
      const before = entry.fingerprint
      entry.fingerprint = await viewFingerprint(entry.repo).catch(() => null)
      changed = !before || entry.fingerprint !== before
    }
    if (changed && !entry.closed) notify(entry.repo)
  })
}

/**
 * What a refresh would read, as a hash: status (with the size and time of each changed
 * file, so a file edited again counts) and refs. When the system dropped names (a storm
 * such as `npm install` or a full rebuild overflows its buffer), the burst notifies only if
 * this changed. Such a burst has nothing to compare with, and so notifies once, when it is
 * the first one of the watch or the first one after any notification triggered by names
 * (in an edit, save, watch-mode build cycle: one refresh per build). Taking a new baseline
 * right after a notification could miss a change made meanwhile, so none is taken.
 */
export async function viewFingerprint(repo: string): Promise<string | null> {
  const [status, refs] = await Promise.all([
    // No ahead/behind walk: refs are hashed through for-each-ref anyway.
    runGit(repo, [
      'status',
      '--porcelain=v2',
      '--branch',
      '--no-ahead-behind',
      '-z',
      '--untracked-files=all'
    ]),
    runGit(repo, ['for-each-ref', '--format=%(objectname) %(refname)'])
  ])
  const { paths } = parseStatusV2(status.stdout)
  if (paths.length > MAX_CHECKED) return null
  const hash = createHash('sha1').update(status.stdout).update('\0').update(refs.stdout)
  for (let i = 0; i < paths.length; i += 256) {
    const stats = await Promise.all(
      paths.slice(i, i + 256).map((p) =>
        lstat(join(repo, p)).then(
          (s) => `${s.size}:${s.mtimeMs}`,
          () => '-'
        )
      )
    )
    hash.update(stats.join('\0'))
  }
  return hash.digest('hex')
}

/**
 * Whether any of these names (relative to the working tree, `/`-separated, folders
 * ending with `/`) can change what GitDesk shows: anything in .git that the worker kept,
 * an ignore file, or a file git does not ignore.
 */
export async function mayChangeView(repo: string, names: string[]): Promise<boolean> {
  const files: string[] = []
  for (const n of names) {
    if (n === '.git' || n.startsWith('.git/')) return true
    if (/(^|\/)\.gitignore$/.test(n)) return true
    files.push(n)
  }
  if (!files.length) return false
  try {
    // Without --no-index, a tracked file stays relevant even where a pattern matches it.
    const r = await runGit(repo, ['check-ignore', '--stdin', '-z'], {
      input: files.join('\0') + '\0',
      okCodes: [0, 1]
    })
    const ignored = new Set(r.stdout.split('\0'))
    return files.some((f) => !ignored.has(f))
  } catch {
    return true // not checkable (a path in a submodule, git refused…): refresh
  }
}

/** Absolute paths to this repository's git folders when they are outside the working tree. */
export async function outsideGitDirs(repo: string): Promise<WatchTarget[]> {
  const r = await runGit(repo, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])
  const [gitDirLine, commonLine] = r.stdout.split(/\r?\n/)
  if (!gitDirLine || !commonLine) return []
  const gitDir = resolve(gitDirLine)
  const common = resolve(repo, commonLine)
  // Never a folder on another computer (git does not run there either).
  const remote = (p: string): boolean => /^[\\/]{2}/.test(p)
  if (remote(gitDir) || remote(common)) return []
  // git names its folders as the file system does (long names, links followed), which
  // may not be how the repository was registered (a short name, /var for /private/var).
  const root = canonicalPath(repo)
  const inside = (p: string): boolean => {
    const rel = relative(root, canonicalPath(p))
    return !rel.startsWith('..') && !isAbsolute(rel)
  }
  if (inside(gitDir)) return []
  const targets: WatchTarget[] = [{ dir: gitDir, prefix: '.git/', recursive: false }]
  if (!samePath(common, gitDir)) {
    targets.push({
      dir: common,
      prefix: '.git/',
      recursive: false,
      only: ['packed-refs', 'config']
    })
  }
  targets.push({ dir: join(common, 'refs'), prefix: '.git/refs/', recursive: true })
  return targets
}

async function watchGitDirs(entry: Entry): Promise<void> {
  const id = entry.id
  const targets = await outsideGitDirs(entry.repo).catch(() => [])
  if (!entry.closed && entry.id === id && targets.length) send({ add: id, targets })
}

export function watchRepo(repo: string): void {
  if (watchers.has(repo)) return
  const entry: Entry = {
    id: nextId++,
    repo,
    pending: new Set(),
    unknown: false,
    burstStart: 0,
    lastEvent: 0,
    timer: null,
    chain: Promise.resolve(),
    fingerprint: null,
    closed: false
  }
  try {
    send({ watch: entry.id, targets: [{ dir: repo, prefix: '', recursive: true }] })
  } catch {
    return // no worker: the UI still refreshes on focus
  }
  watchers.set(repo, entry)
  byId.set(entry.id, entry)
  void watchGitDirs(entry)
}

export function unwatchRepo(repo: string): void {
  const entry = watchers.get(repo)
  if (!entry) return
  entry.closed = true
  if (entry.timer) clearTimeout(entry.timer)
  watchers.delete(repo)
  byId.delete(entry.id)
  worker?.postMessage({ unwatch: entry.id })
}

export function unwatchAll(): void {
  for (const repo of [...watchers.keys()]) unwatchRepo(repo)
  const w = worker
  worker = null
  void w?.terminate()
}
