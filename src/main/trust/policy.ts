// Repository trust: what GitDesk lets git use in each repository.
//
// Repositories GitDesk cloned or created are trusted. Any other repository is inspected
// (inspect.ts) before git runs there; until you trust it, the settings that would make
// git start programs are overridden on every command, network commands are paused when
// its settings change how git connects, and git does not run at all when it points to
// files on another computer. Trusting remembers the findings: new ones ask again.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'fs'
import { app } from 'electron'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import type { TrustLevel, TrustStatus } from '../../shared/features/trust'
import { runGit, setRepoPolicyResolver, type RepoPolicy } from '../git'
import { canonicalPath, findStoredPath, samePath } from '../paths'
import { loadState, setTrustRecord, trustRecord } from '../store'
import { parseConfigList, splitKey } from './gitconfig'
import { findRepoRoot, inspectRepo, stampsCurrent, type Inspection } from './inspect'
import type { Finding } from './rules'

/** Trust record of a repository GitDesk cloned or created: trusted whatever it contains. */
export const CREATED = 'created'

// ---------------------------------------------------------------------------
// Your own configuration (system and global), used in place of a repository's
// ---------------------------------------------------------------------------

export interface OuterConfig {
  /** The last value of a key in your system/global configuration. */
  last(key: string): string | undefined
  /** Every entry whose key matches, in the order git reads them. */
  matching(pattern: RegExp): { key: string; value: string | null }[]
}

export function outerConfigFrom(
  list: { scope: string; key: string; value: string | null }[]
): OuterConfig {
  const own = list.filter((e) => e.scope !== 'local' && e.scope !== 'worktree')
  return {
    last: (key) => {
      for (let i = own.length - 1; i >= 0; i--)
        if (own[i].key === key && own[i].value !== null) return own[i].value!
      return undefined
    },
    matching: (pattern) => own.filter((e) => pattern.test(e.key))
  }
}

const EMPTY_OUTER = outerConfigFrom([])

// ---------------------------------------------------------------------------
// The overrides
// ---------------------------------------------------------------------------

/** ssh with keepalives: a connection that went silent (sleep, VPN drop) fails within a minute. */
export const KEEPALIVE_SSH =
  'ssh -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4'

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export interface PolicyInput {
  repo: string
  /** null: no repository in this folder (clone, init). */
  inspection: Inspection | null
  trusted: boolean
  network: boolean
  outer: OuterConfig
  /** GitDesk's environment (GIT_SSH_COMMAND, GIT_SSH… you set yourself). */
  env: NodeJS.ProcessEnv
  /** An empty folder GitDesk owns, used as core.hooksPath. */
  noHooksDir: string
  /**
   * Your ~/.ssh/config sets its own timeouts or keepalives (ConnectTimeout, ServerAlive*):
   * ssh command-line options would replace them, so GitDesk adds none.
   */
  sshTimeoutsConfigured?: boolean
}

const DEFAULT_PROGRAM: Record<string, string> = {
  'gpg.program': 'gpg',
  'gpg.openpgp.program': 'gpg',
  'gpg.x509.program': 'gpgsm',
  'gpg.ssh.program': 'ssh-keygen'
}

function protocolDefault(name: string): string {
  if (name === 'ext' || name === 'fd') return 'never'
  return ['http', 'https', 'ssh', 'git'].includes(name) ? 'always' : 'user'
}

const list = (findings: Finding[]): string =>
  [...new Set(findings.map((f) => (f.submodule ? `${f.submodule}: ${f.key}` : f.key)))].join(', ')

/**
 * The `-c` arguments and environment for one git command. Settings that start programs
 * get your own value (system/global) or a neutral one; the rest of the repository's
 * settings work as usual. Pure: unit-tested.
 */
