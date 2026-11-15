// Before GitDesk changes files (discard, stash -u, reset --hard, conflict resolution…):
// git must be about to work in the registered folder, not somewhere a repository's
// settings (core.worktree, a .git file) point it to.

import { lstatSync, realpathSync } from 'fs'
import { join, resolve } from 'path'
import { git, GitError } from '../git'
import { isInside, isNetworkPath } from './rules'

function real(p: string): string {
  try {
    return realpathSync.native(resolve(p))
  } catch {
    return resolve(p)
  }
}

const same = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

/**
 * Throws a clear error when git's effective work tree is not `repo`, or its git dir is
 * outside `repo` without a .git file (linked worktree, submodule) pointing to it, or on
 * another computer. Call it before any command that writes to the working copy.
 */
export async function assertSafeWorkTree(repo: string): Promise<void> {
  let out: string
  try {
    out = await git(repo, ['rev-parse', '--show-toplevel', '--absolute-git-dir'])
  } catch (e) {
    throw new GitError(
      `GitDesk did not change any file: git cannot find the working copy of ${repo} (${(e as Error).message})`,
      null,
      ''
    )
  }
  const [top = '', gitDir = ''] = out.split(/\r?\n/).map((l) => l.trim())
  const folder = real(repo)
  if (!top || !same(real(top), folder))
    throw new GitError(
      `GitDesk did not change any file: this repository's settings make git work in ` +
        `${top ? resolve(top) : 'no folder'} instead of ${repo} (core.worktree or a .git file).`,
      null,
      ''
    )
  if (!gitDir || isInside(real(gitDir), folder)) return
  let dotGitIsFile = false
  try {
    dotGitIsFile = lstatSync(join(repo, '.git')).isFile()
  } catch {
    /* no .git entry: git found the repository some other way */
  }
  if (!dotGitIsFile || isNetworkPath(gitDir))
    throw new GitError(
      `GitDesk did not change any file: git keeps this repository's data in ${resolve(gitDir)}, ` +
        `outside ${repo}.`,
      null,
      ''
    )
}
