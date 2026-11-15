// Branch names for issues. Pure (unit tested); git's own check runs in the main process.

import type { LinkedIssue } from '../../shared/features/hosting'

/** "Fix the Login page (iOS)!" -> "fix-the-login-page-ios", at most `max` characters. */
export function slugify(text: string, max = 40): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  let out = ''
  for (const w of words) {
    const next = out ? `${out}-${w}` : w
    if (next.length > max) {
      if (!out) out = w.slice(0, max)
      break
    }
    out = next
  }
  return out
}

/**
 * `123-short-title` for GitHub / GitLab issues, `feature/PROJ-123-short-title` for
 * Jira and Linear keys.
 */
export function branchNameForIssue(
  issue: Pick<LinkedIssue, 'source' | 'key' | 'number' | 'title'>
): string {
  const title = slugify(issue.title)
  if ((issue.source === 'github' || issue.source === 'gitlab') && issue.number !== null) {
    return title ? `${issue.number}-${title}` : `issue-${issue.number}`
  }
  const key = issue.key.replace(/[^A-Za-z0-9-]+/g, '').replace(/^-+|-+$/g, '') || 'issue'
  return title ? `feature/${key}-${title}` : `feature/${key}`
}

/** "name", then "name-2", "name-3"… until `taken` says no. */
export function uniqueBranchName(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name
  for (let i = 2; i < 100; i++) if (!taken(`${name}-${i}`)) return `${name}-${i}`
  return `${name}-${Date.now()}`
}
