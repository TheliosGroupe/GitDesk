// Issues for a repository (GitHub / GitLab issues of origin, Jira / Linear issues assigned to me),
// and branches created from them.

import type { Issue, IssuesResult, LinkedIssue } from '../../shared/features/hosting'
import { assertBranchName, runGit } from '../git'
import * as repoOps from '../repo'
import { accountsFor, originRef, withAccounts } from './context'
import { branchNameForIssue, uniqueBranchName } from './branchName'
import { cachedPicture, pool } from './http'
import { cleanIssue, linkIssue } from './issueLinks'
import { trackerIssues } from './trackers'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Replaces picture URLs with data: URLs (the UI only shows those). */
export async function withIssuePictures(issues: Issue[]): Promise<Issue[]> {
  return pool(issues, 6, async (i) => ({
    ...i,
    assigneeAvatar:
      typeof i.assigneeAvatar !== 'string'
        ? null
        : i.assigneeAvatar.startsWith('data:image/')
          ? i.assigneeAvatar
          : await cachedPicture(i.assigneeAvatar)
  }))
}

export async function issuesOf(r: string): Promise<IssuesResult> {
  const errors: string[] = []
  const ref = await originRef(r)
  const repoIssues: Promise<Issue[]> =
    ref && (ref.provider === 'github' || ref.provider === 'gitlab') && accountsFor(ref, r).length
      ? withAccounts(accountsFor(ref, r), (c) => c.repoIssues(ref)).catch((e) => {
          errors.push(`${ref.provider === 'github' ? 'GitHub' : 'GitLab'}: ${message(e)}`)
          return []
        })
      : Promise.resolve([])
  const [own, trackers] = await Promise.all([repoIssues, trackerIssues()])
  errors.push(...trackers.errors)
  const issues = [...own, ...trackers.issues].sort((a, b) => b.updatedAt - a.updatedAt)
  return { issues: await withIssuePictures(issues), errors }
}

async function branchExists(r: string, name: string): Promise<boolean> {
  const out = await runGit(r, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], {
    okCodes: [0, 1]
  })
  return out.exitCode === 0
}

/** Creates a branch named after the issue (at HEAD), remembers the link, returns the name. */
export async function createBranchFromIssue(
  r: string,
  rawIssue: LinkedIssue,
  opts: { checkout: boolean }
): Promise<string> {
  const issue = cleanIssue(rawIssue)
  const wanted = branchNameForIssue(issue)
  await assertBranchName(r, wanted)
  const taken = new Set<string>()
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? wanted : `${wanted}-${i}`
    if (await branchExists(r, candidate)) taken.add(candidate)
    else break
  }
  const name = uniqueBranchName(wanted, (n) => taken.has(n))
  await repoOps.createBranch(r, name, null, !!opts?.checkout)
  linkIssue(r, name, issue)
  return name
}
