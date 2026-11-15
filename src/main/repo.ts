import { createHash } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import type {
  ActivityCommit,
  BlameLine,
  Branch,
  ChangeKind,
  Commit,
  CommitDetails,
  ConflictFile,
  ConflictSide,
  DiffTarget,
  FileChange,
  PullMode,
  RebaseStep,
  RefsInfo,
  RemoteBranch,
  RepoOperation,
  RepoSummary,
  ResetMode,
  Stash,
  Tag,
  WorkingStatus
} from '../shared/types'
import type { KnownSnapshot, LogPage, RepoSnapshot } from '../shared/api'
import {
  assertBranchName,
  assertSafeRef,
  assertSha,
  git,
  GitError,
  runGit,
  type GitAuth
} from './git'
import { parseGitVersion } from './gitextras/parse'
import { parseRemote } from './hosting/remote'
import { assertNotSymlink, decodeText, repoEntries, repoFile } from './paths'
import { assertSafeWorkTree } from './trust/worktree'

export { repoFile }

const DIFF_MAX_BYTES = 4 * 1024 * 1024
/** A conflicted file larger than this is not read: it is taken whole from one side. */
export const CONFLICT_MAX_BYTES = 5 * 1024 * 1024
// Paths from the UI are file names, never pathspec patterns (`*`, `[1]`, `:(glob)`...).
const LITERAL_PATHS = { env: { GIT_LITERAL_PATHSPECS: '1' } }

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function toplevel(dir: string): Promise<string> {
  const out = await git(dir, ['rev-parse', '--show-toplevel'])
  return resolve(out.trim())
}

// Fields of our --format strings end with a NUL byte. Commit messages and names cannot
// hold one (they can hold \x1e or \x1f), so no commit can add or shift a field or a record.
export const LOG_FORMAT = '--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%s%x00'
const LOG_FIELDS = 6
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** A full object id from the UI (a lease or a stash must name exactly one object). */
function assertObjectId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !OBJECT_ID.test(id.toLowerCase()))
    throw new GitError(`Invalid commit id: "${id}"`, null, '')
}

/**
 * Splits the output of a --format whose `count` fields each end with %x00 into records.
 * git ends each record with a newline, found at the start of the next record.
 */
export function splitRecords(out: string, count: number): string[][] {
  const tokens = out.split('\0')
  const records: string[][] = []
  for (let i = 0; i + count <= tokens.length; i += count) {
    const fields = tokens.slice(i, i + count)
    fields[0] = fields[0].replace(/^\r?\n/, '')
    records.push(fields)
  }
  return records
}

/** A LOG_FORMAT record, or null when it is not a well-formed commit. */
function toCommit([sha, parents, author, email, date, subject]: string[]): Commit | null {
  const parentList = parents ? parents.split(' ') : []
  if (!OBJECT_ID.test(sha) || !parentList.every((p) => OBJECT_ID.test(p))) return null
  if (!/^-?\d+$/.test(date)) return null
  return { sha, parents: parentList, author, email, date: Number(date), subject }
}

export function parseLog(out: string): Commit[] {
  return splitRecords(out, LOG_FIELDS)
    .map(toCommit)
    .filter((c): c is Commit => c !== null)
}

function clampLimit(limit: number, max = Infinity): number {
  return Math.min(max, Math.max(1, Math.floor(Number(limit) || 1)))
}

/** `git log` with our format; an empty repository has no commits rather than an error. */
async function logCommits(
  repo: string,
  args: string[],
  opts?: { env?: Record<string, string> }
): Promise<Commit[]> {
  try {
    return parseLog(await git(repo, ['log', LOG_FORMAT, ...args], opts))
  } catch (e) {
    if (e instanceof GitError && /does not have any commits|bad default revision/i.test(e.message))
      return []
    throw e
  }
}

// --exclude must come before --all; stash commits would clutter the graph.
const ALL_BRANCHES = ['--exclude=refs/stash', '--all']

export async function log(repo: string, limit: number): Promise<Commit[]> {
  return logCommits(repo, ['--date-order', ...ALL_BRANCHES, `--max-count=${clampLimit(limit)}`])
}

// ---------------------------------------------------------------------------
// Refs, and the repository view's refresh with as few git processes as possible
// ---------------------------------------------------------------------------

let versionOnce: Promise<[number, number, number] | null> | null = null

/** The version of the git GitDesk runs ([major, minor, patch]), asked once per session. */
export function gitVersion(cwd: string): Promise<[number, number, number] | null> {
  if (!versionOnce) {
    const asked = git(cwd, ['version']).then(parseGitVersion)
    // A failure is not kept: the next caller asks again.
    asked.catch(() => {
      if (versionOnce === asked) versionOnce = null
    })
    versionOnce = asked
  }
  return versionOnce.catch(() => null)
}

/** At least `major.minor`. */
function atLeast(version: [number, number, number] | null, major: number, minor: number): boolean {
  return !!version && (version[0] > major || (version[0] === major && version[1] >= minor))
}

const gitDirs = new Map<string, Promise<string>>()

/** The repository's .git folder (a worktree's own one), resolved once per session. */
export function gitDir(repo: string): Promise<string> {
  let dir = gitDirs.get(repo)
  if (!dir) {
    // The promise is kept, so callers starting together share one `git rev-parse`.
    const started = git(repo, ['rev-parse', '--absolute-git-dir']).then((out) =>
      resolve(out.trim())
    )
    started.catch(() => gitDirs.get(repo) === started && gitDirs.delete(repo))
    gitDirs.set(repo, started)
    dir = started
  }
  return dir
}

/** Where refs, config and the stash of a repository live (the main one's for a worktree). */
async function commonDir(repo: string): Promise<string> {
  const dir = await gitDir(repo)
  try {
    const line = (await fs.readFile(join(dir, 'commondir'), 'utf8')).trim()
    return line ? resolve(dir, line) : dir
  } catch {
    return dir
  }
}

/** Changes whenever the file is written: mtime and size ("-" when it does not exist). */
async function stamp(path: string): Promise<string> {
  try {
    const st = await fs.stat(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return '-'
  }
}

/** A git answer that only changes with the repository's config, read again when it does. */
function cachedByConfig<T>(
  read: (repo: string) => Promise<T>
): ((repo: string) => Promise<T>) & { forget(repo: string): void } {
  const cache = new Map<string, { stamp: string; value: Promise<T> }>()
  const get = async (repo: string): Promise<T> => {
    const now = await stamp(join(await commonDir(repo), 'config'))
    const hit = cache.get(repo)
    if (hit?.stamp === now) return hit.value
    const value = read(repo)
    cache.set(repo, { stamp: now, value })
    value.catch(() => cache.get(repo)?.value === value && cache.delete(repo))
    return value
  }
  return Object.assign(get, { forget: (repo: string) => void cache.delete(repo) })
}

/** The remotes' names, read again only when the config changes. */
export const cachedRemotes = cachedByConfig((repo) => remoteNames(repo))

/** origin's URL (null without one), read again only when the config changes. */
export const originUrl = cachedByConfig(async (repo) => {
  const r = await runGit(repo, ['remote', 'get-url', 'origin'], { okCodes: [0, 2, 128] })
  return r.exitCode === 0 ? r.stdout.trim() || null : null
})

// Every ref (what `log --all` starts from); ref names cannot contain control characters,
// so %1f cannot appear in a field. Upstreams come from upstreamsOf, ahead/behind from trackOf.
const REF_FORMAT = '--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(HEAD)%1f%(symref)'

export interface RefLine {
  refname: string
  sha: string
  peeled: string
  head: boolean
  symref: string
  /** Full ref name of a local branch's upstream ('' without one), and its short name. */
  upstream: string
  upstreamShort: string
}

type Upstreams = Map<string, { full: string; short: string }>

export function parseRefLines(out: string, upstreams: Upstreams = new Map()): RefLine[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [refname, sha, peeled, head, symref] = line.split('\x1f')
      const up = upstreams.get(refname)
      return {
        refname,
        sha,
        peeled,
        head: head === '*',
        symref,
        upstream: up?.full ?? '',
        upstreamShort: up?.short ?? ''
      }
    })
}

/** Each local branch's upstream: set in the config, so read again only when it changes. */
const cachedUpstreams = cachedByConfig(async (repo): Promise<Upstreams> => {
  const out = await git(repo, [
    'for-each-ref',
    '--format=%(refname)%1f%(upstream)%1f%(upstream:short)',
    'refs/heads'
  ])
  const map: Upstreams = new Map()
  for (const line of out.split('\n')) {
    const [refname, full, short] = line.split('\x1f')
    if (refname && full) map.set(refname, { full, short: short || full })
  }
  return map
})

/** The refs as they are now, and keys that change whenever what the view shows may. */
interface RefState {
  lines: RefLine[]
  headSha: string | null
  headBranch: string | null
  /** Refs, HEAD, config (remotes, upstreams), shallow and .mailmap (how the log looks). */
  key: string
  /**
   * The stash ref and its reflog (dropping an older stash only rewrites the reflog), and
   * in a reftable repository the table list, where that reflog lives.
   */
  stashKey: string
}

/**
 * HEAD from its file: "ref: refs/heads/x" or a detached sha. null when git must say
 * (a reftable repository, a symbolic ref outside refs/heads).
 */
