// Contract: Git hosting accounts (GitHub, GitLab, Bitbucket, Azure DevOps), Launchpad, issues, workspaces.
// Add methods to HostingApi and list them in HOSTING_METHODS; the main process
// implements them in src/main/hosting/handlers.ts. Events the main process
// pushes to the UI go in HostingEvents (channel -> payload) and HOSTING_EVENTS.

import type { Account, AppState, Workspace } from '../types'

export type HostingProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure'
export type IssueTracker = 'jira' | 'linear'
/** Where an issue comes from. */
export type IssueSource = 'github' | 'gitlab' | IssueTracker

export const HOSTING_PROVIDERS: readonly HostingProvider[] = [
  'github',
  'gitlab',
  'bitbucket',
  'azure'
]

export const PROVIDER_LABELS: Record<HostingProvider | IssueTracker, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  azure: 'Azure DevOps',
  jira: 'Jira',
  linear: 'Linear'
}

/** Web host of each provider's cloud service. */
export const DEFAULT_HOSTS: Record<HostingProvider, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
  azure: 'dev.azure.com'
}

/** A personal access token sign-in (every provider; GitHub also has the device flow). */
export interface TokenSignIn {
  provider: HostingProvider
  /** GitHub Enterprise Server or self-managed GitLab host; empty = the cloud service. */
  host?: string
  token: string
  /** Bitbucket: your Atlassian email (API token) or Bitbucket username (app password). */
  username?: string
  /** Azure DevOps organization, as in dev.azure.com/<organization>. */
  organization?: string
}

/** A repository on a hosting service, for the clone dialog. */
export interface HostedRepo {
  provider: HostingProvider
  host: string
  /** "owner/repo"; GitLab "group/subgroup/repo"; Azure DevOps "organization/project/repo". */
  fullName: string
  description: string | null
  private: boolean
  fork: boolean
  /** ISO date of the last push or update, when known. */
  pushedAt: string | null
  cloneUrl: string
  webUrl: string
  /** Id of the account that can see it. */
  account: string
}

export interface HostedReposResult {
  repos: HostedRepo[]
  /** Accounts whose list could not be read. */
  errors: { account: string; error: string }[]
  /** Some account has more repositories than GitDesk lists (paste a link for the others). */
  truncated: boolean
}

/** Organization / group / workspace / project an account can clone in one go. */
export interface HostingOrg {
  /** What cloneOrganization takes: GitHub org login, GitLab group path, Bitbucket workspace slug, Azure project name. */
  name: string
  label: string
  kind: 'org' | 'user' | 'group' | 'workspace' | 'project'
}

export interface OrgCloneProgress {
  accountId: string
  org: string
  total: number
  /** Repositories handled so far (cloned, skipped or failed). */
  done: number
  /** Repository being cloned now. */
  current: string | null
  phase: string | null
  percent: number | null
}

export interface OrgCloneResult {
  state: AppState
  cloned: string[]
  /** Already in the clone folder (now followed and in the workspace). */
  skipped: string[]
  failed: { repo: string; error: string }[]
}