export function buildPolicy(p: PolicyInput): RepoPolicy {
  const args: string[] = []
  const env: Record<string, string> = {}
  const set = (key: string, value: string): void => {
    args.push('-c', `${key}=${value}`)
  }
  const active = p.inspection && !p.trusted ? p.inspection.findings : []
  const own = active.filter((f) => !f.submodule)
  // A key git's -c cannot name (a "=" in a subsection) cannot be overridden: stop instead.
  const blockedFindings = active.filter(
    (f) => f.effect === 'blocked' || (f.effect === 'ignored' && !f.submodule && /[=\n]/.test(f.key))
  )
  const policy: RepoPolicy = { args, env }
  // git looks no further up than the repository GitDesk inspected (a folder git does not
  // accept as a repository would otherwise send it to one above).
  const above = dirname(resolve(p.repo))
  if (above !== resolve(p.repo)) env.GIT_CEILING_DIRECTORIES = above
  if (blockedFindings.length)
    policy.blocked =
      `GitDesk did not run git in ${basename(p.repo)}: its settings point outside it ` +
      `(${list(blockedFindings)}). Open the repository to review them, and trust it ` +
      `if you expected this.`
  const networkFindings = active.filter((f) => f.effect === 'network')
  if (networkFindings.length) {
    policy.networkPaused =
      `Fetch, pull and push are paused for this repository until you trust it: its own ` +
      `settings change how git connects (${list(networkFindings)}).`
    // No download behind your back either: a partial clone fetches missing files on
    // demand (git 2.44 or later), Git LFS downloads file contents on checkout (they
    // stay pointer files until you trust it and check out again, or run git lfs pull).
    env.GIT_NO_LAZY_FETCH = '1'
    env.GIT_LFS_SKIP_SMUDGE = '1'
  }
  // Submodules with risky settings (or some GitDesk could not check): git does not go
  // into them.
  if (active.some((f) => f.submodule || f.key === 'submodules')) {
    set('submodule.recurse', 'false')
    set('fetch.recurseSubmodules', 'false')
    set('diff.ignoreSubmodules', 'all')
  }

  const keys = new Set(own.filter((f) => f.effect === 'ignored').map((f) => f.key))
  const outerOr = (key: string, fallback: string): string => p.outer.last(key) ?? fallback
  const filters = new Set<string>()
  let credentials = false
  for (const key of keys) {
    const { section, sub } = splitKey(key)
    if (/[=\n]/.test(key) || key === 'submodules') continue
    if (key === 'hooks') {
      if (!keys.has('core.hookspath') && !p.outer.last('core.hookspath'))
        set('core.hooksPath', p.noHooksDir)
    } else if (key === 'core.hookspath') set('core.hooksPath', outerOr(key, p.noHooksDir))
    else if (key === 'core.fsmonitor') set(key, outerOr(key, 'false'))
    else if (key === 'sequence.editor') set(key, outerOr(key, 'true'))
    else if (key === 'core.gitproxy')
      // GIT_PROXY_COMMAND wins over every core.gitProxy; empty means no proxy.
      env.GIT_PROXY_COMMAND = p.env.GIT_PROXY_COMMAND ?? ''
    else if (key === 'core.worktree') env.GIT_WORK_TREE = p.repo
    else if (key === 'core.sshcommand')
      continue // below
    else if (section === 'credential') credentials = true
    else if (key in DEFAULT_PROGRAM) set(key, outerOr(key, DEFAULT_PROGRAM[key]))
    else if (section === 'submodule') set(key, outerOr(key, 'checkout'))
    else if (key === 'protocol.allow') {
      // Per-protocol settings win over protocol.allow: git's own defaults back.
      for (const proto of ['http', 'https', 'ssh', 'git', 'file']) {
        const k = `protocol.${proto}.allow`
        if (!keys.has(k)) set(k, outerOr(k, proto === 'file' ? 'user' : 'always'))
      }
    } else if (section === 'protocol') set(key, outerOr(key, protocolDefault(sub ?? '')))
    else {
      // Program settings without a safe stand-in (textconv, filters, merge drivers,
      // diff.external, core.askPass…): empty, so git never starts the repository's.
      // Where git still needs one it fails ("cannot spawn"), it never runs something else.
      set(key, outerOr(key, ''))
      if (section === 'filter' && sub) filters.add(sub)
    }
  }
  // A filter marked required would refuse every file once its program is gone.
  for (const f of filters) {
    const k = `filter.${f}.required`
    if (p.inspection?.entries.some((e) => e.key === k)) set(k, outerOr(k, 'false'))
  }
  if (networkFindings.length)
    // No password for anything either (an older git's lazy fetch, Git LFS): it would go
    // through the repository's proxy or certificate settings. Network commands are
    // refused, so nothing else needs one; GitDesk's account token is not given either.
    set('credential.helper', '')
  else if (credentials) {
    // An empty helper clears the list (the repository's helpers, URL-scoped ones too);
    // then your own helpers come back, in order. GitDesk's account helper comes after.
    set('credential.helper', '')
    for (const e of p.outer.matching(/^credential\.(.+\.)?helper$/))
      if (e.value !== null && !/[=\n]/.test(e.key)) set(e.key, e.value)
  }

  // An https transfer that receives nothing for 2 minutes has stalled (sleep, VPN drop).
  // The variables win over every http.lowSpeed* setting: only when nobody chose one.
  const lowSpeed = /^http\.(.+\.)?lowspeed(limit|time)$/
  if (
    p.network &&
    !p.env.GIT_HTTP_LOW_SPEED_LIMIT &&
    !p.env.GIT_HTTP_LOW_SPEED_TIME &&
    !p.outer.matching(lowSpeed).length &&
    !p.inspection?.entries.some((e) => lowSpeed.test(e.key))
  ) {
    env.GIT_HTTP_LOW_SPEED_LIMIT = '1'
    env.GIT_HTTP_LOW_SPEED_TIME = '120'
  }

  // ssh: GIT_SSH_COMMAND wins over core.sshCommand. Yours always stays.
  if (!p.env.GIT_SSH_COMMAND) {
    const outerSsh = p.outer.last('core.sshcommand')
    const variant = p.outer.last('ssh.variant')
    const keepAlive =
      !p.sshTimeoutsConfigured && (!variant || variant === 'ssh' || variant === 'auto')
        ? KEEPALIVE_SSH
        : 'ssh'
    if (keys.has('core.sshcommand')) {
      if (outerSsh) set('core.sshCommand', outerSsh)
      else env.GIT_SSH_COMMAND = p.env.GIT_SSH ? shQuote(p.env.GIT_SSH) : keepAlive
    } else if (
      p.network &&
      !p.sshTimeoutsConfigured &&
      !outerSsh &&
      !p.env.GIT_SSH &&
      !p.inspection?.entries.some((e) => e.key === 'core.sshcommand')
    ) {
      env.GIT_SSH_COMMAND = keepAlive
    }
  }
  return policy
}

