// git worktrees: listing, adding, removing, and opening them as repository tabs.

import { existsSync, promises as fs, readdirSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { branchSlug, type AddWorktreeOptions, type Worktree } from '../../shared/features/terminal'
import type { AppState } from '../../shared/types'
import { assertBranchName, assertSafeRef, git, runGit } from '../git'
import { findSamePath, findStoredPath, samePath } from '../paths'
import { exclusive } from '../queue'
import { recentSnapshot } from '../repo'
import { addRepos, loadState, removeRepo, requireRepo, saveState } from '../store'
import { unwatchRepo } from '../watcher'
import { parseWorktreePorcelain, uniqueName } from './argv'
import { killTerminalsIn } from './pty'

/** Uncommitted changes in a working tree (untracked files included); null when unreadable. */
export async function changeCount(dir: string): Promise<number | null> {
  try {
    const out = await git(dir, ['status', '--porcelain', '--untracked-files=normal'])
    return out.split('\n').filter((l) => l.trim()).length
  } catch {
    return null
  }
}

/**
 * Changes of the worktree a repository view just refreshed (its status is a few seconds
 * old at most), counted like the view's own "N changes"; null when there is none.
 */
function viewChangeCount(path: string): number | null {
  const st = recentSnapshot(path, 3000)?.status
  if (!st) return null
  return new Set([...st.staged, ...st.unstaged, ...st.conflicted].map((f) => f.path)).size
}

/**
 * The worktrees of `repo`. `fresh`: count every worktree's changes now (what removal
 * checks); otherwise the one shown in `repo`'s view reuses that view's last refresh.
 */
export async function listWorktrees(repo: string, fresh = false): Promise<Worktree[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain'])
  const raw = parseWorktreePorcelain(out)
  return Promise.all(
    raw.map(async (w, i) => {
      const path = resolve(w.path)
      const usable = !w.bare && !w.prunable && existsSync(path)
      // git names the folder as the file system does (long names, links followed): the
      // repository may be registered under another name of it.
      const isCurrent = samePath(path, repo)
      const counted = usable && isCurrent && !fresh ? viewChangeCount(repo) : null
      return {
        path,
        head: w.head,
        branch: w.branch,
        detached: w.detached,
        locked: w.locked,
        lockReason: w.lockReason,
        prunable: w.prunable || (!w.bare && !existsSync(path)),
        isMain: i === 0,
        isCurrent,
        changes: usable ? (counted ?? (await changeCount(path))) : null
      }
    })
  )
}

/**
 * A worktree of `repo` given by the UI: it must be one git lists (under any name of its
 * folder: a short name, a link to it).
 */
export async function requireWorktree(repo: string, path: unknown): Promise<Worktree> {
  if (typeof path !== 'string' || !path) throw new Error('Worktree path missing')
  // Fresh counts: removal refuses a worktree with uncommitted changes.
  const list = await listWorktrees(repo, true)
  const match = findSamePath(
    list.map((w) => w.path),
    resolve(path)
  )
  const found = list.find((w) => w.path === match)
  if (!found) throw new Error(`Not a worktree of this repository: ${path}`)
  return found
}

/** Main working tree of the repository `repo` belongs to. */
async function mainWorktree(repo: string): Promise<string> {
  const list = parseWorktreePorcelain(await git(repo, ['worktree', 'list', '--porcelain']))
  return list[0] ? resolve(list[0].path) : repo
}

function isEmptyDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && readdirSync(p).length === 0
  } catch {
    return false
  }
}

/**
 * Default folder of a new worktree: <worktreeRoot>/<repo name>/<branch slug> when the
 * setting is set, else <repo parent>/<repo name>.worktrees/<branch slug>. Made unique.
 */
export async function defaultWorktreePath(repo: string, branch: string): Promise<string> {
  const main = await mainWorktree(repo)
  const name = basename(main)
  const root = loadState().settings.worktreeRoot
  const parent =
    root && isAbsolute(root) ? join(root, name) : join(dirname(main), `${name}.worktrees`)
  return uniqueName(join(parent, branchSlug(branch)), (p) => existsSync(p))
}

