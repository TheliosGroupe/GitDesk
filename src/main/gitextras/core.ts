// Compare, line history, Gitflow, conflict prevention and patches: the git side.
// No Electron imports (dialogs, the queue and undo live in handlers.ts), so these
// functions can run against temporary repositories outside the app.
import { promises as fs } from 'fs'
import { resolve } from 'path'
import type { ChangeKind, Commit, FileChange } from '../../shared/types'
import {
  COMPARE_MAX_COMMITS,
  CONFLICT_RETRY_MS,
  type ApplyPatchResult,
  type CompareResult,
  type ConflictReport,
  type ConflictWarning,
  type GitflowConfig,
  type GitflowFinishOptions,
  type GitflowFinishResult,
  type GitflowKind,
  type LineHistoryEntry,
  type PatchSource
} from '../../shared/features/gitextras'
import { assertBranchName, assertSafeRef, assertSha, git, GitError, runGit } from '../git'
import { repoFile } from '../paths'
import { currentOperation, gitVersion, LOG_FORMAT, parseLog, recentSnapshot } from '../repo'
import {
  cleanFlowName,
  defaultBase,
  DEFAULT_PREFIXES,
  finishPlan,
  flowBranch,
  GITFLOW_KINDS,
  gitflowConfigProblem,
  gitflowEntries,
  gitflowFromConfig,
  LINE_LOG_FORMAT,
  overlap,
  parseBranchRefs,
  parseConfigZ,
  parseLineLog,
  parseMergeTree,
  parseStatusV2,
  pickCandidates,
  REF_FORMAT,
  supportsMergeTree,
  type FinishStep,
  type StatusV2
} from './parse'

const LITERAL_PATHS = { env: { GIT_LITERAL_PATHSPECS: '1' } }

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The commit a user-supplied ref names (branch, tag, sha, "HEAD~2"...). */
export async function resolveCommit(repo: string, ref: string): Promise<string> {
  if (typeof ref !== 'string') throw new GitError('Invalid ref', null, '')
  const name = ref.trim()
  assertSafeRef(name)
  const r = await runGit(
    repo,
    ['rev-parse', '--verify', '-q', '--end-of-options', `${name}^{commit}`],
    {
      okCodes: [0, 1, 128]
    }
  )
  if (r.exitCode !== 0) throw new GitError(`"${name}" is not a branch, tag or commit`, null, '')
  return r.stdout.trim()
}

async function revParse(repo: string, ref: string): Promise<string | null> {
  const r = await runGit(repo, ['rev-parse', '--verify', '-q', ref], { okCodes: [0, 1, 128] })
  return r.exitCode === 0 ? r.stdout.trim() : null
}

async function localBranchSha(repo: string, name: string): Promise<string | null> {
  return revParse(repo, `refs/heads/${name}^{commit}`)
}

async function currentBranch(repo: string): Promise<string | null> {
  const r = await runGit(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [0, 1, 128] })
  return r.exitCode === 0 ? r.stdout.trim() || null : null
}

async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  const r = await runGit(repo, ['merge-base', '--is-ancestor', a, b], { okCodes: [0, 1, 128] })
  return r.exitCode === 0
}

async function mergeBase(repo: string, a: string, b: string): Promise<string | null> {
  const r = await runGit(repo, ['merge-base', a, b], { okCodes: [0, 1, 128] })
  return r.exitCode === 0 ? r.stdout.trim() || null : null
}

/** The merge, rebase, am, cherry-pick or revert in progress (repo.ts currentOperation). */
export async function operationInProgress(repo: string): Promise<string | null> {
  return currentOperation(repo)
}

async function unmergedCount(repo: string): Promise<number> {
  const out = await git(repo, ['diff', '--name-only', '--diff-filter=U', '-z']).catch(() => '')
  return out.split('\0').filter(Boolean).length
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(Number(n) || min)))
}

