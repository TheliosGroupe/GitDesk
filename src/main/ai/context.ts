// Reads what the prompts need from the repository (diffs, logs, conflict sides).
// Read-only git commands only.

import { promises as fs } from 'fs'
import { splitFilePatches } from '../../shared/features/ai-patch'
import { assertSafeRef, assertSha, git, GitError, runGit } from '../git'
import { repoFile } from '../paths'

// Paths from the UI are file names, never pathspec patterns.
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' }
const MAX_DIFF_BYTES = 8 * 1024 * 1024
/**
 * Options for every diff we send or apply: no external diff or textconv, standard a/ b/
 * prefixes whatever the user's config says, paths relative to the top level.
 */
export const DIFF_ARGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/'
]

/** Smaller outputs (stat, log, commit message) are capped at this many bytes. */
const MAX_TEXT_BYTES = 512 * 1024

export interface DiffText {
  text: string
  /** git wrote more than MAX_DIFF_BYTES: `text` stops before the files that did not fit. */
  truncated: boolean
  /** With `truncated`: the changed files whose diff is not in `text`. */
  unread: string[]
}

/**
 * `git diff` with DIFF_ARGS, read up to MAX_DIFF_BYTES. When it is cut, the partial last
 * file is dropped (a cut hunk must never be applied or described) and the files whose diff
 * is missing are listed from `git diff --name-only`.
 */
export async function diffText(
  repo: string,
  args: string[],
  maxBytes = MAX_DIFF_BYTES
): Promise<DiffText> {
  const r = await runGit(repo, ['diff', ...DIFF_ARGS, ...args], { maxBytes, env: LITERAL })
  if (!r.truncated) return { text: r.stdout, truncated: false, unread: [] }
  const at = r.stdout.lastIndexOf('\ndiff --git ')
  const text = at === -1 ? '' : r.stdout.slice(0, at + 1)
  const shown = new Set(splitFilePatches(text).map((p) => p.path))
  const names = await runGit(repo, ['diff', '--name-only', '-z', '--no-relative', ...args], {
    maxBytes: MAX_TEXT_BYTES,
    env: LITERAL
  })
  const unread = names.stdout.split('\0').filter((p) => p && !shown.has(p))
  return { text, truncated: true, unread }
}

/** The empty tree of this repository's hash algorithm (to diff a root commit). */
export async function emptyTree(repo: string): Promise<string> {
  return (await git(repo, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim()
}

export async function recentSubjects(repo: string, count = 10): Promise<string[]> {
  const r = await runGit(repo, ['log', `-${count}`, '--no-merges', '--format=%s'], {
    okCodes: [0, 128]
  })
  return r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : []
}

export async function currentBranch(repo: string): Promise<string | null> {
  const r = await runGit(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [0, 1] })
  return r.exitCode === 0 ? r.stdout.trim() || null : null
}

export async function headSha(repo: string): Promise<string | null> {
  const r = await runGit(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] })
  return r.exitCode === 0 ? r.stdout.trim() : null
}

export async function untrackedFiles(repo: string): Promise<string[]> {
  const out = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
  return out.split('\0').filter(Boolean)
}

const UNTRACKED_MAX_BYTES = 200 * 1024

/** Content of an untracked file: text (UTF-8) or null (binary, too large, unreadable). */
export async function readUntracked(repo: string, path: string): Promise<string | null> {
  try {
    const full = repoFile(repo, path)
    const stat = await fs.lstat(full)
    if (!stat.isFile() || stat.size > UNTRACKED_MAX_BYTES) return null
    const data = await fs.readFile(full)
    if (data.includes(0)) return null
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    return text
  } catch {
    return null
  }
}

