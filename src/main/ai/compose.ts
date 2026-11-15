// "Compose commits": the uncommitted changes as units (hunks / files), and applying a plan
// commit by commit by building each commit's index directly (never touching the working tree).

import { createHash } from 'crypto'
import type { AiComposition } from '../../shared/features/ai'
import {
  applyHunks,
  changeUnits,
  splitFilePatches,
  validatePlan,
  type ChangeSet
} from '../../shared/features/ai-patch'
import { git, GitError, runGit } from '../git'
import { currentOperation } from '../repo'
import {
  diffText,
  emptyTree,
  headSha,
  readUntracked,
  untrackedDiff,
  untrackedFiles
} from './context'
import { normalizeCommitMessage } from './prompts'

const LITERAL = { env: { GIT_LITERAL_PATHSPECS: '1' } }

/** More changes than this cannot be composed (prompt, IPC and dialog stay small). */
export const COMPOSE_MAX_UNITS = 300
/** A file larger than this at HEAD is committed whole, never split into hunks. */
const MAX_SPLIT_BYTES = 8 * 1024 * 1024

function tooMany(count: number): GitError {
  return new GitError(
    `There are too many changes to compose (${count.toLocaleString('en-US')}; at most ${COMPOSE_MAX_UNITS}). Commit some of them yourself, or add generated folders to .gitignore, then try again.`,
    null,
    ''
  )
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export interface WorkingChanges {
  head: string | null
  /** HEAD, or the empty tree on an unborn branch. */
  base: string
  fingerprint: string
  set: ChangeSet
  /** Content at `base` of the files split into hunks. */
  baseText: Map<string, string>
  /** Per unit: text shown to the model. */
  bodies: Map<string, string>
}

export async function collectChanges(repo: string): Promise<WorkingChanges> {
  const head = await headSha(repo)
  const base = head ?? (await emptyTree(repo))
  const [read, untracked] = await Promise.all([
    diffText(repo, ['--no-renames', base]),
    untrackedFiles(repo)
  ])
  // A cut diff would leave files out of the plan, or commit a hunk cut in the middle.
  if (read.truncated)
    throw new GitError(
      'The uncommitted changes are too large to compose (more than 8 MB of diff). Commit some of them yourself first.',
      null,
      ''
    )
  const diff = read.text
  const patchList = splitFilePatches(diff)
  if (patchList.length + untracked.length > COMPOSE_MAX_UNITS)
    throw tooMany(patchList.length + untracked.length)
  const untrackedContent = await mapLimit(untracked, 8, async (path) => ({
    path,
    content: await readUntracked(repo, path)
  }))
  // Files that can be split: their base content must read back exactly as UTF-8 text.
  const baseText = new Map<string, string>()
  for (const p of patchList) {
    if (p.status !== 'M' || p.hunks.length < 2) continue
    const r = await runGit(repo, ['cat-file', 'blob', `${base}:${p.path}`], {
      okCodes: [0, 128],
      maxBytes: MAX_SPLIT_BYTES
    })
    if (r.exitCode === 0 && !r.truncated && !r.stdout.includes('�') && !r.stdout.includes('\0'))
      baseText.set(p.path, r.stdout)
  }
  const set = changeUnits(diff, untrackedContent, { splittable: (path) => baseText.has(path) })
  if (set.units.length > COMPOSE_MAX_UNITS) throw tooMany(set.units.length)

  const bodies = new Map<string, string>()
  const patches = new Map(patchList.map((p) => [p.path, p]))
  const contentOf = new Map(untrackedContent.map((u) => [u.path, u.content]))
  for (const u of set.units) {
    const h = set.hunkOf.get(u.id)
    if (h) bodies.set(u.id, [h.hunk.header, ...h.hunk.lines].join('\n'))
    else {
      const p = patches.get(u.path)
      if (p) bodies.set(u.id, p.hunks.map((hk) => [hk.header, ...hk.lines].join('\n')).join('\n'))
      else {
        const content = contentOf.get(u.path)
        bodies.set(u.id, content == null ? '' : untrackedDiff(u.path, content))
      }
    }
  }

  const hash = createHash('sha256')
  hash.update(`${head ?? ''}\0${diff}\0`)
  for (const u of untrackedContent) hash.update(`${u.path}\0${u.content ?? '<binary>'}\0`)
  // Untracked binary files: hash their bytes too (git computes it without reading them here;
  // --no-filters: no clean filter runs, and paths go through stdin, not the command line).
  const binaries = untrackedContent
    .filter((u) => u.content === null && !/[\r\n]/.test(u.path))
    .map((u) => u.path)
  if (binaries.length) {
    const ids = await git(repo, ['hash-object', '--no-filters', '--stdin-paths'], {
      ...LITERAL,
      input: binaries.join('\n') + '\n'
    }).catch(() => '')
    hash.update(ids)
  }
  return { head, base, fingerprint: hash.digest('hex'), set, baseText, bodies }
}

/** Refuses to compose while a merge/rebase is in progress or files are in conflict. */
export async function assertComposable(repo: string): Promise<void> {
  if (await currentOperation(repo))
    throw new GitError('Finish or abort the operation in progress first.', null, '')
  const unmerged = await git(repo, ['ls-files', '--unmerged'])
  if (unmerged.trim()) throw new GitError('Resolve the conflicts first.', null, '')
}

async function modeOf(repo: string, base: string, path: string): Promise<string> {
  const out = await git(repo, ['ls-tree', '-z', base, '--', path], LITERAL)
  const mode = out.split(' ')[0]
  if (!/^100(644|755)$/.test(mode)) throw new GitError(`Cannot split ${path}`, null, '')
  return mode
}

export async function applyComposition(
  repo: string,
  plan: AiComposition
): Promise<{ commits: number }> {
  if (!plan || typeof plan.fingerprint !== 'string' || !Array.isArray(plan.commits))
    throw new GitError('Invalid plan', null, '')
  await assertComposable(repo)
  const changes = await collectChanges(repo)
  if (changes.fingerprint !== plan.fingerprint)
    throw new GitError(
      'The working copy changed since this plan was made. Make a new plan.',
      null,
      ''
    )
  const commits = validatePlan(
    plan.commits.map((c) => ({
      message: normalizeCommitMessage(String(c?.message ?? '')),
      units: c?.units
    })),
    changes.set.units
  )
  const byId = new Map(changes.set.units.map((u) => [u.id, u]))

  const savedIndex = (await git(repo, ['write-tree'])).trim()
  const branchRef = changes.head
    ? null
    : (await runGit(repo, ['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1] })).stdout.trim()
  const applied = new Set<string>()
  let made = 0
  try {
    if (changes.head) await git(repo, ['read-tree', changes.head])
    else await git(repo, ['read-tree', '--empty'])
    for (const [i, commit] of commits.entries()) {
      const wholeFiles: string[] = []
      const splitPaths = new Set<string>()
      for (const id of commit.units) {
        const unit = byId.get(id)!
        if (unit.kind === 'file') wholeFiles.push(unit.path)
        else {
          applied.add(id)
          splitPaths.add(unit.path)
        }
      }
      if (wholeFiles.length) await git(repo, ['add', '-A', '--', ...wholeFiles], LITERAL)
      for (const path of splitPaths) {
        const ids = changes.set.hunksByPath.get(path) ?? []
        const chosen = ids.filter((id) => applied.has(id))
        if (chosen.length === ids.length) {
          // Every hunk of the file is in now: take the working copy itself.
          await git(repo, ['add', '-A', '--', path], LITERAL)
          continue
        }
        const content = applyHunks(
          changes.baseText.get(path) ?? '',
          chosen.map((id) => changes.set.hunkOf.get(id)!.hunk)
        )
        const blob = (
          await git(repo, ['hash-object', '-w', '--no-filters', '--stdin'], { input: content })
        ).trim()
        const mode = await modeOf(repo, changes.base, path)
        await git(repo, ['update-index', '--cacheinfo', mode, blob, path])
      }
      const staged = await runGit(repo, ['diff', '--cached', '--quiet'], { okCodes: [0, 1] })
      if (staged.exitCode === 0) throw new GitError(`Commit ${i + 1} would be empty.`, null, '')
      await git(repo, ['commit', '-q', '-F', '-'], { input: commit.message })
      made++
    }
  } catch (e) {
    // Put everything back: HEAD where it was, and the index as it was before.
    try {
      if (made > 0) {
        if (changes.head) await git(repo, ['reset', '-q', '--soft', changes.head])
        else if (branchRef) await git(repo, ['update-ref', '-d', branchRef])
      }
      await git(repo, ['read-tree', savedIndex])
    } catch (restoreError) {
      throw new GitError(
        `${(e as Error).message}\nGitDesk could not restore the previous state (${(restoreError as Error).message}). HEAD was ${changes.head ?? 'unborn'}.`,
        null,
        ''
      )
    }
    throw new GitError(
      `${(e as Error).message}\nNothing was committed: your changes and the staging area are as before.`,
      null,
      ''
    )
  }
  return { commits: made }
}
