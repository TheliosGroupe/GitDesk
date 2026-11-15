import type { RepoOperation, ResetMode, UndoInfo } from '../shared/types'
import { git, GitError, runGit } from './git'
import { currentOperation } from './repo'
import { assertSafeWorkTree } from './trust/worktree'

// "Undo" for the last GitDesk action on each repository, kept in memory only.
// Each undoable action is wrapped in track(): it snapshots HEAD and the local
// branches and tags before and after, and remembers how to go back. Before
// undoing, the repository must still be exactly in the "after" state, so an
// undo never throws away work done since (in GitDesk or in a terminal).
// Branches checked out in other worktrees (coding agents, terminals) share the same
// refs but are never moved by an action run here: they are left out of the record.

interface Snapshot {
  /** Current branch (short name), null when HEAD is detached. */
  branch: string | null
  head: string | null
  /** refs/heads/* and refs/tags/* -> object id (tag objects are not peeled). */
  refs: Map<string, string>
  operation: RepoOperation
  /** refs/heads/* checked out in other worktrees of the repository. */
  elsewhere: Set<string>
}

export type UndoKind =
  /** Move the current branch back to where it was (`git reset --<mode>`). */
  | { kind: 'reset'; mode: 'soft' | 'mixed' | 'keep' }
  /** Go back to the previous checkout and put created/deleted/moved refs back. */
  | { kind: 'refs' }
  | { kind: 'rename'; from: string; to: string }

export interface UndoableAction {
  /** Label, or a function computing it once the action is done (e.g. from the new commit). */
  label: string | ((repo: string) => Promise<string>)
  undo: UndoKind
}

interface UndoRecord {
  label: string
  undo: UndoKind
  before: Snapshot
  after: Snapshot
  /** The refs the action moved (see ownChanges): those undo checks and puts back. */
  changes: RefChange[]
  /** The action stopped on conflicts and is still in progress: Abort is the way back. */
  pending: RepoOperation
}

const records = new Map<string, UndoRecord>()

const CHANGED = 'The repository changed since; nothing to undo safely.'

/** Branches named by `git worktree list --porcelain`, except `own` (this worktree's). */
export function worktreeBranches(porcelain: string, own: string | null): Set<string> {
  const found = new Set<string>()
  for (const line of porcelain.split('\n')) {
    const ref = line.startsWith('branch ') ? line.slice('branch '.length).trim() : ''
    if (ref.startsWith('refs/heads/') && ref !== own) found.add(ref)
  }
  return found
}

async function snapshot(repo: string): Promise<Snapshot> {
  const [refsOut, head, branch, operation, worktrees] = await Promise.all([
    git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags']),
    runGit(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] }),
    runGit(repo, ['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1] }),
    currentOperation(repo),
    runGit(repo, ['worktree', 'list', '--porcelain'], { okCodes: [0, 128] })
  ])
  const refs = new Map<string, string>()
  for (const line of refsOut.split('\n')) {
    const [name, id] = line.split(' ')
    if (name && id) refs.set(name, id)
  }
  const ref = branch.exitCode === 0 ? branch.stdout.trim() : ''
  const own = ref.startsWith('refs/heads/') ? ref : null
  return {
    branch: own ? own.slice('refs/heads/'.length) : null,
    head: head.exitCode === 0 ? head.stdout.trim() : null,
    refs,
    operation,
    elsewhere: worktreeBranches(worktrees.exitCode === 0 ? worktrees.stdout : '', own)
  }
}

interface RefChange {
  ref: string
  before: string | null
  after: string | null
}

function refChanges(before: Snapshot, after: Snapshot): RefChange[] {
  const names = new Set([...before.refs.keys(), ...after.refs.keys()])
  return [...names]
    .map((ref) => ({
      ref,
      before: before.refs.get(ref) ?? null,
      after: after.refs.get(ref) ?? null
    }))
    .filter((c) => c.before !== c.after)
}

