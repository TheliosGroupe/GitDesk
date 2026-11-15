// Real repositories whose own settings would start a program: each program only writes
// a marker file in this test's temp folder. Until the repository is trusted, GitDesk's
// git commands must not start it (and must still work).

import { execFile, execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { createServer, type Server } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const base = mkdtempSync(join(tmpdir(), 'gitdesk-trust-repos-'))
const userData = join(base, 'userData')
mkdirSync(userData)
writeFileSync(join(base, 'gitconfig'), '')
// Your own git configuration (helpers, LFS…) stays out of these tests.
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = join(base, 'gitconfig')
process.env.GITDESK_TRUST_TEST_USERDATA = userData
// The fixture commands below never wait for a password either.
process.env.GIT_TERMINAL_PROMPT = '0'
delete process.env.GIT_SSH_COMMAND
delete process.env.GIT_SSH
delete process.env.GIT_ASKPASS
delete process.env.SSH_ASKPASS

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.GITDESK_TRUST_TEST_USERDATA,
    isReady: () => false,
    whenReady: () => new Promise(() => undefined)
  },
  dialog: { showMessageBox: () => Promise.resolve() },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { git, runGit } = await import('../../src/main/git')
const policy = await import('../../src/main/trust/policy')
const { assertSafeWorkTree } = await import('../../src/main/trust/worktree')
const { inspectRepo, stampsCurrent } = await import('../../src/main/trust/inspect')
const store = await import('../../src/main/store')
policy.installTrustPolicy()

let repo: string
let n = 0
const marker = (): string => join(base, `marker-${n}`).replace(/\\/g, '/')
/** A shell command that only appends to the marker file. */
const writesMarker = (): string => `echo ran >> '${marker()}'`
const ran = (): boolean => existsSync(marker())
const g = (...args: string[]): string =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000
  })
const gTry = (...args: string[]): void => {
  try {
    g(...args)
  } catch {
    /* the command may fail; the marker tells whether the program ran */
  }
}