export async function readHead(
  repo: string,
  lines: RefLine[]
): Promise<{ sha: string | null; branch: string | null } | null> {
  let text: string
  try {
    text = (await fs.readFile(join(await gitDir(repo), 'HEAD'), 'utf8')).trim()
  } catch {
    return null
  }
  if (OBJECT_ID.test(text)) return { sha: text, branch: null }
  const target = /^ref: (refs\/heads\/\S+)$/.exec(text)?.[1]
  if (!target || target === 'refs/heads/.invalid') return null
  // An unborn branch (new repository) has a name and no commit yet.
  const sha = lines.find((l) => l.refname === target)?.sha ?? null
  return { sha, branch: target.slice('refs/heads/'.length) }
}

async function refState(repo: string): Promise<RefState> {
  const [out, upstreams] = await Promise.all([
    git(repo, ['for-each-ref', REF_FORMAT]),
    cachedUpstreams(repo)
  ])
  const lines = parseRefLines(out, upstreams)
  const common = await commonDir(repo)
  const [head, config, shallow, mailmap, stashLog, reftable] = await Promise.all([
    readHead(repo, lines),
    stamp(join(common, 'config')),
    stamp(join(common, 'shallow')),
    stamp(join(repo, '.mailmap')),
    stamp(join(common, 'logs', 'refs', 'stash')),
    // A reftable repository keeps refs and reflogs (the stash's too) in its tables: any
    // write adds a table, whose new name goes in tables.list (a few short lines, read
    // whole: two writes in a row can leave its size and time alike). '-' otherwise.
    fs.readFile(join(common, 'reftable', 'tables.list'), 'utf8').catch(() => '-')
  ])
  let { sha: headSha, branch: headBranch } = head ?? { sha: null, branch: null }
  if (!head) {
    const [shaOut, branchOut] = await Promise.all([
      runGit(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] }),
      runGit(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [0, 1] })
    ])
    headSha = shaOut.exitCode === 0 ? shaOut.stdout.trim() : null
    headBranch = branchOut.exitCode === 0 ? branchOut.stdout.trim() : null
  }
  // The stash is not in the graph (ALL_BRANCHES): it has its own key.
  const stashSha = lines.find((l) => l.refname === 'refs/stash')?.sha ?? '-'
  const refLines = lines.filter((l) => l.refname !== 'refs/stash')
  const key = createHash('sha1')
    .update(JSON.stringify([refLines, headSha, headBranch, config, shallow, mailmap, reftable]))
    .digest('hex')
  return { lines, headSha, headBranch, key, stashKey: `${stashSha}:${stashLog}:${reftable}` }
}

/** Ahead/behind of a branch, valid while its tip and its upstream's stay where they were. */
interface Track {
  key: string
  ahead: number
  behind: number
  gone: boolean
}
const tracks = new Map<string, Map<string, Track>>()

export function parseTrack(track: string): Omit<Track, 'key'> {
  return {
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
    gone: track === 'gone'
  }
}

/**
 * %(upstream:track) counts the commits on both sides, the slowest part of a refresh when
 * branches track a distant upstream: it only runs for the branches whose tip or upstream
 * moved since the last time.
 */
async function trackOf(repo: string, lines: RefLine[]): Promise<Map<string, Track>> {
  const shas = new Map(lines.map((l) => [l.refname, l.sha]))
  const keyOf = (l: RefLine): string => `${l.sha}:${l.upstream}:${shas.get(l.upstream) ?? ''}`
  const known = tracks.get(repo)
  const next = new Map<string, Track>()
  const missing = new Map<string, RefLine>()
  for (const l of lines) {
    if (!l.refname.startsWith('refs/heads/') || !l.upstream) continue
    const hit = known?.get(l.refname)
    if (hit?.key === keyOf(l)) next.set(l.refname, hit)
    else missing.set(l.refname, l)
  }
  if (missing.size) {
    // A pattern matches a ref or a whole folder of refs; many branches: all of them at once.
    const patterns = missing.size > 50 ? ['refs/heads'] : [...missing.keys()]
    const out = await git(repo, [
      'for-each-ref',
      '--format=%(refname)%1f%(upstream:track,nobracket)',
      ...patterns
    ])
    for (const line of out.split('\n')) {
      const [refname, track = ''] = line.split('\x1f')
      const l = missing.get(refname)
      if (l) next.set(refname, { key: keyOf(l), ...parseTrack(track) })
    }
  }
  tracks.set(repo, next)
  return next
}

async function buildRefs(repo: string, state: RefState): Promise<RefsInfo> {
  const [remotes, track] = await Promise.all([cachedRemotes(repo), trackOf(repo, state.lines)])
  // Longest first, so "upstream/x" is not mistaken for remote "up" + "stream/x".
  const remotesByLength = [...remotes].sort((a, b) => b.length - a.length)

  const branches: Branch[] = []
  const remoteBranches: RemoteBranch[] = []
  const tags: Tag[] = []

  for (const { refname, sha, peeled, upstreamShort, head, symref } of state.lines) {
    if (refname.startsWith('refs/heads/')) {
      const t = track.get(refname)
      branches.push({
        name: refname.slice('refs/heads/'.length),
        sha,
        isHead: head,
        upstream: upstreamShort || null,
        ahead: t?.ahead ?? 0,
        behind: t?.behind ?? 0,
        upstreamGone: t?.gone ?? false
      })
    } else if (refname.startsWith('refs/remotes/')) {
      if (symref) continue // origin/HEAD -> origin/main
      const fullName = refname.slice('refs/remotes/'.length)
      const remote =
        remotesByLength.find((r) => fullName.startsWith(r + '/')) ?? fullName.split('/')[0]
      remoteBranches.push({ remote, name: fullName.slice(remote.length + 1), fullName, sha })
    } else if (refname.startsWith('refs/tags/')) {
      tags.push({ name: refname.slice('refs/tags/'.length), sha: peeled || sha })
    }
  }

  return {
    headSha: state.headSha,
    headBranch: state.headBranch,
    branches,
    remoteBranches,
    tags,
    remotes: [...remotes]
  }
}

export async function refs(repo: string): Promise<RefsInfo> {
  return buildRefs(repo, await refState(repo))
}

/**
 * Everything the repository view shows, in one call. A working-copy change costs two git
 * processes (status, for-each-ref): the log, the stash list, the remotes and the
 * ahead/behind counts are only read again when something they depend on moved since
 * `known` (what the view already has).
 */
export async function snapshot(
  repo: string,
  limit: number,
  known: KnownSnapshot | null
): Promise<RepoSnapshot> {
  const startedAt = Date.now()
  const working = status(repo)
  working.catch(() => undefined) // awaited below: not an unhandled rejection meanwhile
  const state = await refState(repo)
  const logKey = `${state.key}:${clampLimit(limit)}`
  const [refsInfo, commits, stashList, st] = await Promise.all([
    known?.refsKey === state.key ? null : buildRefs(repo, state),
    known?.logKey === logKey ? null : log(repo, limit),
    known?.stashKey === state.stashKey ? null : stashes(repo),
    working
  ])
  lastSnapshots.set(repo, { at: Date.now(), startedAt, refsKey: state.key, status: st })
  return {
    status: st,
    refsKey: state.key,
    logKey,
    stashKey: state.stashKey,
    refs: refsInfo,
    log: commits,
    stashes: stashList
  }
}

const lastSnapshots = new Map<
  string,
  { at: number; startedAt: number; refsKey: string; status: WorkingStatus }
>()
/** When the repository last changed, as far as GitDesk knows (a write, the watcher). */
const changedAt = new Map<string, number>()

/**
 * Something changed in `repo` (a queued write ended, the watcher saw files change): a
 * refresh that started before no longer tells how the repository is.
 */
export function noteChanged(repo: string): void {
  changedAt.set(repo, Date.now())
}

/**
 * The status and ref key of the repository view's last refresh, if at most `maxAgeMs` old
 * and started after the last change GitDesk knows of: other features (conflict warnings,
 * worktrees) can use it instead of running their own.
 */
export function recentSnapshot(
  repo: string,
  maxAgeMs: number
): { refsKey: string; status: WorkingStatus } | null {
  const hit = lastSnapshots.get(repo)
  if (!hit || Date.now() - hit.at > maxAgeMs) return null
  return hit.startedAt > (changedAt.get(repo) ?? 0) ? hit : null
}

/**
 * The next page of the graph ("Load more"): `count` commits after the first `skip`, in the
 * same order as log(). null when a ref moved since `refsKey` (the page would not fit).
 */
export async function logPage(
  repo: string,
  skip: number,
  count: number,
  refsKey: string
): Promise<LogPage | null> {
  const from = Math.max(0, Math.floor(Number(skip) || 0))
  const n = clampLimit(count, 50_000)
  const commits = await logCommits(repo, [
    '--date-order',
    ...ALL_BRANCHES,
    `--skip=${from}`,
    `--max-count=${n}`
  ])
  // Read after the log: refs unchanged since `refsKey` mean the page is of the same history.
  const state = await refState(repo)
  return state.key === refsKey ? { commits, logKey: `${state.key}:${from + n}` } : null
}

/** Forgets what was cached about a repository (removed from GitDesk). */
export function forgetRepo(repo: string): void {
  gitDirs.delete(repo)
  tracks.delete(repo)
  lastSnapshots.delete(repo)
  changedAt.delete(repo)
  cachedRemotes.forget(repo)
  cachedUpstreams.forget(repo)
  originUrl.forget(repo)
}