/**
 * The refs an action run here moved: every change but those of branches checked out in
 * another worktree, which only that worktree (an agent, a terminal) can have moved.
 */
function ownChanges(before: Snapshot, after: Snapshot): RefChange[] {
  return refChanges(before, after).filter(
    (c) => !before.elsewhere.has(c.ref) && !after.elsewhere.has(c.ref)
  )
}

function sameHead(a: Snapshot, b: Snapshot): boolean {
  return a.branch === b.branch && a.head === b.head
}

/** Still in the state the action left: same HEAD, and the refs it touched unchanged. */
function unchangedSince(now: Snapshot, record: UndoRecord): boolean {
  if (!sameHead(now, record.after) || now.operation) return false
  return record.changes.every((c) => (now.refs.get(c.ref) ?? null) === c.after)
}

/** Runs a GitDesk action and remembers how to undo it. */
export async function track<T>(
  repo: string,
  action: UndoableAction,
  fn: () => Promise<T>
): Promise<T> {
  let before: Snapshot
  try {
    before = await snapshot(repo)
  } catch {
    records.delete(repo)
    return fn()
  }
  try {
    return await fn()
  } finally {
    // Also after a failure: a merge that stopped on conflicts is still undoable (by Abort).
    await remember(repo, action, before).catch(() => records.delete(repo))
  }
}

async function remember(repo: string, action: UndoableAction, before: Snapshot): Promise<void> {
  const after = await snapshot(repo)
  const started = !before.operation && after.operation ? after.operation : null
  const pending = action.undo.kind === 'reset' ? started : null
  const changes = ownChanges(before, after)
  // Nothing happened (failed, or "already up to date"): the previous record still holds.
  if (!pending && sameHead(before, after) && !changes.length) return
  let undo = action.undo
  // A commit that concludes a merge/cherry-pick: undo the whole operation, not just the commit.
  if (undo.kind === 'reset' && undo.mode === 'soft' && before.operation && !after.operation)
    undo = { kind: 'reset', mode: 'keep' }
  const label = typeof action.label === 'string' ? action.label : await action.label(repo)
  records.set(repo, { label, undo, before, after, changes, pending })
}

/** For Continue: a merge/rebase that was waiting on conflicts becomes undoable once done. */
export async function trackContinue<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const record = records.get(repo)
  try {
    return await fn()
  } finally {
    try {
      const now = await snapshot(repo)
      if (record?.pending && !now.operation) records.set(repo, concluded(record, now))
      else if (!record?.pending) records.delete(repo)
    } catch {
      records.delete(repo)
    }
  }
}

/** After an action that cannot be undone from here (push, Abort...). */
export function forget(repo: string): void {
  records.delete(repo)
}

/**
 * The record, once a pending merge/rebase is no longer in progress although GitDesk's
 * Continue / Abort were not used (it was finished or aborted in a terminal): finished
 * on the same branch, it becomes undoable as if concluded here; otherwise it is dropped.
 */
async function settled(repo: string): Promise<UndoRecord | undefined> {
  const record = records.get(repo)
  if (!record?.pending) return record
  const now = await snapshot(repo)
  if (now.operation) return record
  const { before } = record
  const finished =
    now.branch === before.branch &&
    !!now.head &&
    now.head !== before.head &&
    // A concluded merge or cherry-pick builds on top of where it started.
    (record.pending === 'rebase' ||
      !before.head ||
      (
        await runGit(repo, ['merge-base', '--is-ancestor', before.head, now.head], {
          okCodes: [0, 1]
        })
      ).exitCode === 0)
  if (records.get(repo) !== record) return records.get(repo) // replaced meanwhile
  if (!finished) {
    records.delete(repo)
    return undefined
  }
  const done = concluded(record, now)
  records.set(repo, done)
  return done
}

/** A pending record once its merge/rebase is done, in the state `now`. */
function concluded(record: UndoRecord, now: Snapshot): UndoRecord {
  return { ...record, after: now, changes: ownChanges(record.before, now), pending: null }
}

