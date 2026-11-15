import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseConfigList, parseGitConfig, splitKey } from '../../src/main/trust/gitconfig'
import { indexGitlinks, parseAlternates } from '../../src/main/trust/inspect'
import {
  classifyEntries,
  isInside,
  isLfsHook,
  isNetworkPath,
  ruleFor
} from '../../src/main/trust/rules'

const dir = mkdtempSync(join(tmpdir(), 'gitdesk-trust-config-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const values = (text: string): [string, string | null][] =>
  parseGitConfig(text).entries.map((e) => [e.key, e.value])

describe('parseGitConfig', () => {
  it('reads sections, subsections, bare keys and comments', () => {
    expect(
      values(
        [
          '# comment',
          '[Core]',
          '\tFSMonitor = run-me ; trailing comment',
          '\tbare',
          '[diff "Word Doc"]',
          '  textconv = "a  b" # c',
          '[Remote.Origin]',
          '  uploadPack = x'
        ].join('\n')
      )
    ).toEqual([
      ['core.fsmonitor', 'run-me'],
      ['core.bare', null],
      ['diff.Word Doc.textconv', 'a  b'],
      // The deprecated [section.sub] form is all lowercase, as in git.
      ['remote.origin.uploadpack', 'x']
    ])
  })

  it('handles quotes, escapes, continuations, CRLF, a BOM and a key after the header', () => {
    expect(
      values(
        '\uFEFF[a] x = 1\r\n[a]\r\n  y = "q\\"uote" \\\n  continued\r\n  z = tab\\there  \r\n  w = "#not a comment"\n[s "sub\\"q"]\n k = v'
      )
    ).toEqual([
      ['a.x', '1'],
      // Each blank outside quotes is kept as one space, the continuation itself removed.
      ['a.y', 'q"uote   continued'],
      ['a.z', 'tab\there'],
      ['a.w', '#not a comment'],
      ['s.sub"q.k', 'v']
    ])
  })

  it('stops at a line git would reject, keeping what came before', () => {
    const r = parseGitConfig('[a]\n x = 1\n 9bad = 2\n y = 3')
    expect(r.entries).toEqual([{ key: 'a.x', value: '1' }])
    expect(r.error).toBeTruthy()
    expect(parseGitConfig('[a]\n x = "open').error).toBeTruthy()
    expect(parseGitConfig('[a]\n x = \\q').error).toBeTruthy()
  })

  it('reads the same keys and values as git itself', () => {
    const text = [
      '[core]',
      '  fsmonitor = "sh -c \'echo x\'"   ; c',
      '  hooksPath = hooks\\\\dir',
      '[credential "https://Host.example"]',
      '  helper = !f() { echo "a b"; }; f',
      '[filter "lfs"]',
      '  clean = git-lfs clean -- %f',
      '  required',
      '[url "https://mirror.example/"]',
      '  insteadOf = https://origin.example/',
      '[includeIf "gitdir:~/work/"]',
      '  path = ../other.inc',
      '[x] k1 = v1',
      '[y "sub.with.dots"]',
      '  Name-2 = "  spaced  " tail  ',
      '  cont = one \\',
      'two'
    ].join('\n')
    const file = join(dir, 'parity')
    writeFileSync(file, text)
    let out: string
    try {
      out = execFileSync('git', ['config', '--file', file, '--no-includes', '--list', '-z'], {
        encoding: 'utf8'
      })
    } catch {
      return // no git here
    }
    const fromGit = out
      .split('\0')
      .filter(Boolean)
      .map((kv): [string, string | null] => {
        const nl = kv.indexOf('\n')
        return nl < 0 ? [kv, null] : [kv.slice(0, nl), kv.slice(nl + 1)]
      })
    expect(values(text)).toEqual(fromGit)
  })
})

describe('config helpers', () => {
  it('splits keys', () => {
    expect(splitKey('diff.my.driver.textconv')).toEqual({
      section: 'diff',
      sub: 'my.driver',
      name: 'textconv'
    })
    expect(splitKey('core.fsmonitor')).toEqual({ section: 'core', sub: null, name: 'fsmonitor' })
  })

  it('parses git config --list --show-scope -z', () => {
    expect(parseConfigList('system\0a.b\nc\0global\0d.e\0')).toEqual([
      { scope: 'system', key: 'a.b', value: 'c' },
      { scope: 'global', key: 'd.e', value: null }
    ])
  })
})

describe('isNetworkPath', () => {
  it('recognizes paths on another computer on Windows', () => {
    for (const p of [
      '\\\\host\\share\\x',
      '//host/share',
      '\\\\?\\UNC\\host\\share',
      '\\\\.\\pipe\\x',
      'file://host/share/repo.git',
      'file:////host/share'
    ])
      expect(isNetworkPath(p, 'win32'), p).toBe(true)
    for (const p of [
      'C:\\repo',
      '\\\\?\\C:\\long\\path',
      'relative\\x',
      'file:///C:/repo.git',
      'file://localhost/C:/x',
      'https://host/x'
    ])
      expect(isNetworkPath(p, 'win32'), p).toBe(false)
  })

  it('is never true elsewhere', () => {
    expect(isNetworkPath('//host/share', 'linux')).toBe(false)
  })

  it('isInside', () => {
    expect(isInside(join(dir, 'a', 'b'), dir)).toBe(true)
    expect(isInside(dir, dir)).toBe(true)
    expect(isInside(join(dir, '..', 'x'), dir)).toBe(false)
  })
})

describe('rules', () => {
  const effect = (key: string, value: string | null): string | null =>
    ruleFor(key, value)?.effect ?? null

  it('flags settings that start programs', () => {
    for (const key of [
      'core.fsmonitor',
      'core.hookspath',
      'core.sshcommand',
      'core.askpass',
      'core.gitproxy',
      'core.worktree',
      'diff.external',
      'diff.x.textconv',
      'diff.x.command',
      'filter.x.clean',
      'filter.x.smudge',
      'filter.x.process',
      'merge.x.driver',
      'credential.helper',
      'credential.https://h.example.helper',
      'gpg.program',
      'gpg.ssh.program',
      'sequence.editor',
      'protocol.ext.allow'
    ])
      expect(effect(key, 'some-program'), key).toBe('ignored')
  })

  it('flags settings that change how git connects', () => {
    for (const key of [
      'http.sslverify',
      'http.https://h.example.sslverify',
      'http.sslcainfo',
      'http.proxy',
      'http.extraheader',
      'remote.origin.uploadpack',
      'remote.origin.proxy',
      'url.https://evil.example/.insteadof'
    ])
      expect(effect(key, 'false'), key).toBe('network')
  })

  it('leaves harmless settings alone', () => {
    expect(effect('core.fsmonitor', 'true')).toBeNull()
    expect(effect('http.sslverify', 'true')).toBeNull()
    expect(effect('http.postbuffer', '524288000')).toBeNull()
    expect(effect('credential.helper', '')).toBeNull()
    expect(effect('filter.lfs.clean', 'git-lfs clean -- %f')).toBeNull()
    expect(effect('filter.lfs.clean', 'git-lfs clean -- %f; other')).toBe('ignored')
    expect(effect('submodule.x.update', 'rebase')).toBeNull()
    expect(effect('submodule.x.update', '!run')).toBe('ignored')
    expect(effect('remote.origin.url', 'https://h.example/r.git')).toBeNull()
    expect(effect('user.name', 'Me')).toBeNull()
  })

  it.runIf(process.platform === 'win32')('treats paths on another computer apart', () => {
    const repo = 'C:\\work\\repo'
    const found = classifyEntries(
      [
        { key: 'core.excludesfile', value: '\\\\host\\share\\ignore', file: 'config' },
        { key: 'remote.origin.url', value: '\\\\host\\share\\repo.git', file: 'config' },
        { key: 'url.\\\\host\\share\\.insteadof', value: 'https://x.example/', file: 'config' },
        { key: 'core.excludesfile', value: 'C:\\work\\repo\\ignore', file: 'config' }
      ],
      repo,
      'win32'
    )
    expect(found.map((f) => [f.key, f.effect])).toEqual([
      ['core.excludesfile', 'blocked'],
      ['remote.origin.url', 'network'],
      ['url.\\\\host\\share\\.insteadof', 'network']
    ])
  })

  it.runIf(process.platform === 'win32')(
    'blocks a partial clone whose remote is on another computer (it downloads while reading)',
    () => {
      const remote = { key: 'remote.origin.url', value: '\\\\host\\share\\repo.git', file: 'c' }
      for (const marker of [
        { key: 'remote.origin.promisor', value: 'true', file: 'c' },
        { key: 'remote.origin.partialclonefilter', value: 'blob:none', file: 'c' },
        { key: 'extensions.partialclone', value: 'origin', file: 'c' }
      ]) {
        const found = classifyEntries([marker, remote], 'C:\\work\\repo', 'win32')
        expect(
          found.map((f) => f.effect),
          marker.key
        ).toEqual(['blocked'])
      }
      const notPartial = { key: 'remote.origin.promisor', value: 'false', file: 'c' }
      expect(
        classifyEntries([notPartial, remote], 'C:\\work\\repo', 'win32').map((f) => f.effect)
      ).toEqual(['network'])
    }
  )
})

describe('files that redirect where git reads', () => {
  const alternates = (text: string): ReturnType<typeof parseAlternates> =>
    parseAlternates(Buffer.from(text, 'utf8'))

  it('decodes alternates like git, octal escapes included', () => {
    expect(alternates('# comment\n../other/objects\n\n/abs/objects\n').paths).toEqual([
      '../other/objects',
      '/abs/objects'
    ])
    // git's unquote_c_style: \134 is a backslash, so this names a path on another computer.
    expect(alternates('"\\134\\134host\\134share\\134objects"\n')).toEqual({
      paths: ['\\\\host\\share\\objects'],
      undecodable: false
    })
    expect(alternates('"a\\tb\\"c\\303\\251"\n').paths).toEqual(['a\tb"c\u00e9'])
    expect(alternates('one\0"\\134\\134host"\n').paths).toEqual(['one'])
    // A quoted entry git would read some other way is not guessed.
    expect(alternates('"\\q\\134\\134host"\n').undecodable).toBe(true)
    expect(alternates('"unterminated\n').undecodable).toBe(true)
  })

  it('finds the submodules recorded in an index, in every index version', () => {
    const repo = mkdtempSync(join(dir, 'index-'))
    const g = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
    g('init', '-q')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    g('add', 'a.txt')
    const sha = g('hash-object', 'a.txt').trim()
    for (const path of ['lib/one', 'lib/two', 'z'])
      g('update-index', '--add', '--cacheinfo', `160000,${sha},${path}`)
    for (const version of ['2', '3', '4']) {
      g('update-index', '--index-version', version)
      const links = indexGitlinks(readFileSync(join(repo, '.git', 'index')))
      expect(links, `index v${version}`).toEqual(['lib/one', 'lib/two', 'z'])
    }
    expect(indexGitlinks(Buffer.from('not an index'))).toBeNull()
  })
})

describe('Git LFS hooks', () => {
  // As git-lfs 3 and git-lfs 2 write them.
  const v3 = (hook: string): string =>
    `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { printf >&2 "\\n%s\\n\\n" "This repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the '${hook}' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks')."; exit 2; }\ngit lfs ${hook} "$@"\n`
  const v2 = (hook: string): string =>
    `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 "\\nThis repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting .git/hooks/${hook}.\\n"; exit 2; }\ngit lfs ${hook} "$@"\n`

  it('recognizes the hooks git-lfs writes', () => {
    for (const hook of ['pre-push', 'post-checkout', 'post-commit', 'post-merge']) {
      expect(isLfsHook(hook, v3(hook)), hook).toBe(true)
      expect(isLfsHook(hook, v2(hook).replace(/\n/g, '\r\n')), hook).toBe(true)
    }
  })

  it('flags anything else', () => {
    expect(isLfsHook('pre-commit', v3('pre-commit'))).toBe(false)
    expect(isLfsHook('pre-push', v3('post-checkout'))).toBe(false)
    expect(isLfsHook('pre-push', v3('pre-push') + 'echo more\n')).toBe(false)
    expect(isLfsHook('pre-push', v3('pre-push').replace('%s', '$(other)'))).toBe(false)
    expect(isLfsHook('pre-push', v3('pre-push').replace('not found', '`other`'))).toBe(false)
    expect(isLfsHook('pre-push', v3('pre-push').replace('exit 2;', 'other;'))).toBe(false)
    expect(isLfsHook('pre-push', v3('pre-push').replace('"$@"', '"$@"; other'))).toBe(false)
  })
})