export async function currentOperation(repo: string): Promise<RepoOperation> {
  const dir = await gitDir(repo)
  // `git am` also uses rebase-apply/, marked by an "applying" file.
  if (existsSync(join(dir, 'rebase-apply', 'applying'))) return 'am'
  if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply')))
    return 'rebase'
  if (existsSync(join(dir, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (existsSync(join(dir, 'REVERT_HEAD'))) return 'revert'
  return null
}

export async function status(repo: string): Promise<WorkingStatus> {
  const [out, operation] = await Promise.all([
    git(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    currentOperation(repo)
  ])
  const result: WorkingStatus = {
    branch: null,
    headSha: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    conflicted: [],
    operation
  }

  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    if (token.startsWith('# ')) {
      const [key, ...rest] = token.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') result.headSha = value === '(initial)' ? null : value
      else if (key === 'branch.head') result.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') result.upstream = value
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(value)
        if (m) {
          result.ahead = Number(m[1])
          result.behind = Number(m[2])
        }
      }
      continue
    }
    const parts = token.split(' ')
    const type = parts[0]
    if (type === '1' || type === '2') {
      const [x, y] = parts[1]
      const path = parts.slice(type === '1' ? 8 : 9).join(' ')
      const origPath = type === '2' ? tokens[++i] : undefined
      if (x !== '.') result.staged.push({ path, origPath, kind: x as ChangeKind })
      if (y !== '.') result.unstaged.push({ path, kind: y as ChangeKind })
    } else if (type === 'u') {
      result.conflicted.push({ path: parts.slice(10).join(' '), kind: 'U' })
    } else if (type === '?') {
      result.unstaged.push({ path: token.slice(2), kind: '?' })
    }
  }
  return result
}

export function parseStashes(out: string): Stash[] {
  return splitRecords(out, 4)
    .filter(([ref, sha]) => /^stash@\{\d+\}$/.test(ref) && OBJECT_ID.test(sha))
    .map(([ref, sha, date, message]) => ({
      ref,
      index: Number(/\{(\d+)\}/.exec(ref)![1]),
      sha,
      date: Number(date) || 0,
      message
    }))
}

export async function stashes(repo: string): Promise<Stash[]> {
  return parseStashes(await git(repo, ['stash', 'list', '--format=%gd%x00%H%x00%at%x00%gs%x00']))
}

function parseNameStatus(out: string): FileChange[] {
  const tokens = out.split('\0').filter((t) => t !== '')
  const files: FileChange[] = []
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]
    const kind = code[0] as ChangeKind
    if (kind === 'R' || kind === 'C') {
      files.push({ kind, origPath: tokens[i + 1], path: tokens[i + 2] })
      i += 2
    } else {
      files.push({ kind, path: tokens[i + 1] })
      i += 1
    }
  }
  return files
}

export async function commitDetails(repo: string, sha: string): Promise<CommitDetails> {
  assertSha(sha)
  const out = await git(repo, [
    'show',
    '-s',
    '--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%cN%x00%ct%x00%s%x00%b',
    sha
  ])
  // The body comes last: it is the rest of the output, whatever it contains.
  const [full, parents, author, email, date, committer, committerDate, subject, ...body] =
    out.split('\0')
  const parentList = parents ? parents.split(' ') : []
  if (!OBJECT_ID.test(full ?? '') || !parentList.every((p) => OBJECT_ID.test(p)))
    throw new GitError(`Cannot read commit ${sha}`, null, '')

  const filesOut =
    parentList.length === 0
      ? await git(repo, [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '-r',
          '-z',
          '-M',
          '--name-status',
          sha
        ])
      : await git(repo, ['diff', '-z', '-M', '--name-status', '--no-ext-diff', parentList[0], sha])

  return {
    sha: full,
    parents: parentList,
    author,
    email,
    date: Number(date),
    committer,
    committerDate: Number(committerDate),
    subject,
    body: body.join('').trim(),
    files: parseNameStatus(filesOut)
  }
}

function pathspec(file: FileChange): string[] {
  return file.origPath ? [file.origPath, file.path] : [file.path]
}

/** A path git reads from commits: any name a commit can hold, but relative and without `..`. */
function assertHistoryPath(path: unknown): void {
  const ok =
    typeof path === 'string' &&
    !!path &&
    !path.includes('\0') &&
    !isAbsolute(path) &&
    !/^[a-z]:/i.test(path) &&
    !path.split(/[\\/]/).includes('..')
  if (!ok) throw new GitError(`Invalid file path: "${path}"`, null, '')
}

/**
 * The file of a diff request from the UI. Commits and the index are read from git's
 * objects, where any name another OS allows (":", a trailing dot, a newline) may appear,
 * so only the path's shape is checked; working-copy paths must be files of the repository.
 */
function diffFile(repo: string, target: DiffTarget): FileChange {
  const file = (target as { file?: unknown } | null)?.file as FileChange | undefined
  if (!file || typeof file !== 'object') throw new GitError('Invalid diff target', null, '')
  const paths =
    file.origPath !== undefined && file.origPath !== null ? [file.path, file.origPath] : [file.path]
  const fromObjects = ['commit', 'compare', 'staged'].includes(target.kind)
  for (const p of paths) {
    if (fromObjects) assertHistoryPath(p)
    else repoFile(repo, p, true)
  }
  return file
}

export async function diff(repo: string, target: DiffTarget): Promise<string> {
  const file = diffFile(repo, target)
  const base = ['--no-color', '--no-ext-diff', '-M']
  let args: string[]
  let okCodes = [0]
  if (target.kind === 'commit') {
    assertSha(target.sha)
    if (target.parent) {
      assertSha(target.parent)
      args = ['diff', ...base, target.parent, target.sha, '--', ...pathspec(file)]
    } else {
      args = ['show', ...base, '--format=', target.sha, '--', ...pathspec(file)]
    }
  } else if (target.kind === 'compare') {
    const [from, to] = await Promise.all([
      resolveCommit(repo, target.from),
      resolveCommit(repo, target.to)
    ])
    const range = target.threeDot ? [`${from}...${to}`] : [from, to]
    args = ['diff', ...base, ...range, '--', ...pathspec(file)]
  } else if (target.kind === 'staged') {
    args = ['diff', '--cached', ...base, '--', ...pathspec(file)]
  } else if (file.kind === '?') {
    // Untracked: show the whole file as added. Exit code 1 means "differences found".
    // --no-index reads any path it is given: it must really be a file of the working copy.
    repoEntries(repo, [file.path])
    args = [
      'diff',
      '--no-index',
      '--no-color',
      '--no-ext-diff',
      '--',
      '/dev/null',
      gitPath(file.path)
    ]
    okCodes = [0, 1]
  } else {
    // Reads the working-copy file: not through a folder link leading out of it.
    repoEntries(repo, [file.path])
    args = ['diff', ...base, '--', file.path]
  }
  const result = await runGit(repo, args, { okCodes, maxBytes: DIFF_MAX_BYTES, ...LITERAL_PATHS })
  return result.truncated
    ? result.stdout + '\n\\ GitDesk: diff truncated (file too large)\n'
    : result.stdout
}

export async function lastCommitMessage(repo: string): Promise<string> {
  const r = await runGit(repo, ['log', '-1', '--format=%B'], { okCodes: [0, 128] })
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

// ---------------------------------------------------------------------------
// Working copy
// ---------------------------------------------------------------------------

async function hasHead(repo: string): Promise<boolean> {
  return (
    (await runGit(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] })).exitCode ===
    0
  )
}

// Paths from the UI that git reads or writes in the working copy are checked with
// repoEntries: the folders on the way must not lead out of it (git for Windows walks
// through directory junctions).

/**
 * Characters of paths per git command. A Windows command line holds at most 32,767
 * characters, GitDesk's own `-c` options included: "Stage all" with thousands of files
 * would otherwise fail (spawn ENAMETOOLONG). Longer lists run in several commands.
 */
const PATHS_PER_COMMAND = 8000

/** `paths` in groups that each fit one command line (see PATHS_PER_COMMAND). */
export function pathBatches(paths: string[], budget = PATHS_PER_COMMAND): string[][] {
  const out: string[][] = []
  let batch: string[] = []
  let size = 0
  for (const p of paths) {
    const n = p.length + 3 // a space and quotes
    if (batch.length && size + n > budget) {
      out.push(batch)
      batch = []
      size = 0
    }
    batch.push(p)
    size += n
  }
  if (batch.length) out.push(batch)
  return out
}

/**
 * Runs `git <args> -- <paths>`. Paths too many for one command line go through stdin
 * (`--pathspec-from-file`, one atomic command) when the command and the git version take
 * it (`fromFile`: add, restore, rm; git 2.26), else in several commands, one after another.
 */
async function forPaths(
  repo: string,
  args: string[],
  paths: string[],
  fromFile = false
): Promise<void> {
  const batches = pathBatches(paths)
  if (batches.length > 1 && fromFile && atLeast(await gitVersion(repo), 2, 26)) {
    await git(repo, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], {
      ...LITERAL_PATHS,
      input: paths.join('\0')
    })
    return
  }
  for (const batch of batches) await git(repo, [...args, '--', ...batch], LITERAL_PATHS)
}

export async function stage(repo: string, paths: string[]): Promise<void> {
  repoEntries(repo, paths)
  await forPaths(repo, ['add', '-A'], paths, true)
}

export async function unstage(repo: string, paths: string[]): Promise<void> {
  repoEntries(repo, paths)
  if (!paths.length) return
  if (await hasHead(repo)) await forPaths(repo, ['restore', '--staged'], paths, true)
  else await forPaths(repo, ['rm', '--cached', '-r', '-q'], paths, true)
}

