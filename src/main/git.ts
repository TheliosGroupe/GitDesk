import { execFile, spawn, type ChildProcess } from 'child_process'
import { statSync } from 'fs'
import { homedir } from 'os'
import { delimiter, isAbsolute, join } from 'path'
import { findExecutable, userPath } from './terminal/resolve'

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface GitAuth {
  /** Account id (a github.com account's id is its login). */
  login: string
  token: string
  /** User name git sends; defaults to the account's (see setGitIdentityResolver). */
  username?: string
  /** Hosts ("host" or "host:port") the token may go to, over https only; defaults to the account's. */
  hosts?: string[]
}

/** How git authenticates as one account: the user name to send and the only hosts to answer for. */
export interface GitIdentity {
  username: string
  hosts: string[]
}

interface RunOptions {
  /** Written to git's stdin (commit messages, patches). */
  input?: string
  /** Exit codes that count as success; defaults to [0]. */
  okCodes?: number[]
  /** Abort after this many bytes of stdout (large diffs). */
  maxBytes?: number
  /** Hosting credentials; defaults to the account linked to `cwd` (see setAuthResolver). */
  auth?: GitAuth | null
  /** Receives stderr while git runs (clone progress). */
  onStderr?: (text: string) => void
  /** Extra environment variables (e.g. GIT_SEQUENCE_EDITOR for a scripted rebase). */
  env?: Record<string, string>
  /**
   * Stops git (and the programs it started) after this long without any output. Network
   * commands get a default (NETWORK_TIMEOUTS); 0 turns it off.
   */
  timeoutMs?: number
  /** Stops git when aborted (a Cancel button). */
  signal?: AbortSignal
}

export interface RunResult {
  stdout: string
  exitCode: number
  truncated: boolean
}

// -c options applied to every invocation: unquoted UTF-8 paths (accents in
// file names), no colors, no pagers, and never the transports that run a command
// taken from the remote address itself (ext::, fd::), whatever a repository allows.
// External diff programs and textconv are turned off per command (see hardenArgs).
const BASE_ARGS = [
  '-c',
  'core.quotepath=false',
  '-c',
  'color.ui=false',
  '-c',
  'core.pager=cat',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.fd.allow=never'
]

/**
 * Commands that show file contents never run a repository-defined conversion
 * (diff.<driver>.textconv) or external diff program (diff.external, diff.<driver>.command):
 * GitDesk shows git's own diff. Added right after the subcommand. Exported for tests.
 */
export function hardenArgs(args: string[]): string[] {
  const [cmd, ...rest] = args
  if (cmd === 'diff' || cmd === 'log' || cmd === 'show')
    return [cmd, '--no-textconv', '--no-ext-diff', ...rest]
  if (cmd === 'blame') return [cmd, '--no-textconv', ...rest]
  return args
}

/** Commands that talk to a remote. Exported for tests. */
export function isNetworkCommand(args: string[]): boolean {
  const [cmd, sub] = args
  if (['fetch', 'pull', 'push', 'ls-remote', 'clone', 'submodule'].includes(cmd)) return true
  return cmd === 'remote' && ['update', 'prune', 'show', 'set-head'].includes(sub)
}

// A fetch that never finishes would hold the repository's write queue (and Sync) forever.
// Stalled connections are caught sooner by the low-speed limit and ssh keepalives
// (trust/policy.ts); these are the backstop. They are idle times: each line git prints
// (fetch, pull and push report their progress, see progressArgs) starts them again, so
// a long transfer that keeps moving is never cut. Push waits longest: a Git LFS pre-push
// hook uploads large files without printing anything. Clone has none: it shows progress
// and can be cancelled (cancelNetworkCommands).
export const NETWORK_TIMEOUTS: Record<string, number> = {
  fetch: 10 * 60_000,
  'ls-remote': 2 * 60_000,
  remote: 2 * 60_000,
  pull: 10 * 60_000,
  push: 30 * 60_000
}

/**
 * fetch, pull and push with --progress, so git reports progress through its pipes and
 * the idle timer sees a transfer that is still moving. Exported for tests.
 */