function checkTargetFolder(path: string): void {
  if (existsSync(path) && !isEmptyDir(path)) throw new Error(`${path} already exists`)
}

/** Runs `git worktree add`; the caller holds the repository's write queue. */
export async function gitAddWorktree(
  repo: string,
  path: string,
  branch: string,
  createBranch: boolean,
  startPoint: string | null
): Promise<void> {
  const args = createBranch
    ? ['worktree', 'add', '-b', branch, '--', path, ...(startPoint ? [startPoint] : [])]
    : ['worktree', 'add', '--', path, branch]
  await git(repo, args)
}

export async function addWorktree(
  repoArg: unknown,
  options: AddWorktreeOptions
): Promise<{ state: AppState; path: string }> {
  const repo = requireRepo(repoArg)
  if (!options || typeof options !== 'object') throw new Error('Options missing')
  const { createBranch, startPoint } = options
  const branch = typeof options.branch === 'string' ? options.branch.trim() : ''
  await assertBranchName(repo, branch)
  if (startPoint !== null && startPoint !== undefined) {
    if (typeof startPoint !== 'string') throw new Error('Invalid start point')
    assertSafeRef(startPoint)
  }
  let path: string
  if (options.path) {
    if (typeof options.path !== 'string' || !isAbsolute(options.path))
      throw new Error('The worktree folder must be an absolute path')
    path = resolve(options.path)
    checkTargetFolder(path)
  } else {
    path = await defaultWorktreePath(repo, branch)
  }
  await exclusive(repo, () =>
    gitAddWorktree(repo, path, branch, !!createBranch, createBranch ? startPoint || null : null)
  )
  return { state: loadState(), path }
}

/** Removes the worktree from the repository list, its tab and worktreeParents. */
function forgetFolder(path: string): AppState {
  const state = loadState()
  const registered = findStoredPath(state.repos, path)
  if (!registered) return state
  unwatchRepo(registered)
  return removeRepo(registered)
}

/** Lets the terminals of a folder exit before the folder is deleted (Windows locks it). */
async function releaseFolder(path: string): Promise<void> {
  killTerminalsIn(path)
  const registered = findStoredPath(loadState().repos, path)
  if (registered) unwatchRepo(registered)
  await new Promise((r) => setTimeout(r, process.platform === 'win32' ? 400 : 50))
}

/**
 * Links to folders inside `dir` (symlinks, and Windows directory junctions, which Node
 * reports as symlinks), without following any. Relative to `dir`, with "/", sorted.
 * `outsideOnly`: only links whose target is outside `dir` (pnpm's links inside
 * node_modules point to other folders of the same tree, deleted with it anyway).
 */
export async function folderLinks(
  dir: string,
  opts: { outsideOnly?: boolean } = {}
): Promise<string[]> {
  const found: string[] = []
  const root = opts.outsideOnly ? await fs.realpath(dir).catch(() => resolve(dir)) : ''
  const isOutside = (real: string): boolean => {
    const rel = relative(root, real)
    return rel === '' ? false : rel.startsWith('..') || isAbsolute(rel)
  }
  const visit = async (folder: string, next: string[]): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(folder, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await fs.stat(full).catch(() => null)
        if (!target?.isDirectory()) continue
        if (opts.outsideOnly) {
          const real = await fs.realpath(full).catch(() => null)
          if (real && !isOutside(real)) continue
        }
        found.push(relative(dir, full).replace(/\\/g, '/'))
      } else if (entry.isDirectory()) next.push(full)
    }
  }
  // Level by level, a few folders at a time: big dependency trees list much faster.
  for (let level = [dir]; level.length;) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += 16)
      await Promise.all(level.slice(i, i + 16).map((f) => visit(f, next)))
    level = next
  }
  return found.sort()
}

/**
 * git for Windows deletes a worktree's directory junctions as if they were folders, so
 * their targets, outside the worktree, would be emptied. Removes the links themselves
 * first (their targets are kept). Returns whether one of them was tracked by git, and
 * how to put them back if the removal fails after all.
 */