export async function discard(repo: string, files: FileChange[]): Promise<void> {
  if (!Array.isArray(files)) throw new GitError('Invalid file list', null, '')
  const untracked = files.filter((f) => f?.kind === '?').map((f) => f.path)
  const tracked = files.filter((f) => f?.kind !== '?').map((f) => f?.path)
  repoEntries(repo, [...tracked, ...untracked])
  if (!files.length) return
  await assertSafeWorkTree(repo)
  await forPaths(repo, ['restore', '--worktree'], tracked, true)
  // clean has no --pathspec-from-file: always in batches.
  await forPaths(repo, ['clean', '-f', '-q'], untracked)
}

/** Paths a patch creates, changes or deletes (`git apply --numstat -z`), both names of a rename. */
export function parseNumstatPaths(out: string): string[] {
  const tokens = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]*)$/.exec(tokens[i])
    if (!m) continue
    if (m[1]) paths.push(m[1])
    else {
      paths.push(...tokens.slice(i + 1, i + 3).filter(Boolean))
      i += 2
    }
  }
  return paths
}

export async function applyPatch(
  repo: string,
  patch: string,
  opts: { cached: boolean; reverse: boolean }
): Promise<void> {
  if (typeof patch !== 'string') throw new GitError('Invalid patch', null, '')
  const args = ['apply', '--whitespace=nowarn']
  if (opts?.cached) args.push('--cached')
  if (opts?.reverse) args.push('--reverse')
  // The files it touches, checked like any path from the UI before anything is written.
  const touched = await git(repo, [...args, '--numstat', '-z', '-'], { input: patch })
  repoEntries(repo, parseNumstatPaths(touched))
  if (!opts?.cached) await assertSafeWorkTree(repo)
  await git(repo, [...args, '-'], { input: patch })
}

export async function commit(repo: string, message: string, amend: boolean): Promise<void> {
  // --quiet: no summary diffstat, see WITHOUT_CREDENTIALS in git.ts.
  const args = ['commit', '--quiet']
  if (amend) args.push('--amend')
  if (amend && !message.trim()) args.push('--no-edit')
  else {
    if (!message.trim()) throw new GitError('Write a commit message first.', null, '')
    args.push('-F', '-')
  }
  await git(repo, args, { input: message })
}

// ---------------------------------------------------------------------------
// Branches & history
// ---------------------------------------------------------------------------

async function isLocalBranch(repo: string, name: string): Promise<boolean> {
  const r = await runGit(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], {
    okCodes: [0, 1]
  })
  return r.exitCode === 0
}

export async function checkout(repo: string, ref: string): Promise<void> {
  assertSafeRef(ref)
  if (await isLocalBranch(repo, ref)) await git(repo, ['switch', ref])
  else await git(repo, ['switch', '--detach', ref])
}

export async function checkoutRemote(repo: string, remoteBranch: string): Promise<void> {
  assertSafeRef(remoteBranch)
  const info = await refs(repo)
  const rb = info.remoteBranches.find((b) => b.fullName === remoteBranch)
  if (!rb) throw new GitError(`Remote branch ${remoteBranch} not found`, null, '')
  if (await isLocalBranch(repo, rb.name)) await git(repo, ['switch', rb.name])
  else await git(repo, ['switch', '-c', rb.name, '--track', rb.fullName])
}

export async function createBranch(
  repo: string,
  name: string,
  startPoint: string | null,
  doCheckout: boolean
): Promise<void> {
  await assertBranchName(repo, name)
  if (startPoint) assertSafeRef(startPoint)
  const args = doCheckout ? ['switch', '-c', name] : ['branch', name]
  if (startPoint) args.push(startPoint)
  await git(repo, args)
}

export async function deleteBranch(repo: string, name: string, force: boolean): Promise<void> {
  assertSafeRef(name)
  await git(repo, ['branch', force ? '-D' : '-d', name])
}

export async function renameBranch(repo: string, from: string, to: string): Promise<void> {
  assertSafeRef(from)
  await assertBranchName(repo, to)
  await git(repo, ['branch', '-m', from, to])
}

/**
 * Runs a command that may stop on conflicts (merge, cherry-pick, revert, rebase). When it
 * does, the error says so in GitDesk's terms instead of git's hints about terminal commands.
 */
async function mayConflict(repo: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    const op = await currentOperation(repo).catch(() => null)
    if (!op || !(e instanceof GitError)) throw e
    const unmerged = await git(repo, ['diff', '--name-only', '--diff-filter=U', '-z']).catch(
      () => ''
    )
    const files = unmerged.split('\0').filter(Boolean).length
    if (!files) throw e
    throw new GitError(
      `The ${op} stopped on conflicts in ${files} file${files > 1 ? 's' : ''}: ` +
        'resolve them in the working copy, then Continue (or Abort).',
      e.exitCode,
      e.stderr
    )
  }
}

export async function merge(repo: string, ref: string): Promise<void> {
  assertSafeRef(ref)
  await mayConflict(repo, () => git(repo, ['merge', '--no-edit', ref]))
}

export async function abortOperation(repo: string): Promise<void> {
  const op = await currentOperation(repo)
  if (op) await git(repo, [op, '--abort'])
  await cleanupRebaseFiles(repo)
}

export async function continueOperation(repo: string): Promise<void> {
  const op = await currentOperation(repo)
  try {
    // GIT_EDITOR=true (git.ts) keeps git's prepared message instead of opening an editor.
    // --cleanup=strip drops its "# Conflicts:" comment lines, as an editor session would.
    if (op === 'merge') await git(repo, ['commit', '--quiet', '--no-edit', '--cleanup=strip'])
    else if (op) await mayConflict(repo, () => git(repo, [op, '--continue']))
  } finally {
    await cleanupRebaseFiles(repo)
  }
}

async function parentCount(repo: string, sha: string): Promise<number> {
  const out = await git(repo, ['rev-list', '--parents', '-n', '1', sha])
  return out.trim().split(' ').length - 1
}

export async function cherryPick(repo: string, sha: string): Promise<void> {
  assertSha(sha)
  const mainline = (await parentCount(repo, sha)) > 1 ? ['-m', '1'] : []
  await mayConflict(repo, () => git(repo, ['cherry-pick', ...mainline, sha]))
}

export async function revert(repo: string, sha: string): Promise<void> {
  assertSha(sha)
  const mainline = (await parentCount(repo, sha)) > 1 ? ['-m', '1'] : []
  await mayConflict(repo, () => git(repo, ['revert', '--no-edit', ...mainline, sha]))
}

export async function reset(repo: string, sha: string, mode: ResetMode): Promise<void> {
  assertSha(sha)
  if (!['soft', 'mixed', 'hard'].includes(mode))
    throw new GitError(`Invalid reset mode ${mode}`, null, '')
  if (mode === 'hard') await assertSafeWorkTree(repo)
  await git(repo, ['reset', `--${mode}`, sha])
}

export async function createTag(repo: string, name: string, sha: string): Promise<void> {
  assertSafeRef(name)
  assertSha(sha)
  await git(repo, ['tag', name, sha])
}

export async function deleteTag(repo: string, name: string): Promise<void> {
  assertSafeRef(name)
  await git(repo, ['tag', '-d', name])
}

// ---------------------------------------------------------------------------
// Remotes & stashes
// ---------------------------------------------------------------------------

// Settings that say whether and how commit-graphs are kept: when one is set, the user
// decides and the fetch follows their config.
const COMMIT_GRAPH_KEYS =
  '^(fetch\\.writecommitgraph|core\\.commitgraph|gc\\.writecommitgraph|maintenance\\.commit-graph\\.enabled)$'

/** How git reads a boolean ("key" alone is true; "key =" and false/no/off/0 are false). */
function configTrue(value: string | undefined): boolean {
  if (value === undefined) return true
  return !/^(?:false|no|off|0|)$/i.test(value.trim())
}

/**
 * What the user's config (at any level) says about commit-graphs: 'unset' when none of
 * COMMIT_GRAPH_KEYS is set, 'off' when one of them turns them off, else 'on'.
 */
export async function commitGraphConfig(repo: string): Promise<'unset' | 'on' | 'off'> {
  // Not cached: the global and system config count too, and they have no stamp here. It is
  // one local process before a network fetch (or after a clone).
  const r = await runGit(repo, ['config', '-z', '--get-regexp', COMMIT_GRAPH_KEYS], {
    okCodes: [0, 1]
  })
  if (r.exitCode === 1) return 'unset'
  // -z: "key\nvalue\0" per entry, "key\0" for a key without a value.
  const off = r.stdout
    .split('\0')
    .filter(Boolean)
    .some((entry) => {
      const nl = entry.indexOf('\n')
      return !configTrue(nl === -1 ? undefined : entry.slice(nl + 1))
    })
  return off ? 'off' : 'on'
}

/** --write-commit-graph, unless the user's config (at any level) already decides it. */
export async function commitGraphFlag(repo: string): Promise<string[]> {
  return (await commitGraphConfig(repo)) === 'unset' ? ['--write-commit-graph'] : []
}

/**
 * `git fetch --all --prune`. `graphFlag`: commitGraphFlag(repo), when the caller already
 * read it (sync.ts reads it before waiting for its turn).
 */
export async function fetchAll(repo: string, graphFlag?: string[]): Promise<void> {
  // A commit-graph makes the graph's `log --date-order --all` several times faster: without
  // one, git reads every commit of the history before it can sort the first page.
  const flag = graphFlag ?? (await commitGraphFlag(repo))
  await git(repo, ['fetch', '--all', '--prune', ...flag])
}

