import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { delimiter, isAbsolute, join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Your own git configuration stays out of these tests.
const base = mkdtempSync(join(tmpdir(), 'gitdesk-trust-git-'))
writeFileSync(join(base, 'gitconfig'), '')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = join(base, 'gitconfig')

const {
  absolutePath,
  assertBranchName,
  baseEnv,
  cancelNetworkCommands,
  git,
  gitExecutable,
  hardenArgs,
  isNetworkCommand,
  progressArgs,
  refreshIndexOnce,
  runGit,
  withoutProgress
} = await import('../../src/main/git')

let repo: string
const g = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

// A server that accepts connections and never answers: a remote that went silent.
let server: Server
let port = 0
const sockets: Socket[] = []

beforeAll(async () => {
  repo = mkdtempSync(join(base, 'repo-'))
  g('init', '-q', '-b', 'main')
  g('config', 'user.name', 'Test')
  g('config', 'user.email', 'test@example.com')
  g('config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  g('add', '.')
  g('commit', '-q', '-m', 'one')
  server = createServer((s) => {
    // Reset when GitDesk kills git-remote-http: expected.
    s.on('error', () => undefined)
    sockets.push(s)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(() => {
  for (const s of sockets) s.destroy()
  server?.close()
  rmSync(base, { recursive: true, force: true })
})

describe('always-on hardening', () => {
  it('turns off textconv and external diff programs on commands that show contents', () => {
    expect(hardenArgs(['diff', '--cached'])).toEqual([
      'diff',
      '--no-textconv',
      '--no-ext-diff',
      '--cached'
    ])
    expect(hardenArgs(['log', '-p'])[1]).toBe('--no-textconv')
    expect(hardenArgs(['show', 'HEAD'])).toContain('--no-ext-diff')
    expect(hardenArgs(['blame', '--porcelain', 'a'])).toEqual([
      'blame',
      '--no-textconv',
      '--porcelain',
      'a'
    ])
    expect(hardenArgs(['status'])).toEqual(['status'])
  })

  it('knows which commands use the network', () => {
    for (const a of [['fetch'], ['pull'], ['push'], ['ls-remote'], ['clone'], ['remote', 'update']])
      expect(isNetworkCommand(a), a.join(' ')).toBe(true)
    for (const a of [['status'], ['remote'], ['remote', 'get-url', 'origin'], ['log']])
      expect(isNetworkCommand(a), a.join(' ')).toBe(false)
  })

  it('drops empty and relative PATH entries and inherited repository variables', () => {
    const abs = process.platform === 'win32' ? 'C:\\bin' : '/usr/bin'
    expect(absolutePath(['.', '', abs, 'rel'].join(delimiter))).toBe(abs)
    const env = baseEnv({ PATH: `.${delimiter}${abs}`, GIT_DIR: '/x', GIT_WORK_TREE: '/y' })
    expect(env.PATH).toBe(abs)
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    // Set per command, where your own http.lowSpeed* settings are known (trust/policy.ts).
    expect(env.GIT_HTTP_LOW_SPEED_LIMIT).toBeUndefined()
    expect(baseEnv({ GIT_HTTP_LOW_SPEED_TIME: '30' }).GIT_HTTP_LOW_SPEED_TIME).toBe('30')
  })

  it('runs git by its absolute path, never a git.exe placed in the repository', async () => {
    expect(isAbsolute(gitExecutable())).toBe(true)
    if (process.platform === 'win32') {
      // A harmless stand-in: if it ran, the output would be a user name, not git's version.
      const root = process.env.SystemRoot || 'C:\\Windows'
      copyFileSync(join(root, 'System32', 'whoami.exe'), join(repo, 'git.exe'))
      copyFileSync(join(root, 'System32', 'whoami.exe'), join(repo, 'git.com'))
    } else {
      const marker = join(base, 'planted-git-ran')
      writeFileSync(join(repo, 'git'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    }
    try {
      expect(await git(repo, ['--version'])).toMatch(/^git version/)
      expect(existsSync(join(base, 'planted-git-ran'))).toBe(false)
    } finally {
      for (const f of ['git.exe', 'git.com', 'git']) rmSync(join(repo, f), { force: true })
    }
  })
})

describe('network commands can be stopped', () => {
  const silent = (): string => `http://127.0.0.1:${port}/r.git`

  it('times out on a remote that stopped answering', async () => {
    const started = Date.now()
    await expect(runGit(repo, ['ls-remote', silent()], { timeoutMs: 1500 })).rejects.toThrow(
      /timed out/
    )
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  it('waits as long as git keeps printing: the timeout is an idle time', async () => {
    // Aliases stand in for a transfer: one prints every 0.3 s for 3.6 s (longer than the
    // timeout), one prints nothing. The idle time leaves room for a slow `sleep` start on a
    // busy machine.
    const busy = '!for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo tick; sleep 0.3; done'
    const r = await runGit(repo, ['-c', `alias.busy=${busy}`, 'busy'], { timeoutMs: 2500 })
    expect(r.stdout.split('tick').length - 1).toBe(12)
    await expect(
      runGit(repo, ['-c', 'alias.quiet=!sleep 6', 'quiet'], { timeoutMs: 2500 })
    ).rejects.toThrow(/timed out: no progress/)
  }, 30_000)

  it('asks fetch, pull and push for progress, and leaves it out of error messages', () => {
    expect(progressArgs(['fetch', '--all', '--prune'])).toEqual([
      'fetch',
      '--progress',
      '--all',
      '--prune'
    ])
    expect(progressArgs(['push', '--', 'origin', '-q'])[1]).toBe('--progress')
    expect(progressArgs(['pull', '--quiet'])).toEqual(['pull', '--quiet'])
    expect(progressArgs(['ls-remote', 'origin'])).toEqual(['ls-remote', 'origin'])
    const stderr = [
      'Enumerating objects: 5, done.',
      'Counting objects:  20% (1/5)\rCounting objects: 100% (5/5), done.',
      'Delta compression using up to 8 threads',
      'Writing objects: 100% (3/3), 280 bytes | 280.00 KiB/s, done.',
      'Total 3 (delta 0), reused 0 (delta 0), pack-reused 0',
      'remote: Resolving deltas: 100% (1/1)',
      'To https://h.example/r.git',
      ' ! [rejected]        main -> main (stale info)',
      "error: failed to push some refs to 'https://h.example/r.git'"
    ].join('\n')
    expect(withoutProgress(stderr).split('\n')).toEqual([
      'To https://h.example/r.git',
      ' ! [rejected]        main -> main (stale info)',
      "error: failed to push some refs to 'https://h.example/r.git'"
    ])
  })

  it('stops on an abort signal', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 500)
    await expect(
      runGit(repo, ['ls-remote', silent()], { signal: controller.signal })
    ).rejects.toThrow(/cancelled/)
  }, 20_000)

  it('cancels what runs in a repository', async () => {
    const run = runGit(repo, ['ls-remote', silent()])
    await new Promise((r) => setTimeout(r, 500))
    expect(cancelNetworkCommands(repo)).toBe(1)
    await expect(run).rejects.toThrow(/cancelled/)
    expect(cancelNetworkCommands(repo)).toBe(0)
  }, 20_000)
})

describe('branch names', () => {
  it('refuses names git would expand to another branch', async () => {
    for (const name of ['@', '@{-1}', 'a@{b'])
      await expect(assertBranchName(repo, name), name).rejects.toThrow(/not a valid branch name/)
    await expect(assertBranchName(repo, 'feature/x@y')).resolves.toBeUndefined()
  })
})

describe('refreshIndexOnce', () => {
  it('refreshes stale stat data once per session', async () => {
    // In the past: a time after the index was written would make git re-check it ("racy git").
    let minutes = 10
    const touch = (): void => {
      const earlier = new Date(Date.now() - 60_000 * minutes++)
      utimesSync(join(repo, 'a.txt'), earlier, earlier)
    }
    // Same content, new time: listed by diff-files (it does not refresh) until refreshed.
    touch()
    const stale = (): Promise<string> => git(repo, ['diff-files', '--name-only'])
    expect((await stale()).trim()).toBe('a.txt')
    // The problem: GitDesk's own status (GIT_OPTIONAL_LOCKS=0) never writes the refresh.
    await git(repo, ['status', '--porcelain=v2'])
    expect((await stale()).trim()).toBe('a.txt')
    await refreshIndexOnce(repo)
    expect((await stale()).trim()).toBe('')
    touch()
    await refreshIndexOnce(repo)
    expect((await stale()).trim()).toBe('a.txt')
  })
})