/** Where a registered repository's origin points. */
export interface RemoteInfo {
  /** null: a host GitDesk does not know (no account for it). */
  provider: HostingProvider | null
  host: string
  /** Repository path on the host ("owner/repo", "group/sub/repo", "org/project/repo"). */
  slug: string
  /** Browser URL of the repository, when the provider is known. */
  webUrl: string | null
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export interface NewPullRequest {
  /** Branch to merge (already pushed, or pushed first by the dialog). */
  head: string
  base: string
  title: string
  body: string
  draft: boolean
}

export interface PullRequestDefaults {
  provider: HostingProvider
  host: string
  slug: string
  /** Default branch on the provider (or origin/HEAD). */
  defaultBase: string | null
  /** Branches of origin a pull request can target. */
  bases: string[]
  /** The branch has an upstream (otherwise the dialog pushes it first). */
  hasUpstream: boolean
  /** Issue the branch was created from (createBranchFromIssue). */
  linkedIssue: LinkedIssue | null
  /** "Draft" exists on this provider. */
  supportsDraft: boolean
  /** Signed in to an account that can create it. */
  canCreate: boolean
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export interface Issue {
  source: IssueSource
  /** "#123" for GitHub / GitLab, the issue key ("PROJ-123", "ENG-12") for Jira / Linear. */
  key: string
  /** Number on GitHub / GitLab; null for Jira / Linear. */
  number: number | null
  title: string
  /** As the tracker names it: "open", "In Progress"… */
  state: string
  url: string
  assignee: string | null
  /** data: URL. */
  assigneeAvatar: string | null
  /** "owner/repo" (GitHub / GitLab), the Jira project key, the Linear team key. */
  container: string | null
  /** Unix seconds. */
  updatedAt: number
}

export interface IssuesResult {
  issues: Issue[]
  /** Sources that could not be read (shown, the others still list). */
  errors: string[]
}

/** What a branch remembers about the issue it was created from. */
export interface LinkedIssue {
  source: IssueSource
  key: string
  number: number | null
  title: string
  url: string
}

export interface IssueTrackers {
  jira: { site: string; email: string; user: string | null } | null
  linear: { user: string | null } | null
}

export type IssueTrackerConfig =
  { kind: 'jira'; site: string; email: string; token: string } | { kind: 'linear'; apiKey: string }

// ---------------------------------------------------------------------------
// Launchpad
// ---------------------------------------------------------------------------

export type LaunchpadGroup = 'review' | 'mine' | 'issue'
export type CiState = 'success' | 'failure' | 'pending'
export type ReviewState = 'approved' | 'changes_requested' | 'review_required' | 'commented'

export interface LaunchpadItem {
  /** Unique across the list. */
  id: string
  group: LaunchpadGroup
  source: HostingProvider | IssueTracker
  accountId: string | null
  /** e.g. "octocat on GitHub", "Jira (acme.atlassian.net)". */
  accountLabel: string
  host: string | null
  /** Repository slug on its host; Jira project / Linear team for their issues. */
  repo: string | null
  number: number | null
  /** "#12", "!12" (GitLab merge request), "PROJ-1"… */
  key: string
  title: string
  url: string
  author: string | null
  authorAvatar: string | null
  /** Unix seconds. */
  updatedAt: number
  draft: boolean
  /** CI of the pull request's head; null = unknown / none. */
  ci: CiState | null
  review: ReviewState | null
  state: string | null
  headRef: string | null
  baseRef: string | null
  /** For "Clone" when the repository is not in GitDesk yet. */
  cloneUrl: string | null
  /** Registered repository whose origin is this repository. */
  localRepo: string | null
}

export interface LaunchpadData {
  /** Unix seconds when the data was read from the providers. */
  generatedAt: number
  items: LaunchpadItem[]
  errors: { source: string; error: string }[]
}

// ---------------------------------------------------------------------------

export interface HostingApi {
  /** Adds an account from a personal access token (checked with the provider first). */
  hostingSignIn(input: TokenSignIn): Account
  /** Repositories of one account (by id), or of every account when null. */
  hostingRepos(accountId: string | null): HostedReposResult
  /** Organizations, groups, workspaces or projects of an account. */
  hostingOrganizations(accountId: string): HostingOrg[]
  /** Where each repository's origin points (null: no origin). */
  remotesOf(repos: string[]): Record<string, RemoteInfo | null>
  /** Opens a page of a hosting service or issue tracker GitDesk knows, in the browser. */
  openHostingUrl(url: string): void

  // Pull requests
  pullRequestDefaults(repo: string, branch: string): PullRequestDefaults
  createPullRequest(repo: string, input: NewPullRequest): { url: string }

  // Issues
  issues(repo: string): IssuesResult
  /** Creates (and optionally checks out) a branch named after the issue; returns its name. */
  createBranchFromIssue(repo: string, issue: LinkedIssue, opts: { checkout: boolean }): string
  issueTrackers(): IssueTrackers
  /** Checks the credentials with the tracker, then stores them encrypted. */
  configureIssueTracker(config: IssueTrackerConfig): IssueTrackers
  /** "Connected as …", or throws. */
  testIssueTracker(kind: IssueTracker): string
  removeIssueTracker(kind: IssueTracker): IssueTrackers

  // Launchpad
  /** Cached for 2 minutes unless `refresh`. */
  launchpad(refresh: boolean): LaunchpadData

  // Workspaces
  setWorkspaces(workspaces: Workspace[]): AppState
  /**
   * Clones every repository of an organization / group / workspace / project into
   * <clone folder>/<owner>/<repo> (skipping those already there), follows them and adds
   * them to the workspace. Progress: 'hosting:org-clone-progress'.
   */
  cloneOrganization(accountId: string, org: string, workspaceId: string | null): OrgCloneResult
}

export const HOSTING_METHODS = [
  'hostingSignIn',
  'hostingRepos',
  'hostingOrganizations',
  'remotesOf',
  'openHostingUrl',
  'pullRequestDefaults',
  'createPullRequest',
  'issues',
  'createBranchFromIssue',
  'issueTrackers',
  'configureIssueTracker',
  'testIssueTracker',
  'removeIssueTracker',
  'launchpad',
  'setWorkspaces',
  'cloneOrganization'
] as const satisfies readonly (keyof HostingApi)[]

export interface HostingEvents {
  'hosting:org-clone-progress': OrgCloneProgress
}

export const HOSTING_EVENTS = [
  'hosting:org-clone-progress'
] as const satisfies readonly (keyof HostingEvents)[]