export async function pull(repo: string, mode: PullMode): Promise<void> {
  const flag = { 'ff-only': '--ff-only', merge: '--no-rebase', rebase: '--rebase' }[mode]
  if (!flag) throw new GitError(`Invalid pull mode ${mode}`, null, '')
  await mayConflict(repo, () =>
    git(repo, ['pull', flag, ...(mode === 'merge' ? ['--no-edit'] : [])])
  )
}

interface PushTarget {
  remote: string
  /** The branch (or review ref) on the remote. */
  ref: string
  /** Our copy of that remote branch, refs/remotes/..., when there is one. */
  tracking: string
  /** No upstream yet: the push sets it. */
  setUpstream: boolean
}

/**
 * Where `git push` would send `branch`, from the user's settings: the push remote
 * (branch.<b>.pushRemote, remote.pushDefault, else the upstream's remote) and the remote
 * ref (a remote.<name>.push mapping, the upstream's name in a central workflow, else the
 * same name). A branch with no remote at all goes to origin (or the only remote), with -u.
 */
async function pushTarget(repo: string, branch: string): Promise<PushTarget> {
  const [out, mode] = await Promise.all([
    git(repo, [
      'for-each-ref',
      '--format=%(push:remotename)%00%(push:remoteref)%00%(push)%00' +
        '%(upstream:remotename)%00%(upstream:remoteref)',
      `refs/heads/${branch}`
    ]),
    runGit(repo, ['config', '--get', 'push.default'], { okCodes: [0, 1] })
  ])
  const [pushRemote, pushRef, tracking, upRemote, upRef] = out.replace(/\r?\n$/, '').split('\0')
  // "." is an upstream in this repository itself, not something to push to.
  const hasUpstream = !!upRemote && upRemote !== '.' && !!upRef?.startsWith('refs/')
  let remote = pushRemote && pushRemote !== '.' ? pushRemote : hasUpstream ? upRemote : ''
  if (!remote) {
    const remotes = await remoteNames(repo)
    if (!remotes.length) throw new GitError('This repository has no remote to push to.', null, '')
    remote = remotes.includes('origin') ? 'origin' : remotes[0]
  }
  const sameName = `refs/heads/${branch}`
  const central = hasUpstream && remote === upRemote
  const ref = pushRef?.startsWith('refs/')
    ? pushRef // a remote.<name>.push mapping wins, as in git
    : refByPushDefault(mode.stdout.trim() || 'simple', branch, remote, central, upRef, sameName)
  // git leaves %(push) empty when it would not push there by name (triangular "simple").
  const copy = ref.startsWith('refs/heads/')
    ? `refs/remotes/${remote}/${ref.slice('refs/heads/'.length)}`
    : ''
  return {
    remote,
    ref,
    tracking: tracking?.startsWith('refs/remotes/') ? tracking : copy,
    // Only a branch with no upstream at all gets one ("." is a local upstream: kept).
    setUpstream: !upRemote
  }
}

/**
 * The remote branch `git push` updates, by push.default, when no remote.<name>.push
 * mapping applies. `central`: pushing to the remote of the branch's upstream. Refuses
 * where git refuses: a "simple" push never updates a branch of another name.
 */
function refByPushDefault(
  mode: string,
  branch: string,
  remote: string,
  central: boolean,
  upRef: string,
  sameName: string
): string {
  if (mode === 'nothing')
    throw new GitError(
      'push.default is "nothing": git pushes no branch unless told which.',
      null,
      ''
    )
  if (mode === 'upstream' || mode === 'tracking') {
    if (!central && upRef)
      throw new GitError(
        `You are pushing to ${remote}, which is not the remote of ${branch}'s upstream ` +
          '(push.default is "upstream"): push from the terminal, naming the branch to update.',
        null,
        ''
      )
    return central ? upRef : sameName
  }
  if (mode === 'simple' && central && upRef !== sameName) {
    const other = upRef.slice('refs/heads/'.length)
    throw new GitError(
      `${branch} tracks ${remote}/${other}, which has another name, so git does not push it ` +
        `there. To publish it as its own branch, run \`git push -u ${remote} ${branch}\` in ` +
        `the terminal; to update ${other}, run \`git push ${remote} HEAD:${other}\`, or set ` +
        'push.default to "upstream".',
      null,
      ''
    )
  }
  // "simple" (same name, or another remote), "current", "matching" (only this branch).
  return sameName
}

/**
 * Pushes the current branch, and only it, where `git push` would (see pushTarget): an
 * explicit refspec, so push.default=matching or a wildcard remote.<name>.push cannot push
 * other branches. A force push is leased on what the user saw: `seen` maps the remote
 * branches the UI showed (origin/main) to their sha, and the push is refused when the
 * target holds anything else (or exists while it was not shown). Without `seen`, it is
 * refused when the remote has commits this branch never had (--force-if-includes): a
 * background fetch must not make the lease pass.
 */
export async function push(
  repo: string,
  force: boolean,
  seen?: Record<string, string>
): Promise<void> {
  const st = await status(repo)
  if (!st.branch)
    throw new GitError('HEAD is detached: check out a branch before pushing.', null, '')
  assertSafeRef(st.branch)
  if (seen !== undefined && seen !== null && (typeof seen !== 'object' || Array.isArray(seen)))
    throw new GitError('Invalid remote branch list', null, '')
  const target = await pushTarget(repo, st.branch)
  let lease: string[] = []
  if (force && seen) {
    const shown = target.tracking.slice('refs/remotes/'.length)
    const expected = target.tracking && Object.hasOwn(seen, shown) ? seen[shown] : ''
    if (expected) assertObjectId(expected)
    lease = [`--force-with-lease=${target.ref}:${expected}`]
  } else if (force) lease = [`--force-with-lease=${target.ref}`, '--force-if-includes']
  const upstream = target.setUpstream ? ['-u'] : []
  const refspec = `refs/heads/${st.branch}:${target.ref}`
  try {
    await git(repo, ['push', ...lease, ...upstream, '--', target.remote, refspec])
  } catch (e) {
    // Only the lease's own refusals (a hook or a protected branch says something else).
    if (
      force &&
      e instanceof GitError &&
      /\((stale info|remote ref updated since checkout)\)/i.test(e.message)
    )
      throw new GitError(
        'The remote branch changed since you last saw it: fetch and look at it before force pushing.',
        e.exitCode,
        e.stderr
      )
    throw e
  }
}

export async function stash(repo: string, message: string): Promise<void> {
  const args = ['stash', 'push', '--include-untracked']
  const text = typeof message === 'string' ? message.trim() : ''
  if (text) args.push('-m', text)
  await assertSafeWorkTree(repo)
  await git(repo, args)
}

/**
 * `stash@{n}` of the stash the UI listed. Stashes are shared by every worktree, so the
 * list may have moved since (a stash pushed or dropped elsewhere): `sha` finds it again,
 * and when it is gone nothing is done.
 */
async function stashRef(repo: string, index: number, sha: string | undefined): Promise<string> {
  const n = Math.floor(Number(index))
  if (!Number.isInteger(n) || n < 0) throw new GitError(`Invalid stash index ${index}`, null, '')
  if (sha === undefined || sha === null) return `stash@{${n}}`
  assertObjectId(sha)
  const listed = (await stashes(repo)).find((s) => s.sha === sha.toLowerCase())
  if (!listed) throw new GitError('This stash no longer exists: the list has changed.', null, '')
  return listed.ref
}

export async function stashApply(
  repo: string,
  index: number,
  drop: boolean,
  sha?: string
): Promise<void> {
  const ref = await stashRef(repo, index, sha)
  await assertSafeWorkTree(repo)
  await git(repo, ['stash', drop ? 'pop' : 'apply', ref])
}

export async function stashDrop(repo: string, index: number, sha?: string): Promise<void> {
  await git(repo, ['stash', 'drop', await stashRef(repo, index, sha)])
}

// ---------------------------------------------------------------------------
// Tags & branches on the remote
// ---------------------------------------------------------------------------