function newRepo(): string {
  const dir = mkdtempSync(join(base, 'repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  repo = dir
  g('config', 'user.name', 'Test')
  g('config', 'user.email', 'test@example.com')
  g('config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  g('add', '.')
  g('commit', '-q', '-m', 'one')
  return dir
}

beforeEach(() => {
  n++
  newRepo()
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('untrusted repositories', () => {
  it('runs no hook script until trusted', async () => {
    const hook = join(repo, '.git', 'hooks', 'post-checkout')
    writeFileSync(hook, `#!/bin/sh\n${writesMarker()}\n`, { mode: 0o755 })
    g('branch', 'other')
    expect(policy.trustStatusOf(repo).level).toBe('untrusted')
    expect(policy.trustStatusOf(repo).findings.map((f) => f.key)).toEqual(['hooks'])
    await git(repo, ['switch', '-q', 'other'])
    expect(ran()).toBe(false)

    policy.trustRepo(repo)
    expect(policy.trustStatusOf(repo).level).toBe('trusted')
    await git(repo, ['switch', '-q', 'main'])
    expect(ran()).toBe(true)
  })

  it('asks again when a new risky setting appears after trusting', async () => {
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n', { mode: 0o755 })
    policy.trustRepo(repo)
    expect(policy.trustStatusOf(repo).level).toBe('trusted')
    g('config', 'core.fsmonitor', writesMarker())
    expect(policy.trustStatusOf(repo, true).level).toBe('untrusted')
    await git(repo, ['status', '--porcelain'])
    expect(ran()).toBe(false)
  })

  it('does not start an fsmonitor program', async () => {
    g('config', 'core.fsmonitor', writesMarker())
    await git(repo, ['status', '--porcelain=v2'])
    expect(ran()).toBe(false)
    gTry('status') // the fixture really runs it
    expect(ran()).toBe(true)
  })

  it('applies the trust of the repository above when git runs in a subfolder', async () => {
    g('config', 'core.fsmonitor', writesMarker())
    const sub = join(repo, 'sub')
    mkdirSync(sub)
    await git(sub, ['status', '--porcelain=v2'])
    expect(ran()).toBe(false)
    expect(policy.policyRoot(sub, ['status'])).toBe(repo)
    // clone only creates a repository; init creates or re-initializes the folder itself.
    expect(policy.policyRoot(sub, ['clone', 'x'])).toBeNull()
    expect(policy.policyRoot(sub, ['init'])).toBe(sub)
  })

  it("leaves Git LFS's own hooks alone, and notices when one is edited", () => {
    const hook = join(repo, '.git', 'hooks', 'pre-push')
    const lfs =
      '#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { printf >&2 "\\n%s\\n\\n" "Git LFS was not found on your path."; exit 2; }\ngit lfs pre-push "$@"\n'
    writeFileSync(hook, lfs, { mode: 0o755 })
    const before = inspectRepo(repo)!
    expect(before.findings).toEqual([])
    expect(policy.trustStatusOf(repo, true).level).toBe('clean')
    writeFileSync(hook, lfs + `${writesMarker()}\n`, { mode: 0o755 })
    expect(stampsCurrent(before.stamps)).toBe(false)
    expect(policy.trustStatusOf(repo, true).findings.map((f) => f.key)).toEqual(['hooks'])
  })

  it('keeps your own includeIf settings for the repository (a work SSH key)', async () => {
    const own = join(base, `own-${n}.gitconfig`)
    writeFileSync(own, `[core]\n\tsshCommand = ${JSON.stringify(writesMarker())}\n`)
    // Written as git names the folder (the temp folder may be a short name, or a link).
    const gitDir = join(realpathSync.native(repo), '.git').replace(/\\/g, '/')
    writeFileSync(
      process.env.GIT_CONFIG_GLOBAL!,
      `[includeIf "gitdir/i:${gitDir}"]\n\tpath = ${own.replace(/\\/g, '/')}\n`
    )
    try {
      g('remote', 'add', 'origin', 'ssh://127.0.0.1:1/nothing.git')
      await git(repo, ['ls-remote', 'origin']).catch(() => undefined)
      expect(ran()).toBe(true)
    } finally {
      writeFileSync(process.env.GIT_CONFIG_GLOBAL!, '')
    }
  })

  it('does not run filter programs, and still stages the file', async () => {
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=mark\n')
    g('config', 'filter.mark.clean', `${writesMarker()}; cat`)
    g('config', 'filter.mark.required', 'true')
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    await git(repo, ['add', 'a.txt'])
    expect(ran()).toBe(false)
    expect(g('show', ':a.txt')).toBe('two\n')
    writeFileSync(join(repo, 'a.txt'), 'three\n')
    gTry('add', 'a.txt')
    expect(ran()).toBe(true)
  })

  it('never runs textconv or external diff programs to show differences', async () => {
    writeFileSync(join(repo, '.gitattributes'), '*.txt diff=mark\n')
    g('config', 'diff.mark.textconv', `${writesMarker()}; cat`)
    g('config', 'diff.external', writesMarker())
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    g('add', '.')
    g('commit', '-q', '-m', 'two')
    writeFileSync(join(repo, 'a.txt'), 'three\n')
    for (const args of [['diff'], ['log', '-p', '-2'], ['show', 'HEAD'], ['blame', 'a.txt']]) {
      await git(repo, args)
      expect(ran(), args.join(' ')).toBe(false)
    }
    // Trusted too: GitDesk shows git's own diff.
    policy.trustRepo(repo)
    expect(await git(repo, ['diff'])).toContain('+three')
    expect(ran()).toBe(false)
    gTry('diff')
    expect(ran()).toBe(true)
  })

  it('does not run a merge driver in merge-tree (conflict warnings)', async () => {
    writeFileSync(join(repo, '.gitattributes'), '*.txt merge=mark\n')
    g('add', '.')
    g('commit', '-q', '-m', 'attributes')
    g('config', 'merge.mark.driver', `${writesMarker()}; false`)
    g('switch', '-q', '-c', 'side')
    writeFileSync(join(repo, 'a.txt'), 'side\n')
    g('commit', '-q', '-am', 'side')
    g('switch', '-q', 'main')
    writeFileSync(join(repo, 'a.txt'), 'main\n')
    g('commit', '-q', '-am', 'main')
    await runGit(repo, ['merge-tree', '--write-tree', 'main', 'side'], { okCodes: [0, 1] })
    expect(ran()).toBe(false)
    policy.trustRepo(repo)
    await runGit(repo, ['merge-tree', '--write-tree', 'main', 'side'], { okCodes: [0, 1] })
    expect(ran()).toBe(true)
  })

  it('reads settings from included files', () => {
    writeFileSync(join(repo, '.git', 'extra.inc'), `[core]\n\tfsmonitor = "${writesMarker()}"\n`)
    g('config', 'include.path', 'extra.inc')
    const found = policy.trustStatusOf(repo, true).findings
    expect(found.map((f) => f.key)).toEqual(['core.fsmonitor'])
    expect(found[0].file).toMatch(/extra\.inc$/)
  })

  it('looks into submodules and keeps git out of risky ones', () => {
    const sub = join(repo, '.git', 'modules', 'lib')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(sub, 'config'), `[core]\n\tfsmonitor = "${writesMarker()}"\n`)
    const status = policy.trustStatusOf(repo, true)
    expect(status.findings.map((f) => [f.submodule, f.key])).toEqual([['lib', 'core.fsmonitor']])
    expect(status.level).toBe('untrusted')
  })

  it('does not skip what it cannot read: a settings file too large to check', async () => {
    const config = join(repo, '.git', 'config')
    const padding = `# ${'x'.repeat(1 << 20)}\n`
    writeFileSync(
      config,
      `${readFileSync(config, 'utf8')}${padding}[core]\n\tfsmonitor = "${writesMarker()}"\n`
    )
    const status = policy.trustStatusOf(repo, true)
    expect(status.level).toBe('blocked')
    expect(status.findings[0].text).toMatch(/cannot check/)
    await expect(git(repo, ['status', '--porcelain'])).rejects.toThrow(/did not run git/)
    expect(ran()).toBe(false)
    gTry('status') // git reads the whole file and runs it
    expect(ran()).toBe(true)
  })

  it('accepts a Git LFS hook only when the whole file is one', () => {
    const hook = join(repo, '.git', 'hooks', 'post-checkout')
    const lfs =
      '#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { printf >&2 "\\n%s\\n\\n" "Git LFS was not found on your path."; exit 2; }\ngit lfs post-checkout "$@"\n'
    for (const padding of [' '.repeat(5000), '\n'.repeat(5000), ' '.repeat(70_000)]) {
      writeFileSync(hook, `${lfs}${padding}\n${writesMarker()}\n`, { mode: 0o755 })
      const found = policy.trustStatusOf(repo, true).findings
      expect(
        found.map((f) => f.key),
        `${padding.length} padding`
      ).toEqual(['hooks'])
    }
  })

  it('looks into nested repositories git did not absorb (a gitlink, no .gitmodules)', async () => {
    const sub = join(repo, 'sub')
    execFileSync('git', ['init', '-q', '-b', 'main', sub])
    const s = (...args: string[]): string =>
      execFileSync('git', args, { cwd: sub, encoding: 'utf8', stdio: 'pipe' })
    s('config', 'user.name', 'Test')
    s('config', 'user.email', 'test@example.com')
    writeFileSync(join(sub, 'b.txt'), 'b\n')
    s('add', '.')
    s('commit', '-q', '-m', 'b')
    g('update-index', '--add', '--cacheinfo', `160000,${s('rev-parse', 'HEAD').trim()},sub`)
    g('commit', '-q', '-m', 'gitlink')
    s('config', 'core.fsmonitor', writesMarker())
    writeFileSync(join(sub, 'b.txt'), 'changed\n')
    const status = policy.trustStatusOf(repo, true)
    expect(status.findings.map((f) => [f.submodule, f.key])).toEqual([['sub', 'core.fsmonitor']])
    expect(await git(repo, ['status', '--porcelain=v2'])).toBe('')
    expect(ran()).toBe(false)
    gTry('status') // git goes into it
    expect(ran()).toBe(true)
  })

  it('counts submodules it did not get to as risky', async () => {
    const modules = join(repo, '.git', 'modules')
    for (let i = 0; i <= 100; i++) {
      mkdirSync(join(modules, `m${String(i).padStart(3, '0')}`), { recursive: true })
      writeFileSync(
        join(modules, `m${String(i).padStart(3, '0')}`, 'HEAD'),
        'ref: refs/heads/main\n'
      )
    }
    mkdirSync(join(modules, 'zz'))
    writeFileSync(join(modules, 'zz', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(modules, 'zz', 'config'), `[core]\n\tfsmonitor = "${writesMarker()}"\n`)
    const status = policy.trustStatusOf(repo, true)
    expect(status.findings.map((f) => f.key)).toEqual(['submodules'])
    expect(status.level).toBe('untrusted')
    // git still runs, with submodules left alone.
    expect(await git(repo, ['status', '--porcelain'])).toBe('')
  })

  it('finds nothing to warn about in an ordinary repository with a submodule', () => {
    const lib = mkdtempSync(join(base, 'lib-'))
    execFileSync('git', ['init', '-q', '-b', 'main', lib])
    const l = (...args: string[]): string =>
      execFileSync('git', args, { cwd: lib, encoding: 'utf8', stdio: 'pipe' })
    l('config', 'user.name', 'Test')
    l('config', 'user.email', 'test@example.com')
    writeFileSync(join(lib, 'c.txt'), 'c\n')
    l('add', '.')
    l('commit', '-q', '-m', 'c')
    // git writes core.worktree=../../../mod in .git/modules/mod/config.
    g('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'mod')
    g('commit', '-q', '-m', 'submodule')
    expect(policy.trustStatusOf(repo, true).findings).toEqual([])
    expect(policy.trustStatusOf(join(repo, 'mod'), true).level).toBe('clean')
  })

  it('follows git past a .git folder that is not a repository', async () => {
    g('config', 'core.fsmonitor', writesMarker())
    const app = join(repo, 'app')
    mkdirSync(join(app, '.git'), { recursive: true })
    expect(policy.policyRoot(app, ['status'])).toBe(repo)
    expect(policy.trustStatusOf(app, true).level).toBe('untrusted')
    await git(app, ['status', '--porcelain'])
    expect(ran()).toBe(false)
  })

  it('keeps working in the registered folder when core.worktree points elsewhere', async () => {
    const elsewhere = mkdtempSync(join(base, 'elsewhere-'))
    writeFileSync(join(elsewhere, 'unrelated.txt'), 'not yours\n')
    g('config', 'core.worktree', elsewhere)
    const listed = await git(repo, ['status', '--porcelain', '--untracked-files=all'])
    expect(listed).not.toContain('unrelated.txt')
    await expect(assertSafeWorkTree(repo)).resolves.toBeUndefined()
    // Trusted, git really works elsewhere: writes are refused.
    policy.trustRepo(repo)
    await expect(assertSafeWorkTree(repo)).rejects.toThrow(/instead of/)
  })

  it('pauses network commands that would run its own git server program', async () => {
    const remote = join(base, `remote-${n}.git`)
    execFileSync('git', ['init', '-q', '--bare', remote])
    g('remote', 'add', 'origin', remote)
    g('config', 'remote.origin.uploadpack', writesMarker())
    expect(policy.trustStatusOf(repo, true).networkPaused).toBe(true)
    await expect(git(repo, ['fetch', 'origin'])).rejects.toThrow(/paused/)
    expect(ran()).toBe(false)
    // Reading still works.
    expect(await git(repo, ['log', '--oneline'])).toContain('one')
    policy.trustRepo(repo)
    await git(repo, ['fetch', 'origin']).catch(() => undefined)
    expect(ran()).toBe(true)
  })

  it('uses its own SSH command only once trusted', async () => {
    g('remote', 'add', 'origin', 'ssh://127.0.0.1:1/nothing.git')
    g('config', 'core.sshCommand', writesMarker())
    await git(repo, ['ls-remote', 'origin']).catch(() => undefined)
    expect(ran()).toBe(false)
    gTry('-c', 'ssh.variant=ssh', 'ls-remote', 'origin')
    expect(ran()).toBe(true)
  })

  it('trusts repositories GitDesk created whatever they contain', () => {
    g('config', 'core.fsmonitor', writesMarker())
    policy.markCreatedByGitDesk(repo)
    const status = policy.trustStatusOf(repo)
    expect(status.level).toBe('trusted')
    expect(status.createdByGitDesk).toBe(true)
    policy.untrustRepo(repo)
    expect(policy.trustStatusOf(repo).level).toBe('untrusted')
  })

  it('gives worktrees of a trusted repository the same trust', () => {
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n', { mode: 0o755 })
    const tree = join(base, `tree-${n}`)
    g('worktree', 'add', '-q', '-b', `t${n}`, tree)
    store.addRepos([repo, tree])
    store.saveState({ ...store.loadState(), worktreeParents: { [tree]: repo } })
    expect(policy.trustStatusOf(tree).level).toBe('untrusted')
    policy.trustRepo(repo)
    expect(policy.trustStatusOf(tree).level).toBe('trusted')
  })
})

describe('credential helpers', () => {
  let server: Server
  let url = ''
  beforeAll(async () => {
    // Asks for a password on every request.
    server = createServer((_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/r.git`
  })
  afterAll(() => server?.close())

  it("drops the repository's own helpers, URL-scoped ones too", async () => {
    g('config', 'credential.helper', `!${writesMarker()}`)
    g('config', `credential.${url}.helper`, `!${writesMarker()}`)
    await expect(git(repo, ['ls-remote', url])).rejects.toThrow()
    expect(ran()).toBe(false)
    // Not execFileSync: the server answers from this process.
    await new Promise((resolve) =>
      execFile('git', ['ls-remote', url], { cwd: repo, timeout: 20_000 }, resolve)
    )
    expect(ran()).toBe(true)
  })
})

describe.runIf(process.platform === 'win32')('paths on another computer', () => {
  it('does not run git when objects come from another computer', async () => {
    // .invalid never resolves: nothing is contacted even if something tried.
    mkdirSync(join(repo, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(
      join(repo, '.git', 'objects', 'info', 'alternates'),
      '\\\\gitdesk-test.invalid\\share\\objects\n'
    )
    expect(policy.trustStatusOf(repo, true).level).toBe('blocked')
    await expect(git(repo, ['status'])).rejects.toThrow(/did not run git/)
  })

  it('decodes a quoted alternates entry like git (octal escapes)', () => {
    mkdirSync(join(repo, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(
      join(repo, '.git', 'objects', 'info', 'alternates'),
      '"\\134\\134gitdesk-test.invalid\\134share\\134objects"\n'
    )
    expect(policy.trustStatusOf(repo, true).level).toBe('blocked')
  })

  it('does not let git look at a worktree listed on another computer', async () => {
    const entry = join(repo, '.git', 'worktrees', 'w1')
    mkdirSync(entry, { recursive: true })
    writeFileSync(join(entry, 'gitdir'), '\\\\gitdesk-test.invalid\\share\\w1\\.git\n')
    const status = policy.trustStatusOf(repo, true)
    expect(status.level).toBe('blocked')
    expect(status.findings.map((f) => f.key)).toEqual(['worktrees'])
    await expect(git(repo, ['worktree', 'list', '--porcelain'])).rejects.toThrow(/did not run git/)
  })

  /** Makes a directory link to a share that never resolves; false when links need privileges here. */
  const linkElsewhere = (path: string): boolean => {
    try {
      symlinkSync('//gitdesk-test.invalid/share/data', path, 'dir')
      return true
    } catch {
      return false
    }
  }

  it('does not run git when a part of .git it reads is a link to another computer', async (ctx) => {
    for (const entry of ['logs', 'worktrees', 'modules']) {
      newRepo()
      const target = join(repo, '.git', entry)
      rmSync(target, { recursive: true, force: true })
      if (!linkElsewhere(target)) return ctx.skip()
      const status = policy.trustStatusOf(repo, true)
      expect(status.level, entry).toBe('blocked')
      await expect(git(repo, ['status'])).rejects.toThrow(/did not run git/)
    }
  })

  it('does not open an index kept on another computer', async (ctx) => {
    const index = join(repo, '.git', 'index')
    rmSync(index)
    if (!linkElsewhere(index)) return ctx.skip()
    expect(policy.trustStatusOf(repo, true).level).toBe('blocked')
    await expect(git(repo, ['status'])).rejects.toThrow(/did not run git/)
  })

  it('does not follow a .git file to another computer', () => {
    const dir = mkdtempSync(join(base, 'gitfile-'))
    writeFileSync(join(dir, '.git'), 'gitdir: //gitdesk-test.invalid/share/repo.git\n')
    const status = policy.trustStatusOf(dir, true)
    expect(status.level).toBe('blocked')
    expect(status.findings[0].key).toBe('.git')
  })
})