/** A diff that adds the untracked file, like `git diff --no-index /dev/null file`. */
export function untrackedDiff(path: string, content: string | null): string {
  if (content === null)
    return `diff --git a/${path} b/${path}\nnew file mode 100644\nBinary files /dev/null and b/${path} differ\n`
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const noEol = !content.endsWith('\n') && content.length > 0
  return (
    `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n` +
    (lines.length ? `@@ -0,0 +1,${lines.length} @@\n` : '') +
    lines.map((l) => '+' + l).join('\n') +
    (lines.length ? '\n' : '') +
    (noEol ? '\\ No newline at end of file\n' : '')
  )
}

/** Verifies that `ref` names a commit; returns its full sha. */
export async function resolveCommit(repo: string, ref: string): Promise<string> {
  if (typeof ref !== 'string') throw new GitError('Invalid name', null, '')
  assertSafeRef(ref)
  const r = await runGit(
    repo,
    ['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`],
    {
      okCodes: [0, 1]
    }
  )
  if (r.exitCode !== 0)
    throw new GitError(`“${ref}” is not a branch or commit of this repository.`, null, '')
  return r.stdout.trim()
}

/** origin/HEAD, else origin/main, origin/master, main, master. */
export async function defaultBranch(repo: string): Promise<string> {
  const head = await runGit(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], {
    okCodes: [0, 1, 128]
  })
  if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim()
  for (const name of [
    'origin/main',
    'origin/master',
    'main',
    'master',
    'origin/develop',
    'develop'
  ]) {
    const r = await runGit(repo, ['rev-parse', '--verify', '-q', `${name}^{commit}`], {
      okCodes: [0, 1]
    })
    if (r.exitCode === 0) return name
  }
  throw new GitError(
    'Could not find the default branch (no origin/HEAD, main or master).',
    null,
    ''
  )
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string> {
  const r = await runGit(repo, ['merge-base', a, b], { okCodes: [0, 1] })
  if (r.exitCode !== 0 || !r.stdout.trim())
    throw new GitError('These branches have no common history.', null, '')
  return r.stdout.trim()
}

/** Output of a capped command, with a mark when it was cut. */
async function capped(repo: string, args: string[]): Promise<string> {
  const r = await runGit(repo, args, { maxBytes: MAX_TEXT_BYTES })
  return r.truncated ? r.stdout.slice(0, r.stdout.lastIndexOf('\n') + 1) + '[…]\n' : r.stdout
}

export async function logRange(repo: string, range: string, max = 100): Promise<string> {
  const out = await capped(repo, [
    'log',
    `--max-count=${max}`,
    '--reverse',
    '--no-merges',
    '--format=- %h %s%n%w(0,2,2)%b',
    range
  ])
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

export async function diffStat(repo: string, from: string, to: string): Promise<string> {
  // --no-textconv: counting lines must not run a conversion program the repository names.
  return (
    await capped(repo, [
      'diff',
      '--stat=120',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      from,
      to
    ])
  ).trim()
}

export interface CommitInfo {
  sha: string
  parent: string | null
  header: string
}

export async function commitInfo(repo: string, sha: string): Promise<CommitInfo> {
  assertSha(sha)
  const out = await capped(repo, ['show', '-s', '--format=%H%x00%P%x00%an <%ae>%x00%ad%x00%B', sha])
  const [full, parents, author, date, ...body] = out.split('\0')
  return {
    sha: full,
    parent: parents.trim() ? parents.trim().split(' ')[0] : null,
    header: `Commit ${full.slice(0, 10)} by ${author}, ${date}${parents.trim().includes(' ') ? ' (merge commit, diff against its first parent)' : ''}\nMessage:\n${body.join('\0').trim()}`
  }
}

/** "abc1234 subject" of a special ref (MERGE_HEAD…), or null when it does not exist. */
export async function refSubject(repo: string, ref: string): Promise<string | null> {
  const r = await runGit(repo, ['log', '-1', '--format=%h %s', ref, '--'], { okCodes: [0, 128] })
  return r.exitCode === 0 ? r.stdout.trim() || null : null
}