export function trustLevel(inspection: Inspection | null, trusted: boolean): TrustLevel {
  if (!inspection?.findings.length) return 'clean'
  if (trusted) return 'trusted'
  return inspection.findings.some((f) => f.effect === 'blocked') ? 'blocked' : 'untrusted'
}

// ---------------------------------------------------------------------------
// State: inspections, your configuration, trust records
// ---------------------------------------------------------------------------

const inspections = new Map<string, { inspection: Inspection | null; checked: number }>()
const keyOf = (dir: string): string =>
  process.platform === 'win32' ? resolve(dir).toLowerCase() : resolve(dir)

/** The inspection of a folder, redone when one of the files it read changed. */
export function inspectionOf(dir: string, fresh = false): Inspection | null {
  const key = keyOf(dir)
  const now = Date.now()
  const cached = inspections.get(key)
  if (cached && !fresh) {
    // Checked at most once a second: refreshes run several git commands at once.
    if (now - cached.checked < 1000) return cached.inspection
    if (cached.inspection && stampsCurrent(cached.inspection.stamps)) {
      cached.checked = now
      return cached.inspection
    }
  }
  const inspection = inspectRepo(resolve(dir))
  inspections.set(key, { inspection, checked: now })
  return inspection
}

const outerCache = new Map<string, { at: number; value: Promise<OuterConfig> }>()

/**
 * Your system and global git configuration as it applies to one repository (your
 * `includeIf "gitdir:…"` sections too, e.g. a work SSH key), read once every 30 s at most.
 * Only `git config` reads the repository: it runs nothing the repository names. Never
 * called for a repository whose settings point to another computer.
 */
function outerConfig(gitDir: string | null): Promise<OuterConfig> {
  const key = gitDir ? keyOf(gitDir) : ''
  const cached = outerCache.get(key)
  if (cached && Date.now() - cached.at < 30_000) return cached.value
  if (outerCache.size > 200) outerCache.clear()
  const dir = neutralDir()
  const read = (env: Record<string, string>): Promise<OuterConfig> =>
    runGit(dir, ['config', '--list', '--show-scope', '-z'], { okCodes: [0, 1], env }).then((r) =>
      outerConfigFrom(parseConfigList(r.stdout))
    )
  // Never a repository above GitDesk's folder.
  const alone = { GIT_CEILING_DIRECTORIES: dirname(dir) }
  // git matches includeIf "gitdir:" against the git dir as given and as the file system
  // names it. Repositories are registered under the file system's name (store.addRepos),
  // so git works with that one: the same here, whatever name the folder was reached by
  // (a Windows short name, /var for /private/var on macOS).
  const value = (
    gitDir ? read({ ...alone, GIT_DIR: canonicalPath(gitDir) }) : Promise.reject(new Error())
  )
    // A repository git cannot read: your configuration without it.
    .catch(() => read(alone))
    .catch(() => EMPTY_OUTER)
  outerCache.set(key, { at: Date.now(), value })
  return value
}

let sshConfigCache: { at: number; value: boolean } | null = null

/**
 * Your ~/.ssh/config sets ConnectTimeout or ServerAlive* itself (or includes other files,
 * which may): read at most once a minute.
 */