export function parseNameStatus(out: string): FileChange[] {
  const tokens = out.split('\0').filter((t) => t !== '')
  const files: FileChange[] = []
  for (let i = 0; i < tokens.length; i++) {
    const kind = tokens[i][0] as ChangeKind
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

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

async function commitsIn(repo: string, range: string): Promise<Commit[]> {
  return parseLog(
    await git(repo, [
      'log',
      LOG_FORMAT,
      '--topo-order',
      `--max-count=${COMPARE_MAX_COMMITS}`,
      range
    ])
  )
}

export async function compare(
  repo: string,
  from: string,
  to: string,
  threeDot = true
): Promise<CompareResult> {
  const [fromSha, toSha] = await Promise.all([resolveCommit(repo, from), resolveCommit(repo, to)])
  const base = await mergeBase(repo, fromSha, toSha)
  // Without a merge base (unrelated histories) only the direct diff exists.
  const three = threeDot !== false && !!base
  const [counts, ahead, behind, files] = await Promise.all([
    git(repo, ['rev-list', '--count', '--left-right', `${fromSha}...${toSha}`]),
    commitsIn(repo, `${fromSha}..${toSha}`),
    commitsIn(repo, `${toSha}..${fromSha}`),
    git(repo, [
      'diff',
      '-z',
      '-M',
      '--name-status',
      '--no-ext-diff',
      ...(three ? [`${fromSha}...${toSha}`] : [fromSha, toSha])
    ])
  ])
  const [behindCount, aheadCount] = counts.trim().split(/\s+/).map(Number)
  return {
    from: from.trim(),
    to: to.trim(),
    fromSha,
    toSha,
    mergeBase: base,
    ahead,
    behind,
    aheadCount: aheadCount || 0,
    behindCount: behindCount || 0,
    files: parseNameStatus(files),
    threeDot: three
  }
}

// ---------------------------------------------------------------------------
// Line history
// ---------------------------------------------------------------------------

export async function lineHistory(
  repo: string,
  path: string,
  start: number,
  end: number,
  limit: number
): Promise<LineHistoryEntry[]> {
  repoFile(repo, path, true)
  const a = Math.floor(Number(start))
  const b = Math.floor(Number(end))
  if (!(a >= 1) || !(b >= a)) throw new GitError(`Invalid line range ${start}–${end}`, null, '')
  const file = path.replace(/\\/g, '/')
  try {
    const out = await git(
      repo,
      [
        'log',
        LINE_LOG_FORMAT,
        '--no-ext-diff',
        `--max-count=${clamp(limit, 1, 500)}`,
        `-L${a},${b}:${file}`,
        'HEAD'
      ],
      { maxBytes: 32 * 1024 * 1024 }
    )
    return parseLineLog(out)
  } catch (e) {
    if (e instanceof GitError && /has only \d+ lines?/.test(e.message))
      throw new GitError(
        `${file} has fewer lines in the last commit than the selection (lines ${a}–${b}): ` +
          'commit your changes first, or pick lines that exist in HEAD.',
        e.exitCode,
        e.stderr
      )
    if (e instanceof GitError && /no path .* in HEAD|does not have any commits/i.test(e.message))
      throw new GitError(`${file} has no history yet (not committed).`, e.exitCode, e.stderr)
    throw e
  }
}

// ---------------------------------------------------------------------------
// Gitflow
// ---------------------------------------------------------------------------

export async function gitflowConfig(repo: string): Promise<GitflowConfig | null> {
  const r = await runGit(repo, ['config', '-z', '--get-regexp', '^gitflow\\.'], {
    okCodes: [0, 1]
  })
  return gitflowFromConfig(parseConfigZ(r.stdout))
}

async function requireGitflow(repo: string): Promise<GitflowConfig> {
  const config = await gitflowConfig(repo)
  if (!config) throw new GitError('Gitflow is not initialized in this repository.', null, '')
  return config
}

export async function gitflowDefaults(repo: string): Promise<GitflowConfig> {
  const existing = await gitflowConfig(repo)
  if (existing) return existing
  const out = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  const branches = new Set(out.split('\n').filter(Boolean))
  const main =
    ['main', 'master', 'production', 'trunk'].find((b) => branches.has(b)) ??
    (await currentBranch(repo)) ??
    'main'
  return { main, develop: 'develop', prefixes: { ...DEFAULT_PREFIXES } }
}

function assertKind(kind: string): asserts kind is GitflowKind {
  if (!GITFLOW_KINDS.includes(kind as GitflowKind))
    throw new GitError(`Unknown Gitflow branch type "${kind}"`, null, '')
}

/** Local branch `name`, created from origin/<name> when only the remote one exists. */
async function ensureLocalBranch(repo: string, name: string): Promise<boolean> {
  if (await localBranchSha(repo, name)) return true
  const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean)
  for (const remote of remotes.includes('origin') ? ['origin'] : remotes) {
    if (await revParse(repo, `refs/remotes/${remote}/${name}^{commit}`)) {
      await git(repo, ['branch', '--track', name, `${remote}/${name}`])
      return true
    }
  }
  return false
}

export async function gitflowInit(repo: string, config: GitflowConfig): Promise<void> {
  const problem = gitflowConfigProblem(config)
  if (problem) throw new GitError(problem, null, '')
  const clean: GitflowConfig = {
    main: config.main.trim(),
    develop: config.develop.trim(),
    prefixes: { ...config.prefixes }
  }
  await assertBranchName(repo, clean.main)
  await assertBranchName(repo, clean.develop)
  for (const kind of [...GITFLOW_KINDS, 'support'] as const) {
    await assertBranchName(repo, `${clean.prefixes[kind]}name`)
  }
  if (!(await revParse(repo, 'HEAD')))
    throw new GitError('Make a first commit before initializing Gitflow.', null, '')
  if (!(await ensureLocalBranch(repo, clean.main)))
    throw new GitError(`The production branch "${clean.main}" does not exist.`, null, '')
  if (!(await ensureLocalBranch(repo, clean.develop))) {
    await git(repo, ['branch', '--no-track', clean.develop, `refs/heads/${clean.main}`])
  }
  for (const [key, value] of gitflowEntries(clean)) {
    await git(repo, ['config', '--local', key, value])
  }
}

export async function gitflowStart(
  repo: string,
  kind: GitflowKind,
  name: string,
  base?: string | null
): Promise<string> {
  assertKind(kind)
  const config = await requireGitflow(repo)
  const clean = cleanFlowName(config, kind, name)
  if (!clean) throw new GitError(`The ${kind} needs a name.`, null, '')
  const branch = flowBranch(config, kind, clean)
  await assertBranchName(repo, branch)
  if (await localBranchSha(repo, branch))
    throw new GitError(`Branch ${branch} already exists.`, null, '')
  const from = base && String(base).trim() ? String(base).trim() : defaultBase(config, kind)
  if (from === config.develop || from === config.main) await ensureLocalBranch(repo, from)
  const sha = await resolveCommit(repo, from)
  // Uncommitted changes come along, as with `git switch -c`.
  await git(repo, ['switch', '--no-track', '-c', branch, sha])
  return branch
}

/** The open release branch, when exactly one exists (a hotfix is merged back into it). */
async function openRelease(repo: string, config: GitflowConfig): Promise<string | null> {
  const out = await git(repo, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/${config.prefixes.release}`
  ])
  const releases = out.split('\n').filter(Boolean)
  return releases.length === 1 ? releases[0] : null
}

export interface FinishPlan {
  config: GitflowConfig
  branch: string
  steps: FinishStep[]
  /** Branch checked out at the end (the last merge target). */
  endBranch: string
}

/** Checks a finish can start and returns what it will do. */
export async function planFinish(
  repo: string,
  kind: GitflowKind,
  name: string,
  opts: GitflowFinishOptions
): Promise<FinishPlan> {
  assertKind(kind)
  const config = await requireGitflow(repo)
  const branch = flowBranch(config, kind, cleanFlowName(config, kind, name))
  await assertBranchName(repo, branch)
  if (!(await localBranchSha(repo, branch)))
    throw new GitError(`Branch ${branch} does not exist (already finished?).`, null, '')
  const op = await operationInProgress(repo)
  if (op)
    throw new GitError(
      `A ${op} is in progress: resolve the conflicts and Continue (or Abort), then finish ${kind} ${name} again.`,
      null,
      ''
    )
  const dirty = await runGit(repo, ['diff', 'HEAD', '--quiet', '--no-ext-diff'], {
    okCodes: [0, 1, 128]
  })
  if (dirty.exitCode === 1)
    throw new GitError(`Commit or stash your changes before finishing ${kind} ${name}.`, null, '')
  const releaseBranch = kind === 'hotfix' ? await openRelease(repo, config) : null
  const steps = finishPlan(config, kind, name, {
    tag: (kind === 'release' || kind === 'hotfix') && !opts?.noTag,
    deleteBranch: !!opts?.deleteBranch,
    releaseBranch
  })
  for (const s of steps) {
    if (s.type === 'merge' && !(await ensureLocalBranch(repo, s.into)))
      throw new GitError(`Branch ${s.into} does not exist.`, null, '')
  }
  const merges = steps.filter(
    (s): s is Extract<FinishStep, { type: 'merge' }> => s.type === 'merge'
  )
  return { config, branch, steps, endBranch: merges[merges.length - 1].into }
}

async function switchTo(repo: string, branch: string): Promise<void> {
  if ((await currentBranch(repo)) !== branch) await git(repo, ['switch', '--no-guess', branch])
}

/**
 * Runs a finish plan. Every step checks whether it is already done (merged, tagged,
 * deleted), so after a merge stopped on conflicts — resolved and continued — the same
 * finish can simply run again.
 */
export async function runFinish(
  repo: string,
  kind: GitflowKind,
  name: string,
  opts: GitflowFinishOptions,
  plan: FinishPlan
): Promise<GitflowFinishResult> {
  const { branch } = plan
  const done: string[] = []
  const label = `${kind} ${cleanFlowName(plan.config, kind, name)}`
  const branchSha = (await localBranchSha(repo, branch))!
  for (const step of plan.steps) {
    if (step.type === 'merge') {
      // The tag only stands for this finish when it contains the branch (made above,
      // or by an earlier run of the same finish); otherwise merge the branch itself.
      let source = `refs/heads/${branch}`
      let sourceSha = branchSha
      let what = `branch '${branch}'`
      if (step.source !== 'branch') {
        const tagSha = await revParse(repo, `refs/tags/${step.source.tag}^{commit}`)
        if (tagSha && (await isAncestor(repo, branchSha, tagSha))) {
          source = `refs/tags/${step.source.tag}`
          sourceSha = tagSha
          what = `tag '${step.source.tag}'`
        }
      }
      // git's own wording, with short names (the full refs are only there to be unambiguous).
      const message =
        step.into === plan.config.main ? `Merge ${what}` : `Merge ${what} into ${step.into}`
      if (await isAncestor(repo, sourceSha, `refs/heads/${step.into}`)) {
        done.push(`Already merged into ${step.into}`)
        continue
      }
      await switchTo(repo, step.into)
      try {
        await git(repo, ['merge', '--no-ff', '--no-edit', '-m', message, source], {
          env: { GIT_MERGE_AUTOEDIT: 'no' }
        })
      } catch (e) {
        const files = (await operationInProgress(repo)) === 'merge' ? await unmergedCount(repo) : 0
        if (!files) throw e
        const before = done.length ? `${done.join('; ')}. ` : ''
        return {
          done: false,
          steps: done,
          message:
            `${before}The merge of ${branch} into ${step.into} stopped on conflicts in ${plural(files, 'file')}: ` +
            `resolve them, Continue, then finish ${label} again.`
        }
      }
      done.push(`Merged into ${step.into}`)
    } else if (step.type === 'tag') {
      if (await revParse(repo, `refs/tags/${step.tag}`)) {
        done.push(`Tag ${step.tag} already exists`)
        continue
      }
      assertSafeRef(step.tag)
      const check = await runGit(repo, ['check-ref-format', `refs/tags/${step.tag}`], {
        okCodes: [0, 1]
      })
      if (check.exitCode !== 0)
        throw new GitError(`"${step.tag}" is not a valid tag name`, null, '')
      const message =
        opts?.tagMessage?.trim() || `${kind === 'release' ? 'Release' : 'Hotfix'} ${name}`
      await git(repo, ['tag', '-a', '-m', message, step.tag, `refs/heads/${step.on}`])
      done.push(`Tagged ${step.tag}`)
    } else {
      if ((await currentBranch(repo)) === branch) await switchTo(repo, plan.endBranch)
      // Every merge above checked (or made) the branch part of its targets.
      await git(repo, ['branch', '-D', branch])
      done.push(`Deleted ${branch}`)
    }
  }
  await switchTo(repo, plan.endBranch)
  return {
    done: true,
    steps: done,
    message: `Finished ${label}: ${done.join('; ')}. Now on ${plan.endBranch}.`
  }
}

/** Finish in one go (plan, switch to the final branch, run). See handlers.ts for the undoable version. */
export async function gitflowFinish(
  repo: string,
  kind: GitflowKind,
  name: string,
  opts: GitflowFinishOptions,
  track: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn()
): Promise<GitflowFinishResult> {
  const plan = await planFinish(repo, kind, name, opts)
  // Start from the branch the finish ends on, so undo is a plain "move this branch back"
  // (and restores the other refs), even when the flow branch gets deleted.
  await switchTo(repo, plan.endBranch)
  return track(() => runFinish(repo, kind, name, opts, plan))
}

// ---------------------------------------------------------------------------
// Conflict prevention
// ---------------------------------------------------------------------------

const WARN_DAYS = 30
const WARN_MAX_BRANCHES = 30

function mergeTreeSupported(repo: string): Promise<boolean> {
  return gitVersion(repo).then(supportsMergeTree)
}

// Conflict warnings run after every refresh, so they redo only what changed:
// - the report is reused while HEAD, the branch, its upstream, the refs and the set of
//   changed paths are the same (staging a file changes none of them);
// - "your work since the base" is kept while HEAD and the refs are the same;
// - per other branch, the merge base, its changed files and the merge-tree result depend
//   only on (HEAD, its tip): kept while both are the same.
// HEAD, the branch and its upstream come with the status, so a refresh costs two commands,
// or one when the repository view's refresh has just read the status (recentSnapshot).
// A merge-tree that failed is tried again after CONFLICT_RETRY_MS, not on every refresh:
// it can keep failing (a partial clone offline cannot fetch the blobs it needs).

interface PairResult {
  /** Files the branch changes since the merge base; null when it is already merged. */
  theirs: string[] | null
  merge?: Promise<{ conflict: boolean; files: string[] } | null>
  /** When merge-tree last failed for this pair (ms since epoch). */
  failedAt?: number
}

interface ConflictMemo {
  report: { signature: string; value: Promise<ConflictReport> } | null
  base: { key: string; value: Promise<{ base: string | null; files: string[] }> } | null
  /** By "headSha\0tipSha", the branches checked last time. */
  pairs: Map<string, Promise<PairResult>>
}

const memos = new Map<string, ConflictMemo>()

function memoOf(repo: string): ConflictMemo {
  let memo = memos.get(repo)
  if (!memo) memos.set(repo, (memo = { report: null, base: null, pairs: new Map() }))
  return memo
}

/** Runs `forget` if the promise fails, so that the next call tries again. */
function keepIfOk<T>(value: Promise<T>, forget: () => void): Promise<T> {
  value.catch(forget)
  return value
}

function nameList(out: string): string[] {
  return out.split('\0').filter(Boolean)
}

async function defaultBranchRef(repo: string): Promise<string | null> {
  const head = await runGit(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], {
    okCodes: [0, 1, 128]
  })
  if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim()
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    const full = ref.includes('/') ? `refs/remotes/${ref}` : `refs/heads/${ref}`
    if (await revParse(repo, `${full}^{commit}`)) return ref
  }
  return null
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  }
  return out
}

/** The status as the view's last refresh read it, when it is at most a few seconds old. */
function statusFromSnapshot(repo: string): StatusV2 | null {
  const st = recentSnapshot(repo, 3000)?.status
  if (!st) return null
  const paths: string[] = []
  for (const f of st.staged) paths.push(f.path, ...(f.origPath ? [f.origPath] : []))
  for (const f of [...st.unstaged, ...st.conflicted]) paths.push(f.path)
  return { headSha: st.headSha, branch: st.branch, upstream: st.upstream, paths }
}

export async function conflictWarnings(repo: string): Promise<ConflictReport> {
  const recent = statusFromSnapshot(repo)
  const [st, refsOut] = await Promise.all([
    recent ??
      git(repo, [
        'status',
        '--porcelain=v2',
        '--branch',
        // HEAD, branch and upstream only: no ahead/behind walk (slow when far behind).
        '--no-ahead-behind',
        '-z',
        '--untracked-files=all'
      ]).then(parseStatusV2),
    git(repo, ['for-each-ref', REF_FORMAT, 'refs/heads', 'refs/remotes'])
  ])
  if (!st.headSha) {
    return { branch: st.branch, base: null, checked: 0, myFiles: 0, warnings: [], mergeTree: false }
  }
  const paths = [...new Set(st.paths)].sort()
  const memo = memoOf(repo)
  const signature = [st.headSha, st.branch, st.upstream, refsOut, ...paths].join('\0')
  if (memo.report?.signature === signature) return memo.report.value
  const forget = (): void => {
    if (memo.report?.value === value) memo.report = null
  }
  const value: Promise<ConflictReport> = keepIfOk(
    computeWarnings(repo, memo, st.headSha, st.branch, st.upstream, refsOut, paths).then((r) => {
      // A merge-tree failed: not kept, so a check after CONFLICT_RETRY_MS runs it again.
      if (!r.complete) forget()
      return r.complete ? r.report : { ...r.report, incomplete: true }
    }),
    forget
  )
  memo.report = { signature, value }
  return value
}

/** The base your work is measured from, and the files your commits changed since it. */
async function yourBase(
  repo: string,
  headSha: string,
  branch: string | null,
  upstream: string | null
): Promise<{ base: string | null; files: string[] }> {
  const def = await defaultBranchRef(repo)
  const defName = def?.replace(/^[^/]+\//, '') ?? null
  // "Your work": commits since the default branch (or, on it, since its upstream) + uncommitted.
  const base = branch && branch === defName ? upstream : def
  if (!base) return { base, files: [] }
  const baseSha = await revParse(repo, `${base}^{commit}`)
  const mb = baseSha ? await mergeBase(repo, baseSha, headSha) : null
  if (!mb || mb === headSha) return { base, files: [] }
  const out = await git(repo, ['diff', '--name-only', '-z', '--no-renames', mb, headSha])
  return { base, files: nameList(out) }
}

async function pairOf(repo: string, headSha: string, sha: string): Promise<PairResult> {
  const mb = await mergeBase(repo, headSha, sha)
  if (mb === sha) return { theirs: null } // already part of your branch
  const theirs = mb
    ? nameList(await git(repo, ['diff', '--name-only', '-z', '--no-renames', mb, sha]))
    : []
  return { theirs }
}

function mergeTreeOf(
  repo: string,
  headSha: string,
  sha: string
): Promise<{ conflict: boolean; files: string[] } | null> {
  return runGit(
    repo,
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', headSha, sha],
    { okCodes: [0, 1] }
  ).then(
    (r) => parseMergeTree(r.stdout, r.exitCode),
    () => null
  )
}

async function computeWarnings(
  repo: string,
  memo: ConflictMemo,
  headSha: string,
  branch: string | null,
  upstream: string | null,
  refsOut: string,
  paths: string[]
): Promise<{ report: ConflictReport; complete: boolean }> {
  const baseKey = [headSha, branch, upstream, refsOut].join('\0')
  if (memo.base?.key !== baseKey) {
    const value: Promise<{ base: string | null; files: string[] }> = keepIfOk(
      yourBase(repo, headSha, branch, upstream),
      () => {
        if (memo.base?.value === value) memo.base = null
      }
    )
    memo.base = { key: baseKey, value }
  }
  const { base, files: committed } = await memo.base.value
  const mine = new Set([...paths, ...committed])
  const mergeTree = await mergeTreeSupported(repo)
  const report: ConflictReport = {
    branch,
    base,
    checked: 0,
    myFiles: mine.size,
    warnings: [],
    mergeTree
  }
  if (!mine.size) return { report, complete: true }
  let complete = true

  const candidates = pickCandidates(parseBranchRefs(refsOut), {
    now: Math.floor(Date.now() / 1000),
    days: WARN_DAYS,
    max: WARN_MAX_BRANCHES,
    exclude: [branch, upstream].filter((b): b is string => !!b),
    headSha
  })
  report.checked = candidates.length
  const pairs = new Map<string, Promise<PairResult>>()
  const results = await inBatches(candidates, 4, async (c): Promise<ConflictWarning | null> => {
    const key = `${headSha}\0${c.sha}`
    let pending = memo.pairs.get(key) ?? pairs.get(key)
    if (!pending) {
      const value: Promise<PairResult> = keepIfOk(pairOf(repo, headSha, c.sha), () => {
        if (memo.pairs.get(key) === value) memo.pairs.delete(key)
      })
      pending = value
    }
    pairs.set(key, pending)
    const pair = await pending
    if (!pair.theirs) return null
    const files = overlap(mine, pair.theirs)
    if (!files.length) return null
    let status: ConflictWarning['status'] = 'unknown'
    let conflictFiles: string[] = []
    if (mergeTree) {
      if (pair.failedAt !== undefined && Date.now() - pair.failedAt < CONFLICT_RETRY_MS) {
        complete = false // failed lately: 'unknown' until it is time to try again
      } else {
        const merge = (pair.merge ??= mergeTreeOf(repo, headSha, c.sha))
        const parsed = await merge
        if (parsed) {
          status = parsed.conflict ? 'conflict' : 'overlap'
          conflictFiles = parsed.files
          pair.failedAt = undefined
        } else {
          // A failure is not kept: a check after CONFLICT_RETRY_MS runs merge-tree again.
          if (pair.merge === merge) pair.merge = undefined
          pair.failedAt = Date.now()
          complete = false
        }
      }
    }
    return {
      branch: c.name,
      remote: c.remote,
      sha: c.sha,
      files,
      status,
      conflictFiles,
      author: c.author,
      date: c.date,
      subject: c.subject
    }
  })
  // Only the branches checked this time are kept.
  memo.pairs = pairs
  const rank = { conflict: 0, unknown: 1, overlap: 2 }
  report.warnings = results
    .filter((w): w is ConflictWarning => !!w)
    .sort((a, b) => rank[a.status] - rank[b.status] || b.date - a.date)
  return { report, complete }
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

function slug(text: string): string {
  return (
    text
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 52) || 'patch'
  )
}

/** File name suggested in the save dialog; throws when there is nothing to export. */
export async function patchFileName(repo: string, source: PatchSource): Promise<string> {
  if (source?.kind === 'commit') {
    assertSha(source.sha)
    const subject = (await git(repo, ['log', '-1', '--format=%s', source.sha])).trim()
    return `${source.sha.slice(0, 7)}-${slug(subject)}.patch`
  }
  if (source?.kind !== 'working') throw new GitError('Invalid patch source', null, '')
  const quiet = await runGit(
    repo,
    ['diff', '--quiet', '--no-ext-diff', ...(source.staged ? ['--cached'] : [])],
    { okCodes: [0, 1] }
  )
  if (quiet.exitCode === 0)
    throw new GitError(
      source.staged
        ? 'There are no staged changes to export.'
        : 'There are no unstaged changes to export (new files must be staged first).',
      null,
      ''
    )
  const branch = (await currentBranch(repo)) ?? 'detached'
  return `${slug(branch)}-${source.staged ? 'staged' : 'changes'}.patch`
}

/** Writes the patch with git itself (`--output`), so file contents keep their exact bytes. */
export async function writePatch(repo: string, source: PatchSource, file: string): Promise<void> {
  const out = `--output=${resolve(file)}`
  if (source.kind === 'commit') {
    assertSha(source.sha)
    await git(repo, ['format-patch', '-1', '--binary', '--no-ext-diff', out, source.sha])
  } else {
    await git(repo, [
      'diff',
      '--binary',
      '--no-color',
      '--no-ext-diff',
      out,
      ...(source.staged ? ['--cached'] : [])
    ])
  }
}

/** A mailbox (format-patch output, an email) rather than a plain diff. */
export function looksLikeMbox(head: string): boolean {
  if (/^From [0-9a-f]{40,64} /.test(head)) return true
  const diffAt = head.search(/^(diff --git|--- |Index: )/m)
  const headers = diffAt < 0 ? head : head.slice(0, diffAt)
  return /^From: /m.test(headers) && /^Subject: /m.test(headers)
}

/** Reads the start of a patch file: a mailbox for `git am`, or a plain diff. */
export async function patchKind(file: string): Promise<'mbox' | 'diff' | 'empty'> {
  const handle = await fs.open(resolve(file), 'r')
  try {
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const head = buf.subarray(0, bytesRead).toString('utf8')
    if (!head.trim()) return 'empty'
    return looksLikeMbox(head) ? 'mbox' : 'diff'
  } finally {
    await handle.close()
  }
}

export async function applyPatchFile(repo: string, file: string): Promise<ApplyPatchResult> {
  const path = resolve(file)
  const kind = await patchKind(path)
  if (kind === 'empty') return { applied: false, message: 'The file is empty.' }

  if (kind === 'mbox') {
    const op = await operationInProgress(repo)
    if (op)
      return {
        applied: false,
        message: `A ${op} is in progress: Continue or Abort it before applying patches.`
      }
    const before = await revParse(repo, 'HEAD')
    try {
      await git(repo, ['am', '--3way', path])
    } catch (e) {
      if ((await operationInProgress(repo)) !== 'am') throw e
      const files = await unmergedCount(repo)
      const why = files
        ? `stopped on conflicts in ${plural(files, 'file')}: resolve them, stage them, then Continue`
        : `could not be applied (${e instanceof Error ? e.message.split('\n')[0] : 'error'}): fix the working copy and stage it, then Continue`
      return {
        applied: false,
        message: `The patch ${why} — or Abort to put the branch back as it was.`
      }
    }
    const count = before
      ? Number((await git(repo, ['rev-list', '--count', `${before}..HEAD`])).trim())
      : Number((await git(repo, ['rev-list', '--count', 'HEAD'])).trim())
    return { applied: true, message: `Applied ${plural(count, 'commit')} from the patch.` }
  }

  try {
    await git(repo, ['apply', '--3way', '--whitespace=nowarn', path], LITERAL_PATHS)
  } catch (e) {
    const files = await unmergedCount(repo)
    if (files)
      return {
        applied: false,
        message: `The patch was applied with conflicts in ${plural(files, 'file')}: resolve them in the working copy and stage them.`
      }
    return {
      applied: false,
      message: `The patch does not apply: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return { applied: true, message: 'Patch applied to the working copy (changes are staged).' }
}
