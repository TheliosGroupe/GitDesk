// Pull / merge requests of a repository's origin, for every provider.

import type { NewPullRequest, PullRequestDefaults } from '../../shared/features/hosting'
import type { PullRequest } from '../../shared/types'
import { tokensInOrder } from '../accounts'
import { GITHUB_COM_SCOPE, loginAvatars } from '../avatars'
import { assertSafeRef, git, GitError, runGit } from '../git'
import { listPullRequests } from '../github'
import * as repoOps from '../repo'
import { accountFor } from '../store'
import { accountsFor, originRef, providerName, withAccounts } from './context'
import { linkedIssue } from './issueLinks'
import type { PullWithAvatar } from './providers/types'
import type { RemoteRef } from './remote'

/** Which service a login belongs to, for the picture cache ("gitlab:gitlab.example.com"). */
function pictureScope(ref: RemoteRef): string {
  const org = ref.provider === 'azure' ? `/${ref.azure?.org ?? ''}` : ''
  return `${ref.provider}:${ref.host}${org}`
}

async function withPictures(pulls: PullWithAvatar[], scope: string): Promise<PullRequest[]> {
  const keyOf = (p: PullWithAvatar): string | null =>
    p.pictureKey ? `id:${p.pictureKey}` : p.pull.author
  const users = new Map<string, string>()
  for (const p of pulls) {
    const key = keyOf(p)
    if (key && p.avatarUrl) users.set(key, p.avatarUrl)
  }
  // The renderer only shows data: images, so pictures are downloaded (and cached) here.
  const pictures: Record<string, string | null> = await loginAvatars(users, scope).catch(() => ({}))
  return pulls.map((p) => {
    const key = keyOf(p)
    return { ...p.pull, authorAvatar: (key && pictures[key]) || null }
  })
}

async function githubComPulls(r: string, slug: string): Promise<PullRequest[]> {
  let lastError: unknown = null
  // Linked account first, then the others, then anonymously (public repositories).
  for (const token of [...tokensInOrder(accountFor(r)).map((a) => a.token), null]) {
    try {
      return await withPictures(await listPullRequests(slug, token), GITHUB_COM_SCOPE)
    } catch (e) {
      lastError = e
    }
  }
  throw lastError
}

function noAccount(ref: RemoteRef, what = 'its pull requests'): Error {
  const where = ref.provider === 'azure' ? `${ref.azure?.org} on Azure DevOps` : ref.host
  return new Error(`Add a ${providerName(ref)} account for ${where} in Settings to see ${what}.`)
}

/** Open pull requests of the origin; [] when origin is not on a known hosting service. */
export async function pullRequestsOf(r: string): Promise<PullRequest[]> {
  const ref = await originRef(r)
  if (!ref?.provider) return []
  if (ref.provider === 'github' && ref.host === 'github.com') return githubComPulls(r, ref.slug)
  const accounts = accountsFor(ref, r)
  if (!accounts.length)
    throw noAccount(ref, ref.provider === 'gitlab' ? 'its merge requests' : undefined)
  return withPictures(await withAccounts(accounts, (c) => c.pullRequests(ref)), pictureScope(ref))
}

async function resolve(r: string, rev: string): Promise<string> {
  const out = await runGit(r, ['rev-parse', '--verify', '-q', `${rev}^{commit}`], {
    okCodes: [0, 1, 128]
  })
  if (out.exitCode !== 0) throw new GitError(`${rev} is not a commit`, null, '')
  return out.stdout.trim()
}

async function isAncestor(r: string, a: string, b: string): Promise<boolean> {
  return (
    (await runGit(r, ['merge-base', '--is-ancestor', a, b], { okCodes: [0, 1] })).exitCode === 0
  )
}

/**
 * Checks out what was just fetched (FETCH_HEAD) as `branch`, like GitHub's `pr/<n>`:
 * an existing branch only moves forward, local commits are never dropped.
 */
async function checkoutFetched(r: string, branch: string): Promise<void> {
  const fetched = await resolve(r, 'FETCH_HEAD')
  const ref = `refs/heads/${branch}`
  const kept = new GitError(
    `${branch} has local commits that are not in the pull request: kept your branch as it is.`,
    null,
    ''
  )
  const head = await runGit(r, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [0, 1] })
  if (head.stdout.trim() === branch) {
    if (await isAncestor(r, fetched, 'HEAD')) return
    if (!(await isAncestor(r, 'HEAD', fetched))) throw kept
    await git(r, ['merge', '--ff-only', fetched])
    return
  }
  const exists = await runGit(r, ['show-ref', '--verify', '--quiet', ref], { okCodes: [0, 1] })
  if (exists.exitCode !== 0) {
    await git(r, ['switch', '-c', branch, fetched])
    return
  }
  const local = await resolve(r, ref)
  if (local !== fetched && (await isAncestor(r, local, fetched)))
    await git(r, ['update-ref', ref, fetched, local])
  await git(r, ['switch', branch])
  if (!(await isAncestor(r, fetched, ref))) throw kept
}

