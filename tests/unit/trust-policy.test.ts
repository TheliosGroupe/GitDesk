import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'
import type { TrustFinding } from '../../src/shared/features/trust'
import type { Inspection } from '../../src/main/trust/inspect'

vi.mock('electron', () => ({ app: { getPath: () => '' }, dialog: {} }))

const { buildPolicy, KEEPALIVE_SSH, outerConfigFrom, trustLevel } =
  await import('../../src/main/trust/policy')
const { fingerprint } = await import('../../src/main/trust/inspect')
const { ruleFor } = await import('../../src/main/trust/rules')

const REPO = '/work/repo'
const NO_HOOKS = '/gitdesk/no-hooks'

/** An inspection with these repository settings (and their findings). */
function inspection(entries: [string, string | null][], extra: TrustFinding[] = []): Inspection {
  const list = entries.map(([key, value]) => ({ key, value, file: '/work/repo/.git/config' }))
  const findings: TrustFinding[] = [
    ...list.flatMap((e) => {
      const rule = ruleFor(e.key, e.value)
      return rule ? [{ key: e.key, value: e.value ?? '', file: e.file, ...rule }] : []
    }),
    ...extra
  ]
  return {
    repo: REPO,
    gitDir: '/work/repo/.git',
    commonDir: '/work/repo/.git',
    entries: list,
    findings,
    fingerprint: fingerprint(findings),
    stamps: []
  }
}

const outer = (
  entries: [string, string, string | null][] = []
): ReturnType<typeof outerConfigFrom> =>
  outerConfigFrom(entries.map(([scope, key, value]) => ({ scope, key, value })))

function policyFor(
  entries: [string, string | null][],
  opts: {
    trusted?: boolean
    network?: boolean
    outer?: [string, string, string | null][]
    env?: NodeJS.ProcessEnv
    extra?: TrustFinding[]
  } = {}
): ReturnType<typeof buildPolicy> {
  return buildPolicy({
    repo: REPO,
    inspection: inspection(entries, opts.extra),
    trusted: opts.trusted ?? false,
    network: opts.network ?? false,
    outer: outer(opts.outer),
    env: opts.env ?? {},
    noHooksDir: NO_HOOKS
  })
}

/** The variables a test is about (not the ceiling and low-speed ones every command gets). */
const ownEnv = (p: { env: Record<string, string> }): Record<string, string> =>
  Object.fromEntries(
    Object.entries(p.env).filter(([k]) => !/^GIT_(CEILING_DIRECTORIES|HTTP_LOW_SPEED_)/.test(k))
  )

/** The `-c` settings as key=value strings. */
const settings = (p: { args: string[] }): string[] => p.args.filter((_, i) => i % 2 === 1)

