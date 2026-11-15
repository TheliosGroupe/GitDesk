// Contract: repository trust. Repository-local git settings that make git start programs
// or redirect where it reads and writes are ignored until the user trusts the repository.
// Add methods to TrustApi and list them in TRUST_METHODS; the main process implements
// them in src/main/trust/handlers.ts. Events go in TrustEvents and TRUST_EVENTS.

/**
 * What GitDesk does about a setting until the repository is trusted:
 * - ignored: git runs without it (GitDesk overrides it on every command);
 * - network: fetch, pull and push are paused;
 * - blocked: GitDesk does not run git in the repository at all.
 */
export type TrustEffect = 'ignored' | 'network' | 'blocked'

export interface TrustFinding {
  /** The setting ("core.fsmonitor"), or what was found ("hooks", "objects/info/alternates"). */
  key: string
  value: string
  /** What it does, in plain words. */
  text: string
  /** The file it was read from. */
  file: string
  effect: TrustEffect
  /** Set when it belongs to one of the repository's submodules (its name). */
  submodule?: string
}

/**
 * - clean: nothing risky found, git runs as usual;
 * - trusted: risky settings found, and you trusted them (or GitDesk created the repository);
 * - untrusted: GitDesk runs git without them;
 * - blocked: GitDesk does not run git here until you trust it.
 */
export type TrustLevel = 'clean' | 'trusted' | 'untrusted' | 'blocked'

export interface TrustStatus {
  repo: string
  level: TrustLevel
  findings: TrustFinding[]
  /** Cloned or created by GitDesk: trusted whatever its settings say. */
  createdByGitDesk: boolean
  /** Fetch, pull and push are refused until the repository is trusted. */
  networkPaused: boolean
}

export interface TrustApi {
  /** What GitDesk found in a repository's own settings, and whether it uses them. */
  trustStatus(repo: string): TrustStatus
  /** Lets git use the repository's current settings; new risky settings ask again. */
  trustRepo(repo: string): TrustStatus
  /** Goes back to ignoring the repository's risky settings. */
  untrustRepo(repo: string): TrustStatus
}

export const TRUST_METHODS = [
  'trustStatus',
  'trustRepo',
  'untrustRepo'
] as const satisfies readonly (keyof TrustApi)[]

export interface TrustEvents {
  /** A repository was trusted or untrusted. */
  'trust:changed': { repo: string }
}

export const TRUST_EVENTS = ['trust:changed'] as const satisfies readonly (keyof TrustEvents)[]