/** Fetches a pull request into `pr/<number>` and checks it out, whatever the provider. */
export async function checkoutPullRequestOf(r: string, number: number): Promise<void> {
  if (!Number.isInteger(number) || number <= 0 || number > 1e9)
    throw new GitError(`Invalid pull request number ${number}`, null, '')
  const ref = await originRef(r)
  if (!ref?.provider || ref.provider === 'github') return repoOps.checkoutPullRequest(r, number)
  const source =
    ref.provider === 'gitlab'
      ? { url: null, ref: `refs/merge-requests/${number}/head` }
      : await withAccounts(accountsFor(ref, r), (c) => c.pullSource(ref, number)).catch((e) => {
          if (!accountsFor(ref, r).length) throw noAccount(ref)
          throw e
        })
  // The ref comes from the provider's API: a plain ref name, never a refspec (no ":" or "+").
  if (!/^refs\/[^\s:~^?*[\\]+$/.test(source.ref) || source.ref.includes('..'))
    throw new GitError(`Unexpected pull request ref ${source.ref}`, null, '')
  if (source.url && !/^https:\/\/[^\s]+$/.test(source.url))
    throw new GitError(`Unexpected fork URL ${source.url}`, null, '')
  await git(r, ['fetch', '--', source.url ?? 'origin', source.ref])
  await checkoutFetched(r, `pr/${number}`)
}

async function originBranches(r: string): Promise<string[]> {
  const out = await git(r, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
  return out
    .split('\n')
    .map((s) => s.trim().replace(/^origin\//, ''))
    .filter((s) => s && s !== 'HEAD' && s !== 'origin')
}

async function originHead(r: string): Promise<string | null> {
  const out = await runGit(r, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], {
    okCodes: [0, 1, 128]
  })
  return out.exitCode === 0 ? out.stdout.trim().replace(/^origin\//, '') || null : null
}

export async function pullRequestDefaults(r: string, branch: string): Promise<PullRequestDefaults> {
  if (typeof branch !== 'string') throw new Error('Branch missing')
  assertSafeRef(branch)
  const ref = await originRef(r)
  if (!ref?.provider)
    throw new Error(
      'origin is not on GitHub, GitLab, Bitbucket or Azure DevOps (or has no account).'
    )
  const accounts = accountsFor(ref, r)
  const [bases, head, upstream, providerDefault] = await Promise.all([
    originBranches(r),
    originHead(r),
    runGit(r, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], {
      okCodes: [0, 128]
    }),
    accounts.length
      ? withAccounts(accounts, (c) => c.defaultBranch(ref)).catch(() => null)
      : Promise.resolve(null)
  ])
  const defaultBase =
    providerDefault ??
    head ??
    (bases.includes('main') ? 'main' : bases.includes('master') ? 'master' : null)
  return {
    provider: ref.provider,
    host: ref.host,
    slug: ref.slug,
    defaultBase,
    bases: bases.filter((b) => b !== branch),
    hasUpstream: upstream.exitCode === 0 && !!upstream.stdout.trim(),
    linkedIssue: linkedIssue(r, branch),
    supportsDraft: true,
    canCreate: accounts.length > 0
  }
}

export async function createPullRequest(
  r: string,
  input: NewPullRequest
): Promise<{ url: string }> {
  const head = String(input?.head ?? '')
  const base = String(input?.base ?? '')
  const title = String(input?.title ?? '').trim()
  assertSafeRef(head)
  assertSafeRef(base)
  if (!title) throw new Error('A pull request needs a title.')
  if (head === base) throw new Error('Pick a base branch other than the branch itself.')
  const ref = await originRef(r)
  if (!ref?.provider) throw new Error('origin is not on a hosting service GitDesk knows.')
  const accounts = accountsFor(ref, r)
  if (!accounts.length) throw noAccount(ref, 'create pull requests')
  return withAccounts(accounts, (c) =>
    c.createPullRequest(ref, {
      head,
      base,
      title: title.slice(0, 300),
      body: String(input.body ?? '').slice(0, 60_000),
      draft: !!input.draft
    })
  )
}
