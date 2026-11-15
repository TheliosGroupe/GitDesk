// Pure helpers for the git extras (no Electron, no git calls), unit-tested in
// tests/unit/gitextras-*.test.ts.
import type { Commit } from '../../shared/types'
import type { GitflowConfig, GitflowKind, LineHistoryEntry } from '../../shared/features/gitextras'

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * `git log -L` format read by parseLineLog. Every field ends with a NUL and every record
 * starts with one: a commit message or a name cannot hold a NUL, and neither can the
 * text diff that follows each header, so no commit can add or shift a field or a record.
 */
export const LINE_LOG_FORMAT = '--format=%x00%H%x00%P%x00%aN%x00%aE%x00%at%x00%s%x00'

/** One header (sha, parents, author, email, date, subject), or null when malformed. */
function commitOf([sha, parents, author, email, date, subject]: string[]): Commit | null {
  const parentList = parents ? parents.split(' ') : []
  if (!OBJECT_ID.test(sha) || !parentList.every((p) => OBJECT_ID.test(p))) return null
  if (!/^-?\d+$/.test(date)) return null
  return { sha, parents: parentList, author, email, date: Number(date), subject }
}

/**
 * Parses `git log -L a,b:path` printed with LINE_LOG_FORMAT: every commit header is
 * followed by a blank line and the diff of that range. Malformed headers are dropped.
 */
export function parseLineLog(out: string): LineHistoryEntry[] {
  const tokens = out.split('\0')
  const entries: LineHistoryEntry[] = []
  // tokens: '' (before the first record), then per record 6 fields and its diff.
  for (let i = 1; i + 7 <= tokens.length; i += 7) {
    const commit = commitOf(tokens.slice(i, i + 6))
    const patch = tokens[i + 6].replace(/^\n+/, '').replace(/\n+$/, '')
    if (commit) entries.push({ commit, patch: patch ? patch + '\n' : '' })
  }
  return entries
}

// ---------------------------------------------------------------------------
// Gitflow
// ---------------------------------------------------------------------------

export const GITFLOW_KINDS: readonly GitflowKind[] = ['feature', 'bugfix', 'release', 'hotfix']

export const DEFAULT_PREFIXES: GitflowConfig['prefixes'] = {
  feature: 'feature/',
  bugfix: 'bugfix/',
  release: 'release/',
  hotfix: 'hotfix/',
  support: 'support/',
  versiontag: ''
}

const PREFIX_KEYS = Object.keys(DEFAULT_PREFIXES) as (keyof GitflowConfig['prefixes'])[]

/** Gitflow config from `git config --get-regexp ^gitflow\.` entries; null when not initialized. */
export function gitflowFromConfig(entries: Map<string, string>): GitflowConfig | null {
  const main = entries.get('gitflow.branch.master') || entries.get('gitflow.branch.main')
  const develop = entries.get('gitflow.branch.develop')
  if (!main || !develop) return null
  const prefixes = { ...DEFAULT_PREFIXES }
  for (const key of PREFIX_KEYS) {
    const value = entries.get(`gitflow.prefix.${key}`)
    if (value !== undefined) prefixes[key] = value
  }
  return { main, develop, prefixes }
}

/** Parses `git config -z --get-regexp`: "key\nvalue\0" records. */
export function parseConfigZ(out: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const record of out.split('\0')) {
    if (!record) continue
    const nl = record.indexOf('\n')
    const key = (nl < 0 ? record : record.slice(0, nl)).toLowerCase()
    map.set(key, nl < 0 ? '' : record.slice(nl + 1))
  }
  return map
}

/** Config entries written by Initialize (both AVH's "master" key and the newer "main" key). */
export function gitflowEntries(config: GitflowConfig): [string, string][] {
  return [
    ['gitflow.branch.master', config.main],
    ['gitflow.branch.main', config.main],
    ['gitflow.branch.develop', config.develop],
    ...PREFIX_KEYS.map((k): [string, string] => [`gitflow.prefix.${k}`, config.prefixes[k]])
  ]
}