export function progressArgs(args: string[]): string[] {
  const [cmd, ...rest] = args
  if (!['fetch', 'pull', 'push'].includes(cmd)) return args
  const until = rest.indexOf('--')
  const options = until < 0 ? rest : rest.slice(0, until)
  if (options.some((a) => ['-q', '--quiet', '--progress', '--no-progress'].includes(a))) return args
  return [cmd, '--progress', ...rest]
}

const PROGRESS =
  /^(remote: )?(\S[^:]*: +\d+% \(\d+\/\d+\)|(Enumerating|Counting|Compressing) objects: \d+|Total \d+ \(delta|Delta compression using)/

/** git's stderr without its progress lines (what --progress added). Exported for tests. */
export function withoutProgress(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map(
      (line) =>
        line
          .split('\r')
          .filter((part) => part.trim())
          .pop() ?? ''
    )
    .filter((line) => line.trim() && !PROGRESS.test(line))
    .join('\n')
}

// Credential helper for repositories linked to a GitDesk account. It answers
// only for https and only for the hosts of that one account (github.com, a GitHub
// Enterprise or GitLab host, bitbucket.org, dev.azure.com…), and reads the user
// name and token from the environment, so the token never appears in a command
// line, a remote URL or a config file, and git does not store it.
// `credential.helper=` first clears the user's helpers (e.g. Git Credential
// Manager) for that one command.
export const CREDENTIAL_HELPER = [
  '!f() { p=0; h=0;',
  'while IFS= read -r l && [ -n "$l" ]; do',
  'case "$l" in protocol=https) p=1;;',
  'host=*) for x in $GITDESK_CRED_HOSTS; do [ "$l" = "host=$x" ] && h=1; done;; esac;',
  'done;',
  '[ "$1" = get ] && [ $p = 1 ] && [ $h = 1 ] &&',
  String.raw`printf "username=%s\npassword=%s\n" "$GITDESK_CRED_USER" "$GITDESK_CRED_TOKEN";`,
  ':; }; f'
].join(' ')

/** A host as git writes it in a credential request: lowercase name, optional port. */
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/

export function isCredentialHost(host: string): boolean {
  return HOST.test(host)
}

let authResolver: (cwd: string) => GitAuth | null = () => null
// Until the account store says otherwise, only github.com logins (ids without ":") get credentials.
let identityResolver: (login: string) => GitIdentity | null = (login) =>
  login.includes(':') ? null : { username: login, hosts: ['github.com'] }

/** Lets the account store decide which repositories get credentials. */
export function setAuthResolver(resolver: (cwd: string) => GitAuth | null): void {
  authResolver = resolver
}

/** Lets the account store say which user name and hosts belong to an account id. */
export function setGitIdentityResolver(resolver: (login: string) => GitIdentity | null): void {
  identityResolver = resolver
}

/**
 * The `-c` arguments and environment that give git this account's token, or null when
 * the account is unknown or has no valid host. Exported for tests.
 */
export function credentialConfig(
  auth: GitAuth | null
): { args: string[]; env: Record<string, string> } | null {
  if (!auth || !auth.token) return null
  const identity =
    auth.username !== undefined && auth.hosts
      ? { username: auth.username, hosts: auth.hosts }
      : identityResolver(auth.login)
  const hosts = (identity?.hosts ?? []).map((h) => h.toLowerCase()).filter(isCredentialHost)
  if (!identity || !hosts.length || /[\r\n\0]/.test(identity.username + auth.token)) return null
  return {
    args: ['-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`],
    env: {
      GITDESK_CRED_USER: identity.username,
      GITDESK_CRED_TOKEN: auth.token,
      GITDESK_CRED_HOSTS: hosts.join(' '),
      GIT_TERMINAL_PROMPT: '0'
    }
  }
}

/**
 * PATH without empty or relative entries: those resolve against the folder git runs
 * in (the repository), so a repository could provide the programs git starts.
 * Exported for tests.
 */
export function absolutePath(pathEnv: string): string {
  return pathEnv
    .split(delimiter)
    .filter((dir) => dir && isAbsolute(dir))
    .join(delimiter)
}

/** The environment every git command starts from. Exported for tests. */
export function baseEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(parent)) if (v !== undefined) env[k] = v
  // Where the repository is comes from the folder git runs in, never from variables
  // GitDesk inherited (e.g. when started from a git hook).
  for (const k of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE'
  ])
    delete env[k]
  // Windows spells it "Path": keep its own key.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  if (pathKey) env[pathKey] = absolutePath(env[pathKey])
  return {
    ...env,
    // Read-only commands like `status` must not rewrite the index: the file
    // watcher would see that write and trigger another refresh, forever
    // (refreshIndexOnce refreshes the stat data this leaves stale).
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    // Never open an editor from a GUI process (merge, revert, cherry-pick...).
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    // No terminal to type a password in: fail instead of waiting for one.
    // (The low-speed limit for stalled https transfers is set per command, where your
    // own http.lowSpeedLimit is known: trust/policy.ts.)
    GIT_TERMINAL_PROMPT: '0'
  }
}