async function remoteNames(repo: string): Promise<string[]> {
  return (await git(repo, ['remote']))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** `origin`, or the only remote. */
async function defaultRemote(repo: string): Promise<string> {
  const remotes = await remoteNames(repo)
  if (remotes.includes('origin')) return 'origin'
  if (remotes.length === 1) return remotes[0]
  if (!remotes.length) throw new GitError('This repository has no remote.', null, '')
  throw new GitError('This repository has several remotes and none is called "origin".', null, '')
}

export async function pushTag(repo: string, name: string): Promise<void> {
  assertSafeRef(name)
  const exists = await runGit(repo, ['show-ref', '--verify', '--quiet', `refs/tags/${name}`], {
    okCodes: [0, 1]
  })
  if (exists.exitCode !== 0) throw new GitError(`Tag ${name} not found`, null, '')
  await git(repo, ['push', await defaultRemote(repo), `refs/tags/${name}`])
}

export async function deleteRemoteTag(repo: string, name: string): Promise<void> {
  assertSafeRef(name)
  await git(repo, ['push', await defaultRemote(repo), '--delete', `refs/tags/${name}`])
}

/**
 * "origin/feature/x" -> remote "origin", branch "feature/x" (remote names may contain "/").
 * Leased on `expected`, the sha the user saw (by default our copy of the branch as of the
 * last fetch): commits pushed there since are not deleted along with it.
 */
export async function deleteRemoteBranch(
  repo: string,
  fullName: string,
  expected?: string
): Promise<void> {
  assertSafeRef(fullName)
  // Longest first, so "upstream/x" is not mistaken for remote "up" + "stream/x".
  const remotes = (await remoteNames(repo)).sort((a, b) => b.length - a.length)
  const remote = remotes.find((r) => fullName.startsWith(r + '/'))
  if (!remote) throw new GitError(`No remote matches ${fullName}`, null, '')
  const branch = fullName.slice(remote.length + 1)
  assertSafeRef(branch)
  const ref = `refs/heads/${branch}`
  let sha = expected
  if (sha === undefined || sha === null) sha = await resolveCommit(repo, `refs/remotes/${fullName}`)
  else assertObjectId(sha)
  try {
    await git(repo, ['push', `--force-with-lease=${ref}:${sha}`, '--', remote, `:${ref}`])
    return
  } catch (e) {
    if (!(e instanceof GitError)) throw e
    if (/stale info/i.test(e.message)) {
      // The lease failed: the branch moved on the remote, or is already gone.
      if ((await git(repo, ['ls-remote', '--', remote, ref])).trim())
        throw new GitError(
          `${fullName} has new commits on the remote since your last fetch: fetch and look at them first.`,
          e.exitCode,
          e.stderr
        )
    } else if (!/remote ref does not exist/i.test(e.message)) throw e
  }
  // Already deleted on the remote: just forget our stale copy of it.
  await git(repo, ['branch', '-d', '-r', fullName])
}

// ---------------------------------------------------------------------------
// Search, file history, blame
// ---------------------------------------------------------------------------

/** The path as git prints it (forward slashes). */
function gitPath(path: string): string {
  return path.replace(/\\/g, '/')
}

const SEARCH_FIELDS = ['all', 'message', 'author', 'sha']

/** Commits on any branch whose sha starts with `prefix` (4+ hex digits). */
async function commitsWithPrefix(repo: string, prefix: string, limit: number): Promise<Commit[]> {
  if (!/^[0-9a-f]{4,64}$/i.test(prefix)) return []
  const p = prefix.toLowerCase()
  const r = await runGit(repo, ['rev-list', ...ALL_BRANCHES], { okCodes: [0, 128] })
  const shas = r.stdout
    .split('\n')
    .filter((s) => s.startsWith(p))
    .slice(0, limit)
  if (!shas.length) return []
  // Through stdin: a long list of shas would overflow the Windows command line.
  const out = await git(repo, ['log', LOG_FORMAT, '--no-walk', '--stdin'], {
    input: shas.join('\n') + '\n'
  })
  return parseLog(out)
}

/** Commits on any branch matching `query` (case-insensitive, literal text), newest first. */
export async function searchCommits(
  repo: string,
  query: string,
  field: string,
  limit: number
): Promise<Commit[]> {
  if (!SEARCH_FIELDS.includes(field)) throw new GitError(`Invalid search field ${field}`, null, '')
  const q = typeof query === 'string' ? query.trim() : ''
  if (!q || /[\0\r\n]/.test(q)) return []
  const n = clampLimit(limit, 2000)
  const base = [...ALL_BRANCHES, `--max-count=${n}`, '--regexp-ignore-case', '--fixed-strings']

  const searches: Promise<Commit[]>[] = []
  if (field === 'message' || field === 'all')
    searches.push(logCommits(repo, [...base, `--grep=${q}`]))
  // --author matches the name or the email.
  if (field === 'author' || field === 'all')
    searches.push(logCommits(repo, [...base, `--author=${q}`]))
  if (field === 'sha' || field === 'all') searches.push(commitsWithPrefix(repo, q, n))

  const seen = new Set<string>()
  return (await Promise.all(searches))
    .flat()
    .filter((c) => !seen.has(c.sha) && seen.add(c.sha))
    .sort((a, b) => b.date - a.date)
    .slice(0, n)
}

/** Commits that changed `path`, following renames, newest first. */
export async function fileHistory(repo: string, path: string, limit: number): Promise<Commit[]> {
  repoFile(repo, path, true)
  const args = ['--follow', `--max-count=${clampLimit(limit)}`, '--', gitPath(path)]
  return logCommits(repo, args, LITERAL_PATHS)
}

const ZERO_ID = /^0+$/

type BlameCommit = Omit<BlameLine, 'line' | 'sha' | 'text'>

/** Parses `git blame --porcelain`: commit details are only printed the first time a commit appears. */
export function parseBlame(out: string): BlameLine[] {
  const commits = new Map<string, BlameCommit>()
  const lines: BlameLine[] = []
  let current: { sha: string; line: number } | null = null
  for (const raw of out.split('\n')) {
    if (raw.startsWith('\t')) {
      if (!current) continue
      const info = commits.get(current.sha)!
      lines.push({ ...info, ...current, text: raw.slice(1).replace(/\r$/, '') })
      current = null
      continue
    }
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(raw)
    if (header) {
      current = { sha: header[1], line: Number(header[2]) }
      if (!commits.has(current.sha)) {
        // Lines changed in the working copy belong to sha 0000…
        const author = ZERO_ID.test(current.sha) ? 'Not committed yet' : ''
        commits.set(current.sha, { author, email: '', date: 0, summary: '' })
      }
      continue
    }
    if (!current) continue
    const info = commits.get(current.sha)!
    const space = raw.indexOf(' ')
    const key = space < 0 ? raw : raw.slice(0, space)
    const value = space < 0 ? '' : raw.slice(space + 1)
    const uncommitted = ZERO_ID.test(current.sha)
    if (key === 'author' && !uncommitted) info.author = value
    else if (key === 'author-mail' && !uncommitted) info.email = value.replace(/^<|>$/g, '')
    else if (key === 'author-time') info.date = Number(value)
    else if (key === 'summary') info.summary = value
  }
  return lines
}

/** Who last changed each line of `path` at `sha` (null = the working copy file). */
export async function blame(repo: string, path: string, sha: string | null): Promise<BlameLine[]> {
  // Without a commit, blame reads the working-copy file.
  if (sha === null) repoEntries(repo, [path])
  else repoFile(repo, path, true)
  const args = ['blame', '--porcelain']
  if (sha !== null) {
    assertSha(sha)
    args.push(sha)
  }
  args.push('--', gitPath(path))
  return parseBlame(await git(repo, args, { maxBytes: 64 * 1024 * 1024 }))
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/** Index stages of an unmerged file: 1 = base, 2 = ours, 3 = theirs. */
async function conflictStages(repo: string, path: string): Promise<Set<number>> {
  const out = await git(repo, ['ls-files', '-u', '-z', '--', gitPath(path)], LITERAL_PATHS)
  const stages = new Set<number>()
  for (const entry of out.split('\0')) {
    const m = /^\d+ [0-9a-f]+ (\d)\t/.exec(entry)
    if (m) stages.add(Number(m[1]))
  }
  return stages
}

async function requireConflict(repo: string, path: string): Promise<Set<number>> {
  repoEntries(repo, [path])
  const stages = await conflictStages(repo, path)
  if (!stages.size) throw new GitError(`${path} has no conflict to resolve.`, null, '')
  return stages
}

/**
 * The working copy file, with its conflict markers. Binary and non-UTF-8 files come
 * back without content: they can only be taken whole from one side (or edited elsewhere).
 */
export async function readConflict(repo: string, path: string): Promise<ConflictFile> {
  await requireConflict(repo, path)
  // `binary` in .gitattributes (-diff): git itself treats the file as binary.
  const attr = await git(repo, ['check-attr', '-z', 'diff', '--', gitPath(path)], LITERAL_PATHS)
  const binaryAttr = attr.split('\0')[2] === 'unset'
  try {
    const target = repoFile(repo, path)
    // Too big to show and resolve here (as for diffs): it can still be taken from one side.
    if ((await fs.stat(target)).size > CONFLICT_MAX_BYTES)
      return { content: null, binary: false, encodingProblem: false, tooLarge: true }
    const file = decodeText(await fs.readFile(target))
    return binaryAttr ? { content: null, binary: true, encodingProblem: false } : file
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    throw new GitError(`${path} was deleted on one side: take the side you want.`, null, '')
  }
}

/** Writes the resolved content and stages the file. */
export async function resolveConflict(repo: string, path: string, content: string): Promise<void> {
  if (typeof content !== 'string') throw new GitError('Invalid file content', null, '')
  await requireConflict(repo, path)
  const file = repoFile(repo, path)
  await assertNotSymlink(file)
  await assertSafeWorkTree(repo)
  await fs.writeFile(file, content, 'utf8')
  await git(repo, ['add', '--', gitPath(path)], LITERAL_PATHS)
}

/** Stages the file as it is in the working copy, without rewriting it. */
export async function markResolved(repo: string, path: string): Promise<void> {
  await requireConflict(repo, path)
  await git(repo, ['add', '--', gitPath(path)], LITERAL_PATHS)
}

/**
 * Takes the whole file from one side. These are git's own meanings: during a merge
 * "ours" is the current branch (HEAD) and "theirs" the branch being merged; during a
 * rebase they are swapped ("ours" is the branch being rebased onto, "theirs" the
 * commit being replayed). The UI labels them "Current (HEAD)" / "Incoming".
 */
export async function resolveConflictSide(
  repo: string,
  path: string,
  side: ConflictSide
): Promise<void> {
  if (side !== 'ours' && side !== 'theirs') throw new GitError(`Invalid side ${side}`, null, '')
  const stages = await requireConflict(repo, path)
  const p = gitPath(path)
  await assertSafeWorkTree(repo)
  if (!stages.has(side === 'ours' ? 2 : 3)) {
    // That side deleted the file: taking it means deleting the file.
    await git(repo, ['rm', '-q', '--', p], LITERAL_PATHS)
    return
  }
  await git(repo, ['checkout', `--${side}`, '--', p], LITERAL_PATHS)
  await git(repo, ['add', '--', p], LITERAL_PATHS)
}

// ---------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------

export async function rebase(repo: string, onto: string): Promise<void> {
  assertSafeRef(onto)
  await mayConflict(repo, () => git(repo, ['rebase', onto]))
}

const REBASE_MAX_COMMITS = 500

async function resolveCommit(repo: string, ref: string): Promise<string> {
  assertSafeRef(ref)
  const r = await runGit(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], {
    okCodes: [0, 1, 128]
  })
  if (r.exitCode !== 0) throw new GitError(`${ref} is not a commit`, null, '')
  return r.stdout.trim()
}

/**
 * The commits `git rebase -i <base>` replays, oldest first: those of HEAD that are
 * not in `base` (`base` may have moved on since the branch started), minus the ones
 * whose change is already in `base` (cherry-picked), which git skips. This is the
 * revision walk git's own todo list comes from, except that merge commits are kept
 * (with their parents) so the UI can show them; rebaseInteractive refuses them.
 */
export async function rebaseCommits(repo: string, base: string): Promise<Commit[]> {
  const baseSha = await resolveCommit(repo, base)
  const range = ['--cherry-pick', '--right-only', `${baseSha}...HEAD`]
  const count = Number((await git(repo, ['rev-list', '--count', ...range])).trim())
  if (count > REBASE_MAX_COMMITS)
    throw new GitError(`Too many commits to rebase at once (${count}).`, null, '')
  return logCommits(repo, ['--reverse', '--topo-order', ...range])
}

// Interactive rebases keep their new messages in a temp folder, read by the todo's exec
// lines until the rebase ends (Continue may come after a restart, or from a terminal).
// Each folder records its repository, so any leftover is removed once that repository
// has no rebase in progress.
const REBASE_DIR_PREFIX = 'gitdesk-rebase-'
const REBASE_DIR_OWNER = 'repository.txt'

/** Removes the temp folders of finished interactive rebases (of `repo`, or of any repository). */
export async function cleanupRebaseFiles(repo?: string): Promise<void> {
  let names: string[]
  try {
    names = (await fs.readdir(tmpdir())).filter((n) => n.startsWith(REBASE_DIR_PREFIX))
  } catch {
    return
  }
  for (const name of names) {
    const dir = join(tmpdir(), name)
    const owner = await fs.readFile(join(dir, REBASE_DIR_OWNER), 'utf8').catch(() => null)
    if (repo !== undefined && owner !== repo) continue
    if (owner && existsSync(owner)) {
      const op = await currentOperation(owner).catch(() => null)
      if (op === 'rebase') continue
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Single-quoted for git's sh; only ever used for temp files GitDesk created. */
function shQuote(path: string): string {
  return `'${path.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`
}

const REBASE_ACTIONS = ['pick', 'reword', 'squash', 'fixup', 'drop']

function validatePlan(commits: Commit[], steps: RebaseStep[]): void {
  const mismatch = new GitError('The rebase plan does not match the commits to rebase.', null, '')
  if (!Array.isArray(steps) || steps.length !== commits.length) throw mismatch
  const expected = new Set(commits.map((c) => c.sha))
  const seen = new Set<string>()
  for (const step of steps) {
    if (!step || !REBASE_ACTIONS.includes(step.action))
      throw new GitError(`Invalid rebase action ${step?.action}`, null, '')
    if (typeof step.sha !== 'string' || !expected.has(step.sha) || seen.has(step.sha))
      throw mismatch
    seen.add(step.sha)
    if (step.message !== undefined && step.message !== null && typeof step.message !== 'string')
      throw new GitError('Invalid commit message', null, '')
    if (step.action === 'reword' && !step.message?.trim())
      throw new GitError('Write the new message of the reworded commit.', null, '')
  }
  const first = steps.find((s) => s.action !== 'drop')
  if (first && (first.action === 'squash' || first.action === 'fixup'))
    throw new GitError('The first commit cannot be squashed: there is nothing before it.', null, '')
  if (commits.some((c) => c.parents.length > 1))
    throw new GitError('Interactive rebase of merge commits is not supported.', null, '')
}

/**
 * Runs `git rebase -i` without an editor: GIT_SEQUENCE_EDITOR copies our todo list
 * over git's, and new messages are applied by `exec git commit --amend -F <file>`
 * right after the commit they belong to. A conflict leaves the rebase in progress,
 * like any rebase (Continue / Abort); the exec lines still run on Continue.
 */
export async function rebaseInteractive(
  repo: string,
  base: string,
  steps: RebaseStep[]
): Promise<void> {
  const baseSha = await resolveCommit(repo, base)
  const op = await currentOperation(repo)
  if (op)
    throw new GitError(`A ${op} is already in progress: Continue or Abort it first.`, null, '')
  // Same list as the dialog showed, so the plan names exactly the commits git will replay.
  const commits = await rebaseCommits(repo, baseSha)
  validatePlan(commits, steps)
  if (!commits.length) return

  await cleanupRebaseFiles(repo) // files of an earlier rebase, finished outside GitDesk
  const dir = await fs.mkdtemp(join(tmpdir(), REBASE_DIR_PREFIX))
  try {
    await fs.writeFile(join(dir, REBASE_DIR_OWNER), repo, 'utf8')

    const todo: string[] = []
    let messages = 0
    const amendWith = async (message: string): Promise<void> => {
      const file = join(dir, `message-${++messages}.txt`)
      await fs.writeFile(file, message, 'utf8')
      todo.push(`exec git commit --amend --no-verify -F ${shQuote(file)}`)
    }
    for (const step of steps) {
      if (step.action === 'reword') {
        todo.push(`pick ${step.sha}`)
        await amendWith(step.message!)
      } else if (step.action === 'squash') {
        todo.push(`squash ${step.sha}`)
        // Without a message git keeps both messages, one after the other.
        if (step.message?.trim()) await amendWith(step.message)
      } else {
        todo.push(`${step.action} ${step.sha}`)
      }
    }
    const todoFile = join(dir, 'todo.txt')
    await fs.writeFile(todoFile, todo.join('\n') + '\n', 'utf8')
    await mayConflict(repo, () =>
      git(repo, ['rebase', '-i', '--no-autosquash', baseSha], {
        env: { GIT_SEQUENCE_EDITOR: `cp ${shQuote(todoFile)}` }
      })
    )
  } finally {
    await cleanupRebaseFiles(repo)
  }
}

// ---------------------------------------------------------------------------
// Pull requests, .gitignore
// ---------------------------------------------------------------------------

async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  const r = await runGit(repo, ['merge-base', '--is-ancestor', a, b], { okCodes: [0, 1] })
  return r.exitCode === 0
}

/**
 * Fetches GitHub's `pull/<n>/head` and checks it out as the local branch `pr/<n>`.
 * An existing `pr/<n>` only moves forward: when it has commits the pull request does
 * not (yours, or the pull request was force-pushed), it is checked out as it is.
 */
export async function checkoutPullRequest(repo: string, number: number): Promise<void> {
  if (!Number.isInteger(number) || number <= 0 || number > 1e9)
    throw new GitError(`Invalid pull request number ${number}`, null, '')
  if (!(await remoteNames(repo)).includes('origin'))
    throw new GitError('This repository has no "origin" remote.', null, '')
  const branch = `pr/${number}`
  const ref = `refs/heads/${branch}`
  await git(repo, ['fetch', 'origin', `refs/pull/${number}/head`])
  const fetched = await resolveCommit(repo, 'FETCH_HEAD')
  const kept = new GitError(
    `${branch} has local commits that are not in the pull request: kept your branch as it is.`,
    null,
    ''
  )
  const head = await runGit(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [0, 1] })
  if (head.stdout.trim() === branch) {
    if (await isAncestor(repo, fetched, 'HEAD')) return // already up to date
    if (!(await isAncestor(repo, 'HEAD', fetched))) throw kept
    await git(repo, ['merge', '--ff-only', fetched])
    return
  }
  if (!(await isLocalBranch(repo, branch))) {
    await git(repo, ['switch', '-c', branch, fetched])
    return
  }
  const local = await resolveCommit(repo, ref)
  if (local !== fetched && (await isAncestor(repo, local, fetched))) {
    // The old value makes update-ref refuse if the branch moved in between.
    await git(repo, ['update-ref', ref, fetched, local])
  }
  await git(repo, ['switch', branch])
  if (!(await isAncestor(repo, fetched, ref))) throw kept
}

/** Appends a pattern to the repository's top-level .gitignore (once). */
export async function ignorePath(repo: string, pattern: string): Promise<void> {
  // Trailing spaces escaped with `\` belong to the pattern (a file name ending in spaces).
  const line = typeof pattern === 'string' ? pattern.replace(/^\s+|(?<!\\)\s+$/g, '') : ''
  if (!line || /[\0\r\n]/.test(pattern)) throw new GitError('Invalid ignore pattern', null, '')
  const file = join(repo, '.gitignore')
  await assertNotSymlink(file)
  let text = ''

  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === line)) return
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const separator = text && !text.endsWith('\n') ? eol : ''
  await fs.appendFile(file, separator + line + eol, 'utf8')
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const ACTIVITY_FORMAT = LOG_FORMAT

export function parseActivity(repo: string, out: string): ActivityCommit[] {
  return parseLog(out).map((c) => ({
    repo,
    sha: c.sha,
    author: c.author,
    email: c.email.toLowerCase(),
    time: c.date,
    subject: c.subject,
    merge: c.parents.length > 1
  }))
}

/** Every commit on any branch (remote ones included) since a date. */
export async function activityCommits(repo: string, sinceSec: number): Promise<ActivityCommit[]> {
  const r = await runGit(
    repo,
    ['log', '--exclude=refs/stash', '--all', `--since=${Math.floor(sinceSec)}`, ACTIVITY_FORMAT],
    { okCodes: [0, 128] }
  )
  return r.exitCode === 0 ? parseActivity(repo, r.stdout) : []
}

const ZERO_SHA = /^0+$/

/** Commits brought by a push, from the local clone (fetch first to see the latest). */
export async function pushCommits(
  repo: string,
  before: string,
  after: string
): Promise<ActivityCommit[]> {
  assertSha(after)
  if (ZERO_SHA.test(after)) return [] // branch deletion
  let range: string[]
  if (ZERO_SHA.test(before)) {
    // New branch: what it has that the remote default branch does not.
    const head = await runGit(repo, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/HEAD'], {
      okCodes: [0, 1]
    })
    range = head.exitCode === 0 ? [after, '--not', 'refs/remotes/origin/HEAD'] : [after]
  } else {
    assertSha(before)
    range = [`${before}..${after}`]
  }
  const r = await runGit(repo, ['log', '-n', '100', ACTIVITY_FORMAT, ...range, '--'], {
    okCodes: [0, 128]
  })
  if (r.exitCode !== 0) {
    throw new GitError(
      'These commits are not in your local copy yet: fetch the repository.',
      128,
      ''
    )
  }
  return parseActivity(repo, r.stdout)
}