function sshTimeoutsConfigured(): boolean {
  if (sshConfigCache && Date.now() - sshConfigCache.at < 60_000) return sshConfigCache.value
  let value = false
  try {
    const text = readFileSync(join(homedir(), '.ssh', 'config'), 'utf8')
    value = /^[ \t]*(ConnectTimeout|ServerAliveInterval|ServerAliveCountMax|Include)\b/im.test(text)
  } catch {
    /* no ssh config */
  }
  sshConfigCache = { at: Date.now(), value }
  return value
}

let neutral: string | null = null

/** An empty folder GitDesk owns: the hooks folder of untrusted repositories. */
export function neutralDir(): string {
  if (neutral) return neutral
  let dir = join(app.getPath('userData'), 'no-hooks')
  try {
    mkdirSync(dir, { recursive: true })
    if (readdirSync(dir).length) throw new Error('not empty')
  } catch {
    dir = mkdtempSync(join(tmpdir(), 'gitdesk-no-hooks-'))
  }
  return (neutral = dir)
}

/** A repository's trust record, or its main repository's for a worktree GitDesk made. */
function recordFor(repo: string): string | null {
  const own = trustRecord(repo)
  if (own) return own
  const parents = loadState().worktreeParents
  const child = findStoredPath(Object.keys(parents), repo)
  return child ? trustRecord(parents[child]) : null
}

/**
 * The repository whose trust applies to a command run in `cwd`: the one git would find
 * from there (`cwd` or a folder above), or none for clone, which only creates one.
 * `git init` creates or re-initializes `cwd` itself.
 */
export function policyRoot(cwd: string, args: string[]): string | null {
  if (args[0] === 'clone') return null
  if (args[0] === 'init') return resolve(cwd)
  return findRepoRoot(cwd) ?? resolve(cwd)
}

function isTrusted(repo: string, inspection: Inspection | null): boolean {
  if (!inspection?.findings.length) return true
  const record = recordFor(repo)
  return record === CREATED || record === inspection.fingerprint
}

/**
 * The repository git uses for a registered folder: the folder itself, or the one above
 * it when the folder's own .git is not a repository git accepts (git looks further up).
 */
const rootOf = (repo: string): string => findRepoRoot(repo) ?? resolve(repo)

export function trustStatusOf(repo: string, fresh = false): TrustStatus {
  const root = rootOf(repo)
  const inspection = inspectionOf(root, fresh)
  const trusted = isTrusted(root, inspection)
  const level = trustLevel(inspection, trusted)
  return {
    repo,
    level,
    findings: inspection?.findings ?? [],
    createdByGitDesk: recordFor(root) === CREATED,
    networkPaused: !trusted && !!inspection?.findings.some((f) => f.effect === 'network')
  }
}

/** Trusts the repository's current findings. */
export function trustRepo(repo: string): TrustStatus {
  const root = rootOf(repo)
  const inspection = inspectionOf(root, true)
  if (trustRecord(root) !== CREATED && inspection) setTrustRecord(root, inspection.fingerprint)
  return trustStatusOf(repo)
}

export function untrustRepo(repo: string): TrustStatus {
  setTrustRecord(rootOf(repo), null)
  return trustStatusOf(repo, true)
}

/**
 * Marks a repository GitDesk cloned or initialized itself as trusted. Call it after
 * the clone or `git init` succeeded (not for an existing folder it only follows).
 */
export function markCreatedByGitDesk(repo: string): void {
  setTrustRecord(repo, CREATED)
}

let installed = false

/** Makes every git command GitDesk runs follow the repository's trust (idempotent). */
export function installTrustPolicy(): void {
  if (installed) return
  installed = true
  setRepoPolicyResolver(async (cwd, network, args) => {
    const dir = neutralDir()
    if (samePath(resolve(cwd), dir)) return null
    const root = policyRoot(cwd, args)
    const inspection = root ? inspectionOf(root) : null
    const trusted = !root || isTrusted(root, inspection)
    const findings = trusted ? [] : (inspection?.findings ?? [])
    // A blocked repository is not read at all (git would follow its paths).
    const blocked = findings.some((f) => f.effect === 'blocked')
    const needsOuter = !blocked && (network || findings.length > 0)
    return buildPolicy({
      repo: root ?? resolve(cwd),
      inspection,
      trusted,
      network,
      outer: needsOuter ? await outerConfig(inspection?.gitDir ?? null) : EMPTY_OUTER,
      env: process.env,
      noHooksDir: dir,
      sshTimeoutsConfigured: network && sshTimeoutsConfigured()
    })
  })
}
