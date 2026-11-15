import { shell } from 'electron'
import type { HandlersOf } from '../../shared/api'
import type { HostingApi } from '../../shared/features/hosting'
import { addTokenAccount } from '../accounts'
import { forgetMisses } from '../avatars'
import { writeRepo } from '../queue'
import { requireRepo } from '../store'
import { actions, track } from '../undo'
import { cloneOrganization, hostedRepos, organizations, setWorkspaces } from './clone'
import { forgetRemoteIndex, remotesOf } from './context'
import { createBranchFromIssue, issuesOf } from './issues'
import { forgetLaunchpad, launchpad } from './launchpad'
import { createPullRequest, pullRequestDefaults } from './pulls'
import { configureTracker, removeTracker, testTracker, trackers } from './trackers'

/** Only https pages open from here (sign-in pages, pull requests, token settings…). */
function openUrl(url: unknown): Promise<void> {
  if (typeof url !== 'string' || url.length > 4000) throw new Error('Invalid link')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid link')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Only https links open from GitDesk.')
  return shell.openExternal(parsed.toString())
}

/** IPC handlers for git hosting accounts (GitHub, GitLab, Bitbucket, Azure DevOps), Launchpad, issues, workspaces. */
export const hostingHandlers: HandlersOf<HostingApi> = {
  hostingSignIn: async (input) => {
    const account = await addTokenAccount(input)
    forgetMisses()
    forgetLaunchpad()
    forgetRemoteIndex()
    return account
  },
  hostingRepos: (accountId) => hostedRepos(typeof accountId === 'string' ? accountId : null),
  hostingOrganizations: (accountId) => organizations(accountId),
  remotesOf: (repos) => remotesOf(repos),
  openHostingUrl: (url) => openUrl(url),

  pullRequestDefaults: (repo, branch) => pullRequestDefaults(requireRepo(repo), branch),
  createPullRequest: async (repo, input) => {
    const result = await createPullRequest(requireRepo(repo), input)
    forgetLaunchpad()
    return result
  },

  issues: (repo) => issuesOf(requireRepo(repo)),
  createBranchFromIssue: (repo, issue, opts) =>
    writeRepo(repo, (r) =>
      track(r, actions.refs('Undo create branch from issue'), () =>
        createBranchFromIssue(r, issue, { checkout: !!opts?.checkout })
      )
    ),
  issueTrackers: () => trackers(),
  configureIssueTracker: async (config) => {
    const result = await configureTracker(config)
    forgetLaunchpad()
    return result
  },
  testIssueTracker: (kind) => testTracker(kind),
  removeIssueTracker: (kind) => {
    forgetLaunchpad()
    return removeTracker(kind)
  },

  launchpad: (refresh) => launchpad(!!refresh),

  setWorkspaces: (workspaces) => setWorkspaces(workspaces),
  cloneOrganization: (accountId, org, workspaceId) =>
    cloneOrganization(accountId, org, typeof workspaceId === 'string' ? workspaceId : null)
}