// ---------------------------------------------------------------------------
// Cloning & GitHub
// ---------------------------------------------------------------------------

/** "owner/repo" of a github.com URL (the same parser as every hosting feature). */
export function githubComSlug(url: string): string | null {
  const ref = parseRemote(url)
  return ref?.provider === 'github' && ref.host === 'github.com' ? ref.slug : null
}

/** "owner/repo" when origin points at github.com. */
export async function originSlug(repo: string): Promise<string | null> {
  const url = await originUrl(repo)
  return url ? githubComSlug(url) : null
}

/**
 * Partial clone (`--filter=blob:none`): commits and trees come down at once,
 * file contents only when needed, which keeps big repositories quick to add.
 */
export async function clone(
  url: string,
  target: string,
  auth: GitAuth | null,
  onProgress: (phase: string, percent: number | null) => void,
  signal?: AbortSignal
): Promise<void> {
  await fs.mkdir(dirname(target), { recursive: true })
  let lastSent = 0
  await runGit(dirname(target), ['clone', '--progress', '--filter=blob:none', '--', url, target], {
    auth,
    // No time limit (a big first clone can be slow): it can be cancelled instead.
    signal,
    onStderr: (text) => {
      // Progress lines look like "Receiving objects:  45% (450/1000), 1.2 MiB | 2.3 MiB/s".
      const lines = text.split(/[\r\n]+/).filter(Boolean)
      const m = /^(?:remote: )?([A-Za-z ]+):\s+(\d+)%/.exec(lines[lines.length - 1] ?? '')
      const now = Date.now()
      if (m && (now - lastSent > 150 || m[2] === '100')) {
        lastSent = now
        onProgress(m[1].trim(), Number(m[2]))
      }
    }
  })
  // clone writes no commit-graph (see fetchAll): in the background, the clone is usable.
  void writeCommitGraphAfterClone(target)
}

