import type {
  HostedRepo,
  HostingOrg,
  HostingProvider,
  Issue,
  LaunchpadItem,
  NewPullRequest
} from '../../../shared/features/hosting'
import type { PullRequest } from '../../../shared/types'
import type { RemoteRef } from '../remote'

export interface ClientConfig {
  provider: HostingProvider
  /** Web host of the account. */
  host: string
  token: string
  /** Bitbucket: email or user name for Basic auth. */
  username: string | null
  /** Azure DevOps organization. */
  organization: string | null
  /** Account id and label, copied into results. */
  accountId?: string
  accountLabel?: string
}

export interface ProviderUser {
  login: string
  name: string | null
  avatarUrl: string | null
}

export interface PullWithAvatar {
  pull: PullRequest
  avatarUrl: string | null
  /**
   * What identifies the author's picture when the shown name is not unique on the service
   * (Bitbucket nicknames and display names): their account id. Default: the author.
   */
  pictureKey?: string | null
}

/** What to fetch to check out a pull request. */
export interface PullSource {
  /** Remote URL to fetch from; null = origin. */
  url: string | null
  /** Ref on that remote, e.g. "refs/pull/12/head" or "refs/heads/feature". */
  ref: string
}

/**
 * Launchpad items and issues come back with `authorAvatar` / `assigneeAvatar` set to the
 * picture's http URL; the caller downloads them (the UI only shows data: images).
 */
export type LaunchpadPart = Omit<LaunchpadItem, 'localRepo'>

export interface ProviderClient {
  user(): Promise<ProviderUser>
  /** data: URL of a picture (best effort). */
  avatar(url: string): Promise<string | null>
  repos(accountId: string): Promise<{ repos: HostedRepo[]; truncated: boolean }>
  orgs(): Promise<HostingOrg[]>
  orgRepos(org: string, accountId: string): Promise<HostedRepo[]>
  pullRequests(ref: RemoteRef): Promise<PullWithAvatar[]>
  pullSource(ref: RemoteRef, number: number): Promise<PullSource>
  defaultBranch(ref: RemoteRef): Promise<string | null>
  createPullRequest(ref: RemoteRef, input: NewPullRequest): Promise<{ url: string }>
  /** Review requests, my open pull requests (with CI and review state), my issues. */
  launchpad(): Promise<LaunchpadPart[]>
  /** Open issues of the repository (GitHub, GitLab); [] elsewhere. */
  repoIssues(ref: RemoteRef): Promise<Issue[]>
  supportsDraft: boolean
}