/** Problems with a configuration from the Initialize dialog, or null. */
export function gitflowConfigProblem(config: GitflowConfig): string | null {
  if (!config || typeof config !== 'object') return 'Invalid Gitflow configuration.'
  const { main, develop, prefixes } = config
  if (typeof main !== 'string' || !main.trim()) return 'The production branch needs a name.'
  if (typeof develop !== 'string' || !develop.trim()) return 'The develop branch needs a name.'
  if (main.trim() === develop.trim())
    return 'The production and develop branches must be different.'
  if (!prefixes || typeof prefixes !== 'object') return 'Invalid prefixes.'
  for (const key of PREFIX_KEYS) {
    const p = prefixes[key]
    if (typeof p !== 'string' || /[\s\0~^:?*[\\]/.test(p) || p.startsWith('-'))
      return `Invalid ${key} prefix: "${p}"`
  }
  for (const kind of GITFLOW_KINDS) {
    if (!prefixes[kind]) return `The ${kind} prefix cannot be empty.`
  }
  return null
}

export function flowBranch(config: GitflowConfig, kind: GitflowKind, name: string): string {
  return config.prefixes[kind] + name
}

/** The flow kind and name of a branch ("feature/login" -> feature, "login"), or null. */
export function parseFlowBranch(
  config: GitflowConfig,
  branch: string | null
): { kind: GitflowKind; name: string } | null {
  if (!branch) return null
  // Longest prefix first, in case one prefix starts with another.
  const kinds = [...GITFLOW_KINDS]
    .filter((k) => config.prefixes[k])
    .sort((a, b) => config.prefixes[b].length - config.prefixes[a].length)
  for (const kind of kinds) {
    const prefix = config.prefixes[kind]
    if (branch.startsWith(prefix) && branch.length > prefix.length)
      return { kind, name: branch.slice(prefix.length) }
  }
  return null
}

/** A name typed in the Start dialog: trimmed, spaces become dashes, prefix removed if typed. */
export function cleanFlowName(config: GitflowConfig, kind: GitflowKind, input: string): string {
  let name = String(input ?? '').trim()
  const prefix = config.prefixes[kind]
  if (prefix && name.startsWith(prefix)) name = name.slice(prefix.length)
  return name.replace(/\s+/g, '-')
}

/** Branch a flow branch starts from by default. */
export function defaultBase(config: GitflowConfig, kind: GitflowKind): string {
  return kind === 'hotfix' ? config.main : config.develop
}

export function tagName(config: GitflowConfig, name: string): string {
  return config.prefixes.versiontag + name
}

export type FinishStep =
  /** Merge the flow branch, or (back-merge after tagging, as git-flow AVH) the new tag. */
  | { type: 'merge'; into: string; source: 'branch' | { tag: string } }
  | { type: 'tag'; tag: string; on: string }
  | { type: 'delete' }

/**
 * git-flow finish: feature/bugfix merge into develop; release/hotfix merge into main,
 * are tagged there, then the tag is merged back into develop (as git-flow AVH does, so
 * develop contains main) — a hotfix into the open release branch instead, when there is one.
 */
export function finishPlan(
  config: GitflowConfig,
  kind: GitflowKind,
  name: string,
  opts: { tag: boolean; deleteBranch: boolean; releaseBranch?: string | null }
): FinishStep[] {
  const steps: FinishStep[] = []
  if (kind === 'feature' || kind === 'bugfix') {
    steps.push({ type: 'merge', into: config.develop, source: 'branch' })
  } else {
    steps.push({ type: 'merge', into: config.main, source: 'branch' })
    const tag = tagName(config, name)
    if (opts.tag) steps.push({ type: 'tag', tag, on: config.main })
    const back = kind === 'hotfix' && opts.releaseBranch ? opts.releaseBranch : config.develop
    steps.push({ type: 'merge', into: back, source: opts.tag ? { tag } : 'branch' })
  }
  if (opts.deleteBranch) steps.push({ type: 'delete' })
  return steps
}

// ---------------------------------------------------------------------------
// Conflict prevention
// ---------------------------------------------------------------------------

/** [major, minor, patch] from `git version` output. */
export function parseGitVersion(out: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(out)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

/** `git merge-tree --write-tree` exists since 2.38. */
export function supportsMergeTree(version: [number, number, number] | null): boolean {
  if (!version) return false
  const [major, minor] = version
  return major > 2 || (major === 2 && minor >= 38)
}

/**
 * `git merge-tree --write-tree --name-only --no-messages -z`: the tree id, then the
 * conflicted paths, NUL-separated. Exit code 1 means conflicts.
 */
export function parseMergeTree(
  out: string,
  exitCode: number
): { conflict: boolean; files: string[] } {
  const parts = out.split('\0').filter(Boolean)
  const files = parts.slice(1).map((f) => f.replace(/\n$/, ''))
  return { conflict: exitCode === 1, files: [...new Set(files)].sort() }
}

/** Files in both lists, sorted. */
export function overlap(mine: Iterable<string>, theirs: Iterable<string>): string[] {
  const set = new Set(mine)
  return [...new Set([...theirs].filter((f) => set.has(f)))].sort()
}

export interface BranchRef {
  /** Short name, e.g. "origin/feature/x" or "feature/x". */
  name: string
  remote: boolean
  sha: string
  /** Committer date, unix seconds. */
  date: number
  author: string
  subject: string
}

/** `for-each-ref` format read by parseBranchRefs: NUL-terminated fields (see LINE_LOG_FORMAT). */
export const REF_FORMAT =
  '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(authorname)%00%(subject)%00'

/** Parses `for-each-ref` printed with REF_FORMAT; malformed entries are dropped. */
export function parseBranchRefs(out: string): BranchRef[] {
  const refs: BranchRef[] = []
  const tokens = out.split('\0')
  for (let i = 0; i + 5 <= tokens.length; i += 5) {
    const [line, sha, date, author, subject] = tokens.slice(i, i + 5)
    const ref = line.replace(/^\r?\n/, '') // each entry ends with a newline
    if (!OBJECT_ID.test(sha)) continue
    let name: string
    let remote: boolean
    if (ref.startsWith('refs/heads/')) {
      name = ref.slice('refs/heads/'.length)
      remote = false
    } else if (ref.startsWith('refs/remotes/')) {
      name = ref.slice('refs/remotes/'.length)
      remote = true
      if (name.endsWith('/HEAD')) continue
    } else continue
    refs.push({ name, remote, sha, date: Number(date) || 0, author, subject })
  }
  return refs
}

/**
 * Branches worth checking against yours: updated in the last `days` days, not yours
 * (nor its upstream), not already merged into HEAD (same sha), remote branches first,
 * local ones that point where an already listed remote branch points are skipped.
 */
export function pickCandidates(
  refs: BranchRef[],
  opts: { now: number; days: number; max: number; exclude: string[]; headSha: string | null }
): BranchRef[] {
  const since = opts.now - opts.days * 86400
  const exclude = new Set(opts.exclude)
  const recent = refs
    .filter((r) => r.date >= since && !exclude.has(r.name) && r.sha !== opts.headSha)
    .sort((a, b) => Number(b.remote) - Number(a.remote) || b.date - a.date)
  const seen = new Set<string>()
  const out: BranchRef[] = []
  for (const r of recent) {
    if (seen.has(r.sha)) continue
    seen.add(r.sha)
    out.push(r)
    if (out.length >= opts.max) break
  }
  return out
}

export interface StatusV2 {
  headSha: string | null
  /** null when detached. */
  branch: string | null
  /** e.g. "origin/main", when the branch has one. */
  upstream: string | null
  /** Changed paths (staged, unstaged, conflicted, untracked), both names of a rename. */
  paths: string[]
}

/** Number of fields before the path in each `--porcelain=v2` entry type. */
const V2_FIELDS: Record<string, number> = { '1': 8, '2': 9, u: 10, '?': 1 }

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(out: string): StatusV2 {
  const result: StatusV2 = { headSha: null, branch: null, upstream: null, paths: [] }
  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('# ')) {
      const [key, value = ''] = t.slice(2).split(' ', 2)
      if (key === 'branch.oid' && OBJECT_ID.test(value)) result.headSha = value
      else if (key === 'branch.head' && value !== '(detached)') result.branch = value || null
      else if (key === 'branch.upstream') result.upstream = value || null
      continue
    }
    const n = V2_FIELDS[t[0]]
    if (!n || t[1] !== ' ') continue
    const path = t.split(' ').slice(n).join(' ')
    if (path) result.paths.push(path)
    if (t[0] === '2' && tokens[i + 1]) result.paths.push(tokens[++i])
  }
  return result
}