/** The value of PATH in an environment, whatever its key's case ("Path" on Windows). */
function pathOf(env: Record<string, string>): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return key ? env[key] : ''
}

let ENV = baseEnv(process.env)
/** Where git was found (gitExecutable). */
let gitPath: string | null = null
let envReady: Promise<void> | null = null

/**
 * macOS and Linux: an app started from the Dock or a desktop launcher gets a minimal PATH,
 * without Homebrew or ~/.local/bin, so git itself and the programs it starts (hooks,
 * git-lfs, ssh helpers) are looked up on the login shell's PATH instead (read once, see
 * userPath), still without its empty or relative entries (baseEnv). Windows programs get
 * the user's PATH already.
 */
function prepareEnv(): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve()
  envReady ??= userPath().then(
    (path) => {
      const parent = Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH')
      const env = baseEnv({ ...Object.fromEntries(parent), PATH: path })
      if (pathOf(env) === pathOf(ENV)) return
      ENV = env
      gitPath = null // found again on the fuller PATH (Homebrew's git before /usr/bin's)
    },
    () => undefined
  )
  return envReady
}

/**
 * Settings GitDesk overrides for one repository on every git command, so a repository
 * you did not create or trust cannot make git start programs or reach other machines
 * (see trust/policy.ts).
 */
export interface RepoPolicy {
  /** `-c` arguments, placed before the command. */
  args: string[]
  env: Record<string, string>
  /** GitDesk does not run git in this folder at all: the reason. */
  blocked?: string
  /** Network commands are refused: the reason. */
  networkPaused?: string
}

type PolicyResolver = (
  cwd: string,
  network: boolean,
  args: string[]
) => RepoPolicy | null | Promise<RepoPolicy | null>

let policyResolver: PolicyResolver = () => null

/** Lets the trust module decide what each repository's git commands may use. */
export function setRepoPolicyResolver(resolver: PolicyResolver): void {
  policyResolver = resolver
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Absolute path of the git program, found once on the PATH git runs with (or GITDESK_GIT).
 * Never the bare name: Windows looks for git.exe in the folder git runs in, the
 * repository, first. runGit and findGit first read the login shell's PATH (prepareEnv).
 */
export function gitExecutable(): string {
  if (gitPath) return gitPath
  const override = process.env.GITDESK_GIT
  const found =
    override && isAbsolute(override) && isFile(override)
      ? override
      : // Node starts only real programs without a shell: git.exe, not a .cmd wrapper.
        findExecutable(process.platform === 'win32' ? 'git.exe' : 'git', pathOf(ENV))
  // Not cached when missing, so installing git while GitDesk runs works.
  if (!found)
    throw new GitError('Git was not found. Install it from https://git-scm.com.', null, '')
  return (gitPath = found)
}

/** The git program GitDesk runs (see gitExecutable), or null when there is none. */
export async function findGit(): Promise<string | null> {
  await prepareEnv()
  try {
    return gitExecutable()
  } catch {
    return null
  }
}

/** "2.47.1" from `git --version` output ("git version 2.47.1"), or null. Exported for tests. */
export function parseGitVersion(stdout: string): string | null {
  const m = /^git version (\S+)/.exec(stdout.trim())
  return m ? m[1] : null
}

/** Version of the git GitDesk runs ("2.47.1.windows.1"), or null when git is missing. */
export async function gitVersion(): Promise<string | null> {
  const program = await findGit()
  if (!program) return null
  return new Promise((resolve) => {
    // Outside any repository: `--version` reads nothing, but no folder of yours is involved.
    execFile(
      program,
      ['--version'],
      { cwd: homedir(), env: ENV, windowsHide: true, timeout: 10_000, encoding: 'utf8' },
      (error, stdout) => resolve(error ? null : parseGitVersion(stdout))
    )
  })
}

/** Ends git and what it started (git-remote-https, ssh), so its pipes close. */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error) child.kill()
    })
    return
  }
  // The child leads its own process group (detached): SIGTERM lets git remove its
  // lock files; whatever is left after 5 s is killed.
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig)
    } catch {
      child.kill(sig)
    }
  }
  signal('SIGTERM')
  setTimeout(() => signal('SIGKILL'), 5000).unref()
}