/**
 * Best effort, after a clone: a split commit-graph, unless the user's config turns
 * commit-graphs off (core.commitGraph=false, fetch.writeCommitGraph=false...).
 */
export async function writeCommitGraphAfterClone(target: string): Promise<boolean> {
  try {
    if ((await commitGraphConfig(target)) === 'off') return false
    await runGit(target, ['commit-graph', 'write', '--reachable', '--split'])
    return true
  } catch {
    return false // only a speed-up
  }
}

async function lastFetchTime(repo: string): Promise<number | null> {
  try {
    const st = await fs.stat(join(await gitDir(repo), 'FETCH_HEAD'))
    return Math.floor(st.mtimeMs / 1000)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const ACTIVITY_DAYS = 30

// A branch tip for the dashboard (%(authoremail) keeps its <>: parseTips removes them).
// From git 2.41, the :mailmap atoms give the names `git log` shows (%aN, %aE); an unknown
// atom would fail the whole command, so older git gets the plain ones.
const tipFormat = (mailmap: boolean): string =>
  mailmap
    ? '--format=%(refname)%00%(objectname)%00%(authorname:mailmap)%00%(authoremail:mailmap)%00%(authordate:unix)%00%(subject)%00'
    : '--format=%(refname)%00%(objectname)%00%(authorname)%00%(authoremail)%00%(authordate:unix)%00%(subject)%00'

/** The author of `sha` as `git log` shows it (.mailmap applied), for git before 2.41. */
async function mappedAuthor(
  repo: string,
  sha: string
): Promise<{ author: string; email: string } | null> {
  const r = await runGit(repo, ['log', '-1', '--no-walk', '--format=%aN%x00%aE', sha, '--'], {
    okCodes: [0, 128]
  })
  if (r.exitCode !== 0) return null
  const [author, email] = r.stdout.replace(/\n$/, '').split('\0')
  return author !== undefined && email !== undefined ? { author, email } : null
}

/** The branch count and the newest tip, from a tipFormat for-each-ref sorted newest first. */
export function parseTips(out: string): {
  branchCount: number
  lastCommit: RepoSummary['lastCommit']
} {
  let branchCount = 0
  let lastCommit: RepoSummary['lastCommit'] = null
  for (const [refname, sha, author, email, date, subject] of splitRecords(out, 6)) {
    if (refname.startsWith('refs/heads/')) branchCount++
    if (lastCommit || !OBJECT_ID.test(sha) || !/^-?\d+$/.test(date)) continue
    lastCommit = { sha, date: Number(date), author, email: email.replace(/^<|>$/g, ''), subject }
  }
  return { branchCount, lastCommit }
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export async function summary(repo: string): Promise<RepoSummary> {
  const empty: RepoSummary = {
    path: repo,
    name: basename(repo),
    ok: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: 0,
    conflicts: 0,
    lastCommit: null,
    activity: new Array(ACTIVITY_DAYS).fill(0),
    branchCount: 0,
    github: null,
    account: null,
    lastFetch: null,
    fetchError: null
  }
  if (!existsSync(repo)) return { ...empty, error: 'Folder not found' }

  const since = new Date()
  since.setHours(0, 0, 0, 0)
  since.setDate(since.getDate() - (ACTIVITY_DAYS - 1))

  try {
    // Asked once per session (only the first summary waits for it).
    const mailmapAtoms = atLeast(await gitVersion(repo), 2, 41)
    const [st, activityOut, tipsOut, slug, lastFetch] = await Promise.all([
      status(repo),
      // Commit dates only: an active repository makes thousands of commits a month.
      runGit(
        repo,
        [
          'log',
          '--exclude=refs/stash',
          '--all',
          `--since=${Math.floor(since.getTime() / 1000)}`,
          '--format=%at'
        ],
        { okCodes: [0, 128] }
      ),
      // Every branch tip, newest first: the branch count, and what happened last on the
      // project (the latest commit on any branch, remote ones included).
      git(repo, [
        'for-each-ref',
        '--sort=-committerdate',
        tipFormat(mailmapAtoms),
        'refs/heads',
        'refs/remotes'
      ]),
      originSlug(repo),
      lastFetchTime(repo)
    ])
    const { branchCount, lastCommit } = parseTips(tipsOut)
    // Older git: one more process gives the tip's author with .mailmap applied, like log.
    if (lastCommit && !mailmapAtoms) {
      const mapped = await mappedAuthor(repo, lastCommit.sha).catch(() => null)
      if (mapped) Object.assign(lastCommit, mapped)
    }

    const index = new Map<string, number>()
    for (let i = 0; i < ACTIVITY_DAYS; i++) {
      const d = new Date(since)
      d.setDate(since.getDate() + i)
      index.set(dayKey(d), i)
    }
    const activity = new Array(ACTIVITY_DAYS).fill(0)
    if (activityOut.exitCode === 0)
      for (const t of activityOut.stdout.split('\n')) {
        const i = t ? index.get(dayKey(new Date(Number(t) * 1000))) : undefined
        if (i !== undefined) activity[i]++
      }

    return {
      ...empty,
      ok: true,
      branch: st.branch ?? (st.headSha ? st.headSha.slice(0, 7) : null),
      upstream: st.upstream,
      ahead: st.ahead,
      behind: st.behind,
      changes: st.staged.length + st.unstaged.length,
      conflicts: st.conflicted.length,
      lastCommit,
      activity,
      branchCount,
      github: slug,
      lastFetch
    }
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) }
  }
}

const SKIP_DIRS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '__pycache__'
])

/** Finds git repositories below `root` (not descending into repositories). */
export async function findRepos(root: string, maxDepth = 4): Promise<string[]> {
  const found: string[] = []
  let visited = 0
  async function walk(dir: string, depth: number): Promise<void> {
    if (visited++ > 20000) return
    if (existsSync(join(dir, '.git'))) {
      found.push(resolve(dir))
      return
    }
    if (depth >= maxDepth) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('$')) continue
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(resolve(root), 0)
  return found
}