async function unlinkFolderLinks(
  dir: string
): Promise<{ tracked: boolean; restore: () => Promise<void> }> {
  const none = { tracked: false, restore: async () => {} }
  if (process.platform !== 'win32') return none // git removes links there, not their targets
  // A link to a folder of the worktree itself only leads to what is deleted anyway.
  const links = await folderLinks(dir, { outsideOnly: true })
  if (!links.length) return none
  const tracked = await git(dir, ['ls-files', '-z', '--', ...links], {
    env: { GIT_LITERAL_PATHSPECS: '1' }
  }).catch(() => '')
  const removed: { full: string; target: string }[] = []
  for (const link of links) {
    const full = join(dir, link)
    const target = await fs.realpath(full)
    try {
      await fs.unlink(full)
    } catch {
      await fs.rmdir(full) // a directory symlink; removes the link only
    }
    removed.push({ full, target })
  }
  const restore = async (): Promise<void> => {
    for (const { full, target } of removed)
      await fs.symlink(target, full, 'junction').catch(() => {})
  }
  return { tracked: tracked.split('\0').some(Boolean), restore }
}

export async function removeWorktree(
  repoArg: unknown,
  pathArg: unknown,
  force: boolean
): Promise<AppState> {
  const repo = requireRepo(repoArg)
  const wt = await requireWorktree(repo, pathArg)
  if (wt.isMain) throw new Error('The main working tree cannot be removed')
  const main = await mainWorktree(repo)
  // Run from the main working tree: the removed one may be the repository asked from.
  const cwd = existsSync(main) ? main : repo
  await exclusive(repo, async () => {
    if (wt.prunable) {
      await git(cwd, ['worktree', 'prune'])
      return
    }
    if (!force && wt.changes) {
      throw new Error(
        `${wt.path} has ${wt.changes} uncommitted change${wt.changes === 1 ? '' : 's'}. ` +
          'Remove it anyway to discard them.'
      )
    }
    // Refused before its folder links are touched, as git would refuse it.
    if (!force && wt.locked)
      throw new Error(`${wt.path} is locked. Unlock it first, or remove it anyway.`)
    await releaseFolder(wt.path)
    // Removing a tracked link is a change git would refuse; the checks above already passed.
    const links = await unlinkFolderLinks(wt.path)
    const flags = force || links.tracked ? (wt.locked ? ['--force', '--force'] : ['--force']) : []
    try {
      await git(cwd, ['worktree', 'remove', ...flags, '--', wt.path])
    } catch (e) {
      // Still there (a file held open, ...): give it its links back.
      if (existsSync(wt.path)) await links.restore()
      throw e
    }
  })
  return forgetFolder(wt.path)
}

export async function pruneWorktrees(repoArg: unknown): Promise<void> {
  const repo = requireRepo(repoArg)
  await exclusive(repo, () => git(repo, ['worktree', 'prune']))
}

/**
 * Registers a folder (a worktree of `repo`) as a repository and remembers which main
 * repository it belongs to (AppState.worktreeParents).
 */
export async function registerWorktree(repo: string, path: string): Promise<AppState> {
  const main = await mainWorktree(repo).catch(() => repo)
  let state = addRepos([path])
  const stored = findStoredPath(state.repos, path)!
  if (samePath(stored, main)) return state
  const parent = findStoredPath(state.repos, main) ?? repo
  state = saveState({ ...state, worktreeParents: { ...state.worktreeParents, [stored]: parent } })
  return state
}

export async function openWorktree(repoArg: unknown, pathArg: unknown): Promise<AppState> {
  const repo = requireRepo(repoArg)
  const wt = await requireWorktree(repo, pathArg)
  if (wt.prunable || !existsSync(wt.path)) throw new Error(`${wt.path} no longer exists`)
  return registerWorktree(repo, wt.path)
}

/** Current branch of a working tree, or null when detached. */
export async function currentBranch(repo: string): Promise<string | null> {
  const r = await runGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [0, 1] })
  return r.exitCode === 0 ? r.stdout.trim() || null : null
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const r = await runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    okCodes: [0, 1]
  })
  return r.exitCode === 0
}