/** Running network commands per folder, for cancelNetworkCommands. */
const running = new Map<string, Set<() => void>>()
const folderKey = (cwd: string): string => (process.platform === 'win32' ? cwd.toLowerCase() : cwd)

/** Stops the fetch, pull, push or clone running in `cwd`; returns how many were stopped. */
export function cancelNetworkCommands(cwd: string): number {
  const stops = [...(running.get(folderKey(cwd)) ?? [])]
  for (const stop of stops) stop()
  return stops.length
}

const duration = (ms: number): string =>
  ms >= 60_000 && ms % 60_000 === 0
    ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`
    : `${Math.round(ms / 1000)} seconds`

/**
 * Commands that never get the account's token by default, so the hooks they run
 * (pre-commit, prepare-commit-msg, commit-msg, post-commit) cannot read it from their
 * environment. Defense in depth only: a hook runs as you and can do anything you can.
 *
 * Every other command keeps it: fetch, pull, push, clone, ls-remote, remote, submodule
 * need the network, and in a partial clone (GitDesk clones with --filter=blob:none) any
 * command that reads file contents (checkout/switch, merge, rebase, cherry-pick, revert,
 * reset --hard, diff, log -p, blame, show, restore, stash, am -3…) may fetch missing
 * objects on the fly; without the token that fetch would fall back to your own git
 * credentials (a Git Credential Manager prompt) or fail. A commit only needs the index,
 * and GitDesk runs it with --quiet so git does not compute the summary diffstat (which
 * could read the parent's missing blobs, e.g. after --amend). A hook that itself reads
 * missing blobs falls back to your own git credentials. `tag` needs nothing from the
 * network. Merges, reverts and cherry-picks also run commit hooks, but they read file
 * contents, so they keep the token.
 */
const WITHOUT_CREDENTIALS = new Set(['commit', 'tag'])

export async function runGit(
  cwd: string,
  args: string[],
  opts: RunOptions = {}
): Promise<RunResult> {
  const network = isNetworkCommand(args)
  const policy = await policyResolver(cwd, network, args)
  if (policy?.blocked) throw new GitError(policy.blocked, null, '')
  if (network && policy?.networkPaused) throw new GitError(policy.networkPaused, null, '')
  if (opts.signal?.aborted) throw new GitError(`git ${args[0]} was cancelled`, null, '')
  await prepareEnv()
  const program = gitExecutable()
  const okCodes = opts.okCodes ?? [0]
  // A repository whose settings change how git connects gets no token at all (its
  // network commands are refused; the others need none: lazy fetches and Git LFS
  // downloads are off there).
  const auth = policy?.networkPaused
    ? null
    : opts.auth !== undefined
      ? opts.auth
      : WITHOUT_CREDENTIALS.has(args[0])
        ? null
        : authResolver(cwd)
  const credentials = credentialConfig(auth)
  const authArgs = credentials?.args ?? []
  // The policy comes after the caller's variables: they cannot undo it.
  const env = { ...ENV, ...opts.env, ...policy?.env, ...credentials?.env }
  const timeoutMs = opts.timeoutMs ?? (network ? NETWORK_TIMEOUTS[args[0]] : undefined)
  const stoppable = network || !!timeoutMs || !!opts.signal
  const command = timeoutMs ? progressArgs(args) : args
  const progress = command !== args
  const argv = [...BASE_ARGS, ...(policy?.args ?? []), ...authArgs, ...hardenArgs(command)]

  return new Promise((resolve, reject) => {
    const child = spawn(program, argv, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group on POSIX, so a stop reaches the programs git started.
      detached: stoppable && process.platform !== 'win32'
    })

    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let truncated = false
    let stopped: string | null = null
    let settled = false

    const stop = (why: string): void => {
      if (settled || stopped) return
      stopped = why
      killTree(child)
    }
    let timer: NodeJS.Timeout | null = null
    /** (Re)starts the idle timer: called again on every output. */
    const arm = (): void => {
      if (!timeoutMs || settled || stopped) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(
        () =>
          stop(
            `git ${args[0]} timed out: no progress for ${duration(timeoutMs)} (the remote stopped answering)`
          ),
        timeoutMs
      )
    }
    arm()
    const cancel = (): void => stop(`git ${args[0]} was cancelled`)
    opts.signal?.addEventListener('abort', cancel, { once: true })
    const key = folderKey(cwd)
    if (network) {
      if (!running.has(key)) running.set(key, new Set())
      running.get(key)!.add(cancel)
    }
    const cleanUp = (): void => {
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', cancel)
      running.get(key)?.delete(cancel)
      if (!running.get(key)?.size) running.delete(key)
    }

    const finish = (code: number | null): void => {
      if (settled) return
      cleanUp()
      const stdout = Buffer.concat(out).toString('utf8')
      const raw = Buffer.concat(err).toString('utf8')
      const stderr = (progress ? withoutProgress(raw) : raw).trim()
      if (stopped) return reject(new GitError(stopped, code, stderr))
      if (truncated) return resolve({ stdout, exitCode: code ?? 0, truncated })
      if (code !== null && okCodes.includes(code))
        return resolve({ stdout, exitCode: code, truncated })
      const message = stderr || stdout.trim() || `git ${args[0]} failed with exit code ${code}`
      reject(new GitError(message, code, stderr))
    }

    child.stdout.on('data', (chunk: Buffer) => {
      arm()
      if (truncated) return
      out.push(chunk)
      outBytes += chunk.length
      if (opts.maxBytes && outBytes > opts.maxBytes) {
        truncated = true
        child.kill()
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      arm()
      err.push(chunk)
      opts.onStderr?.(chunk.toString('utf8'))
    })
    child.on('error', (e) => {
      if (settled) return
      cleanUp()
      reject(new GitError(`Could not run git: ${e.message}`, null, ''))
    })
    child.on('close', (code) => finish(code))
    // A program git started (ssh, a credential daemon) can keep the pipes open after
    // git itself exited: settle anyway.
    child.on('exit', (code) => {
      setTimeout(() => finish(code), 2000).unref()
    })

    child.stdin.on('error', () => {
      /* git may exit before reading stdin; the close handler reports it */
    })
    child.stdin.end(opts.input ?? '')
  })
}

export async function git(cwd: string, args: string[], opts?: RunOptions): Promise<string> {
  return (await runGit(cwd, args, opts)).stdout
}

/** Rejects user-supplied ref names that git would parse as options. */
export function assertSafeRef(ref: string): void {
  if (!ref || ref.startsWith('-') || /[\0\n\r]/.test(ref)) {
    throw new GitError(`Invalid name: "${ref}"`, null, '')
  }
}

export function assertSha(sha: string): void {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw new GitError(`Invalid commit id: "${sha}"`, null, '')
}

/** Validates a branch name with git's own rules. */
export async function assertBranchName(cwd: string, name: string): Promise<void> {
  assertSafeRef(name)
  // `check-ref-format --branch` expands "@" and "@{-1}" (the current or previous
  // branch) and accepts them: a branch named "@" could never be checked out.
  if (name === '@' || name.includes('@{'))
    throw new GitError(`"${name}" is not a valid branch name`, null, '')
  try {
    await git(cwd, ['check-ref-format', '--branch', name])
  } catch {
    throw new GitError(`"${name}" is not a valid branch name`, null, '')
  }
}

const refreshed = new Set<string>()

/**
 * Refreshes the index's stat data once per repository and session. GitDesk's own
 * `status` never writes the index (GIT_OPTIONAL_LOCKS=0), so after a repository was
 * copied or its files touched, every status would hash those files again. Run it in
 * the repository's write queue (it takes the index lock); failures are ignored.
 */
export async function refreshIndexOnce(repo: string): Promise<void> {
  const key = folderKey(repo)
  if (refreshed.has(key)) return
  refreshed.add(key)
  await runGit(repo, ['update-index', '-q', '--refresh'], { okCodes: [0, 1] }).catch(
    () => undefined
  )
}
