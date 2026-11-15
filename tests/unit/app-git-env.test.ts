import { delimiter } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Which PATH git is found on and runs with. userPath (the login shell's PATH) and
// findExecutable are stand-ins: the test only checks what git.ts asks them and does
// with the answers.
const h = vi.hoisted(() => ({
  userPath: async (): Promise<string> => '',
  userPathCalls: 0,
  searched: [] as string[],
  /** Where git is on a PATH (set per test). */
  gitIn: null as unknown as (pathEnv: string) => string | null,
  execFile: [] as { program: string; args: string[]; env: Record<string, string> }[],
  versionOutput: 'git version 2.50.1\n'
}))

vi.mock('../../src/main/terminal/resolve', () => ({
  userPath: () => {
    h.userPathCalls++
    return h.userPath()
  },
  findExecutable: (_name: string, pathEnv: string) => {
    h.searched.push(pathEnv)
    return h.gitIn(pathEnv)
  }
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execFile: (
      program: string,
      args: string[],
      opts: { env: Record<string, string> },
      done: (error: Error | null, stdout: string) => void
    ) => {
      h.execFile.push({ program, args, env: opts.env })
      done(null, h.versionOutput)
    }
  }
})

type Git = typeof import('../../src/main/git')
const platform = process.platform
const setPlatform = (p: string): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
const savedPath = process.env.PATH
const savedOverride = process.env.GITDESK_GIT

/** Loads git.ts as on `p`, with the app's own (Dock / launcher) PATH `appPath`. */
async function load(p: string, appPath: string): Promise<Git> {
  setPlatform(p)
  for (const k of Object.keys(process.env)) if (k.toUpperCase() === 'PATH') delete process.env[k]
  process.env.PATH = appPath
  return import('../../src/main/git')
}

const pathOf = (env: Record<string, string>): string | undefined =>
  Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1]

beforeEach(() => {
  vi.resetModules()
  delete process.env.GITDESK_GIT
  h.userPathCalls = 0
  h.searched = []
  h.execFile = []
  h.versionOutput = 'git version 2.50.1\n'
  // The first folder of the PATH has git.
  h.gitIn = (pathEnv) => {
    const first = pathEnv.split(delimiter).find(Boolean)
    return first ? `${first}/git` : null
  }
})

afterEach(() => {
  setPlatform(platform)
  for (const k of Object.keys(process.env)) if (k.toUpperCase() === 'PATH') delete process.env[k]
  process.env.PATH = savedPath
  if (savedOverride === undefined) delete process.env.GITDESK_GIT
  else process.env.GITDESK_GIT = savedOverride
})

const minimal = ['/usr/bin', '/bin'].join(delimiter)
const loginShell = ['/opt/homebrew/bin', '.', '', 'node_modules/.bin', '/usr/bin', '/bin'].join(
  delimiter
)
const safeLoginShell = ['/opt/homebrew/bin', '/usr/bin', '/bin'].join(delimiter)

describe('git on macOS and Linux uses the login shell PATH', () => {
  it('finds git (Homebrew first) on the login shell PATH, without relative entries', async () => {
    h.userPath = async () => loginShell
    const g = await load('darwin', minimal)
    expect(await g.findGit()).toBe('/opt/homebrew/bin/git')
    expect(h.searched.at(-1)).toBe(safeLoginShell)
    expect(h.userPathCalls).toBe(1)
  })

  it('forgets a git found on the minimal PATH once the login shell answered', async () => {
    h.userPath = async () => loginShell
    const g = await load('linux', minimal)
    // A synchronous lookup before any command ran: only the app's PATH is known.
    expect(g.gitExecutable()).toBe('/usr/bin/git')
    expect(await g.findGit()).toBe('/opt/homebrew/bin/git')
    expect(g.gitExecutable()).toBe('/opt/homebrew/bin/git')
  })

  it('gives git (and so its hooks and git-lfs) the same PATH, read only once', async () => {
    h.userPath = async () => loginShell
    const g = await load('darwin', minimal)
    expect(await g.gitVersion()).toBe('2.50.1')
    expect(await g.gitVersion()).toBe('2.50.1')
    expect(h.userPathCalls).toBe(1)
    expect(h.execFile).toHaveLength(2)
    expect(h.execFile[0].program).toBe('/opt/homebrew/bin/git')
    expect(h.execFile[0].args).toEqual(['--version'])
    expect(pathOf(h.execFile[0].env)).toBe(safeLoginShell)
    expect(h.execFile[0].env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('keeps the app PATH when the login shell gives nothing', async () => {
    h.userPath = async () => Promise.reject(new Error('no shell'))
    const g = await load('linux', minimal)
    expect(await g.findGit()).toBe('/usr/bin/git')
    expect(h.searched.at(-1)).toBe(minimal)
  })

  it('reports a missing git as null, without running anything', async () => {
    h.userPath = async () => loginShell
    h.gitIn = () => null
    const g = await load('darwin', minimal)
    expect(await g.findGit()).toBeNull()
    expect(await g.gitVersion()).toBeNull()
    expect(h.execFile).toHaveLength(0)
    expect(() => g.gitExecutable()).toThrow(/Git was not found/)
  })

  it('Windows keeps its own PATH and never starts a login shell', async () => {
    h.userPath = async () => loginShell
    // An absolute folder on the machine running the test (path rules are the host's).
    const dir = platform === 'win32' ? 'C:\\Program Files\\Git\\cmd' : '/opt/git/cmd'
    const g = await load('win32', [dir, 'relative'].join(delimiter))
    expect(await g.findGit()).toBe(`${dir}/git`)
    expect(h.userPathCalls).toBe(0)
    expect(h.searched.at(-1)).toBe(dir)
  })
})

describe('git --version', () => {
  it('reads the version from its output', async () => {
    const { parseGitVersion } = await load(platform, savedPath ?? '')
    expect(parseGitVersion('git version 2.47.1.windows.1\n')).toBe('2.47.1.windows.1')
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toBe('2.39.5')
    expect(parseGitVersion('')).toBeNull()
    expect(parseGitVersion('usage: git [--version]')).toBeNull()
  })

  it('is null when git fails to answer', async () => {
    h.userPath = async () => loginShell
    h.versionOutput = 'not git'
    const g = await load('darwin', minimal)
    expect(await g.gitVersion()).toBeNull()
  })
})