describe('buildPolicy', () => {
  it('neutralizes program settings, or uses your own value for them', () => {
    const p = policyFor(
      [
        ['core.fsmonitor', 'run-me'],
        ['diff.x.textconv', 'conv'],
        ['filter.lfs.process', 'other-lfs'],
        ['filter.y.clean', 'clean-me'],
        ['filter.y.required', 'true'],
        ['merge.z.driver', 'merge-me'],
        ['core.askpass', 'ask-me'],
        ['gpg.program', 'sign-me'],
        ['sequence.editor', 'edit-me']
      ],
      { outer: [['global', 'filter.lfs.process', 'git-lfs filter-process']] }
    )
    expect(settings(p)).toEqual([
      'core.fsmonitor=false',
      'diff.x.textconv=',
      // Your global Git LFS keeps working.
      'filter.lfs.process=git-lfs filter-process',
      'filter.y.clean=',
      'merge.z.driver=',
      'core.askpass=',
      'gpg.program=gpg',
      'sequence.editor=true',
      'filter.y.required=false'
    ])
    expect(p.blocked).toBeUndefined()
    expect(p.networkPaused).toBeUndefined()
  })

  it('changes nothing for a trusted or clean repository', () => {
    for (const p of [
      policyFor([['core.fsmonitor', 'run-me']], { trusted: true }),
      policyFor([['user.name', 'Me']])
    ]) {
      expect(p.args).toEqual([])
      expect(ownEnv(p)).toEqual({})
      expect(p.blocked ?? p.networkPaused).toBeUndefined()
    }
  })

  it('points hooks at an empty folder unless you have your own hooks folder', () => {
    const hooks: TrustFinding = {
      key: 'hooks',
      value: 'pre-commit',
      file: '',
      text: '',
      effect: 'ignored'
    }
    expect(settings(policyFor([], { extra: [hooks] }))).toEqual([`core.hooksPath=${NO_HOOKS}`])
    expect(
      settings(
        policyFor([], { extra: [hooks], outer: [['global', 'core.hookspath', '/my/hooks']] })
      )
    ).toEqual([])
    expect(settings(policyFor([['core.hookspath', '.husky']]))).toEqual([
      `core.hooksPath=${NO_HOOKS}`
    ])
  })

  it("replaces the repository's credential helpers with yours, in order", () => {
    const p = policyFor([['credential.https://h.example.helper', '!steal']], {
      outer: [
        ['system', 'credential.helper', 'manager'],
        ['global', 'credential.https://dev.azure.com.usehttppath', 'true'],
        ['global', 'credential.https://h.example.helper', 'store'],
        ['local', 'credential.helper', '!not-yours']
      ]
    })
    expect(settings(p)).toEqual([
      'credential.helper=',
      'credential.helper=manager',
      'credential.https://h.example.helper=store'
    ])
  })

  it("keeps your SSH command, else uses ssh with keepalives instead of the repository's", () => {
    const local: [string, string][] = [['core.sshcommand', 'evil']]
    expect(policyFor(local).env.GIT_SSH_COMMAND).toBe(KEEPALIVE_SSH)
    expect(
      settings(policyFor(local, { outer: [['global', 'core.sshcommand', 'ssh -i k']] }))
    ).toEqual(['core.sshCommand=ssh -i k'])
    expect(ownEnv(policyFor(local, { env: { GIT_SSH: 'C:\\Program Files\\plink.exe' } }))).toEqual({
      GIT_SSH_COMMAND: "'C:\\Program Files\\plink.exe'"
    })
    // Your GIT_SSH_COMMAND already wins over any config.
    expect(ownEnv(policyFor(local, { env: { GIT_SSH_COMMAND: 'mine' } }))).toEqual({})
  })

  it('adds ssh keepalives to network commands when nobody chose an SSH command', () => {
    expect(policyFor([], { network: true }).env.GIT_SSH_COMMAND).toBe(KEEPALIVE_SSH)
    expect(policyFor([], { network: false }).env.GIT_SSH_COMMAND).toBeUndefined()
    expect(
      ownEnv(policyFor([], { network: true, outer: [['global', 'core.sshcommand', 'x']] }))
    ).toEqual({})
    expect(
      policyFor([], { network: true, outer: [['global', 'ssh.variant', 'plink']] }).env
        .GIT_SSH_COMMAND
    ).toBe('ssh')
    expect(
      ownEnv(policyFor([['core.sshcommand', 'mine']], { network: true, trusted: true }))
    ).toEqual({})
  })

  it('leaves the timeouts of your own ssh config alone', () => {
    const input = {
      repo: REPO,
      inspection: inspection([['core.sshcommand', 'evil']]),
      trusted: false,
      network: true,
      outer: outer(),
      env: {},
      noHooksDir: NO_HOOKS,
      sshTimeoutsConfigured: true
    }
    // The repository's command is still replaced, by plain ssh: your config applies.
    expect(buildPolicy(input).env.GIT_SSH_COMMAND).toBe('ssh')
    expect(buildPolicy({ ...input, inspection: inspection([]) }).env.GIT_SSH_COMMAND).toBe(
      undefined
    )
  })

  it('pauses the network for settings that change how git connects', () => {
    const p = policyFor([
      ['http.https://h.example.sslverify', 'false'],
      ['url.https://evil.example/.insteadof', 'https://h.example/']
    ])
    expect(p.networkPaused).toMatch(/paused/)
    expect(p.networkPaused).toContain('http.https://h.example.sslverify')
    expect(p.env.GIT_NO_LAZY_FETCH).toBe('1')
    expect(p.blocked).toBeUndefined()
  })

  it('blocks git for paths on another computer and for settings -c cannot name', () => {
    const remote: TrustFinding = {
      key: 'objects/info/alternates',
      value: '\\\\host\\share',
      file: '',
      text: '',
      effect: 'blocked'
    }
    expect(policyFor([], { extra: [remote] }).blocked).toMatch(/did not run git/)
    expect(policyFor([['diff.a=b.textconv', 'x']]).blocked).toMatch(/diff\.a=b\.textconv/)
  })

  it('pins the work tree, and stops git going into risky submodules', () => {
    expect(policyFor([['core.worktree', '/elsewhere']]).env.GIT_WORK_TREE).toBe(REPO)
    const sub: TrustFinding = {
      key: 'core.fsmonitor',
      value: 'x',
      file: '',
      text: '',
      effect: 'ignored',
      submodule: 'lib'
    }
    expect(settings(policyFor([], { extra: [sub] }))).toEqual([
      'submodule.recurse=false',
      'fetch.recurseSubmodules=false',
      'diff.ignoreSubmodules=all'
    ])
  })

  it("gives protocol settings git's defaults back", () => {
    expect(settings(policyFor([['protocol.allow', 'always']]))).toEqual([
      'protocol.http.allow=always',
      'protocol.https.allow=always',
      'protocol.ssh.allow=always',
      'protocol.git.allow=always',
      'protocol.file.allow=user'
    ])
    expect(settings(policyFor([['protocol.ext.allow', 'always']]))).toEqual([
      'protocol.ext.allow=never'
    ])
  })

  it('uses GIT_PROXY_COMMAND to drop a repository proxy program', () => {
    expect(policyFor([['core.gitproxy', 'evil']]).env.GIT_PROXY_COMMAND).toBe('')
  })

  it('gives no password and downloads no Git LFS file while the network is paused', () => {
    const p = policyFor(
      [
        ['http.proxy', 'http://proxy.example'],
        ['credential.helper', 'evil']
      ],
      { outer: [['global', 'credential.helper', 'manager']] }
    )
    expect(p.env.GIT_LFS_SKIP_SMUDGE).toBe('1')
    // Every helper cleared, the repository's and yours (git-lfs would ask them too).
    expect(settings(p).filter((s) => s.startsWith('credential.'))).toEqual(['credential.helper='])
    expect(policyFor([['credential.helper', 'evil']]).env.GIT_LFS_SKIP_SMUDGE).toBeUndefined()
  })

  it('does not let git look above the repository it inspected', () => {
    expect(policyFor([]).env.GIT_CEILING_DIRECTORIES).toBe(resolve('/work'))
    expect(policyFor([], { trusted: true }).env.GIT_CEILING_DIRECTORIES).toBe(resolve('/work'))
  })

  it('stops stalled https transfers, unless you chose your own low-speed limit', () => {
    const low = (p: ReturnType<typeof buildPolicy>): [string?, string?] => [
      p.env.GIT_HTTP_LOW_SPEED_LIMIT,
      p.env.GIT_HTTP_LOW_SPEED_TIME
    ]
    expect(low(policyFor([], { network: true }))).toEqual(['1', '120'])
    expect(low(policyFor([]))).toEqual([undefined, undefined])
    expect(
      low(policyFor([], { network: true, outer: [['global', 'http.lowspeedlimit', '1000']] }))
    ).toEqual([undefined, undefined])
    expect(
      low(
        policyFor([], {
          network: true,
          outer: [['global', 'http.https://h.example.lowspeedtime', '9']]
        })
      )
    ).toEqual([undefined, undefined])
    expect(low(policyFor([['http.lowspeedtime', '30']], { network: true }))).toEqual([
      undefined,
      undefined
    ])
    expect(low(policyFor([], { network: true, env: { GIT_HTTP_LOW_SPEED_TIME: '30' } }))).toEqual([
      undefined,
      undefined
    ])
  })

  it('keeps git out of submodules GitDesk could not check, without a broken -c', () => {
    const unchecked: TrustFinding = {
      key: 'submodules',
      value: 'more than 100 submodules',
      file: '',
      text: '',
      effect: 'ignored'
    }
    expect(settings(policyFor([], { extra: [unchecked] }))).toEqual([
      'submodule.recurse=false',
      'fetch.recurseSubmodules=false',
      'diff.ignoreSubmodules=all'
    ])
  })
})

describe('trust levels and fingerprints', () => {
  it('levels', () => {
    expect(trustLevel(null, false)).toBe('clean')
    expect(trustLevel(inspection([['core.fsmonitor', 'x']]), false)).toBe('untrusted')
    expect(trustLevel(inspection([['core.fsmonitor', 'x']]), true)).toBe('trusted')
  })

  it('fingerprints the set of findings, whatever the order', () => {
    const a = inspection([
      ['core.fsmonitor', 'x'],
      ['diff.d.textconv', 'y']
    ])
    const b = inspection([
      ['diff.d.textconv', 'y'],
      ['core.fsmonitor', 'x']
    ])
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(inspection([['core.fsmonitor', 'z']]).fingerprint).not.toBe(a.fingerprint)
  })
})