/** Null while there is nothing to undo, or while the action is still in progress (Abort is the way back). */
export async function undoInfo(repo: string): Promise<UndoInfo | null> {
  const record = await settled(repo).catch(() => records.get(repo))
  return record && !record.pending ? { label: record.label } : null
}

export async function undo(repo: string): Promise<void> {
  const record = await settled(repo)
  if (!record) throw new GitError('Nothing to undo.', null, '')

  if (record.pending) {
    throw new GitError(
      `The ${record.pending} is still in progress: use Abort to cancel it.`,
      null,
      ''
    )
  }
  const now = await snapshot(repo)
  if (!unchangedSince(now, record)) {
    records.delete(repo)
    throw new GitError(CHANGED, null, '')
  }
  await perform(repo, record) // on error the record stays, so it can be retried
  records.delete(repo)
}

async function perform(repo: string, record: UndoRecord): Promise<void> {
  const { undo, before, after } = record
  if (undo.kind === 'rename') {
    await git(repo, ['branch', '-m', undo.to, undo.from])
    return
  }
  let changes = record.changes
  if (undo.kind === 'reset') {
    if (before.branch !== after.branch) throw new GitError(CHANGED, null, '')
    if (undo.mode === 'keep') await assertSafeWorkTree(repo)
    if (before.head) await git(repo, ['reset', `--${undo.mode}`, before.head])
    else if (undo.mode === 'soft' && after.head)
      // Undo of the very first commit: the branch goes back to "no commits yet".
      await git(repo, ['update-ref', '-d', 'HEAD', after.head])
    else throw new GitError('This cannot be undone.', null, '')
    // reset moved the current branch; other refs are put back below.
    const current = after.branch ? `refs/heads/${after.branch}` : null
    changes = changes.filter((c) => c.ref !== current)
  } else if (!sameHead(before, after)) {
    if (!before.head) throw new GitError('This cannot be undone.', null, '')
    if (before.branch) await git(repo, ['switch', '--no-guess', before.branch])
    else await git(repo, ['switch', '--detach', before.head])
  }
  for (const c of changes) {
    // The old value makes update-ref refuse if the ref moved in between.
    if (c.before === null) await git(repo, ['update-ref', '-d', c.ref, c.after!])
    else await git(repo, ['update-ref', c.ref, c.before, c.after ?? ''])
  }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function short(ref: string): string {
  return /^[0-9a-f]{40,64}$/i.test(ref) ? ref.slice(0, 7) : ref
}

function quoted(text: string): string {
  const t = text.length > 60 ? text.slice(0, 57) + '…' : text
  return `“${t}”`
}

async function headSubject(repo: string): Promise<string> {
  return (await git(repo, ['log', '-1', '--format=%s', 'HEAD'])).trim()
}

export const actions = {
  commit: (amend: boolean): UndoableAction => ({
    label: async (repo) =>
      `${amend ? 'Undo amend of' : 'Undo commit'} ${quoted(await headSubject(repo))}`,
    undo: { kind: 'reset', mode: 'soft' }
  }),
  checkout: (what: string): UndoableAction => ({
    label: `Undo checkout of ${short(what)}`,
    undo: { kind: 'refs' }
  }),
  refs: (label: string): UndoableAction => ({ label, undo: { kind: 'refs' } }),
  rename: (from: string, to: string): UndoableAction => ({
    label: `Undo rename of ${from} to ${to}`,
    undo: { kind: 'rename', from, to }
  }),
  history: (label: string): UndoableAction => ({ label, undo: { kind: 'reset', mode: 'keep' } }),
  reset: (sha: string, mode: ResetMode): UndoableAction => ({
    label: `Undo reset to ${short(sha)}`,
    // After a hard reset, --keep moves back without touching the (clean) working copy.
    undo: { kind: 'reset', mode: mode === 'hard' ? 'keep' : mode === 'mixed' ? 'mixed' : 'soft' }
  }),
  short
}
