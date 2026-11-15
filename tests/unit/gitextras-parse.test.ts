import { describe, expect, it } from 'vitest'
import { looksLikeMbox, parseNameStatus } from '../../src/main/gitextras/core'
import {
  cleanFlowName,
  defaultBase,
  DEFAULT_PREFIXES,
  finishPlan,
  gitflowConfigProblem,
  gitflowEntries,
  gitflowFromConfig,
  overlap,
  parseBranchRefs,
  parseConfigZ,
  parseFlowBranch,
  parseGitVersion,
  parseLineLog,
  parseMergeTree,
  pickCandidates,
  supportsMergeTree,
  type BranchRef
} from '../../src/main/gitextras/parse'
import type { GitflowConfig } from '../../src/shared/features/gitextras'

const config: GitflowConfig = {
  main: 'main',
  develop: 'develop',
  prefixes: { ...DEFAULT_PREFIXES, versiontag: 'v' }
}

// Field separators the old formats used: a commit message or a name may hold them.
const FS = '\x1f'
const RS = '\x1e'
const P1 = '1'.repeat(40)
const P2 = '2'.repeat(40)

describe('parseLineLog', () => {
  // What LINE_LOG_FORMAT prints: a NUL before each record, one after each field.
  const header = (sha: string, subject: string): string =>
    `\0${sha}\0${P1} ${P2}\0Ann\0ann@x\0${1700000000}\0${subject}\0`
  const patch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -2,2 +2,2 @@',
    '-2x',
    '+2z',
    ' 3'
  ].join('\n')

  it('splits commits and their range diffs', () => {
    const out = `${header('a'.repeat(40), 'four')}\n\n${patch}\n${header('b'.repeat(40), `with ${FS}${RS} sep`)}\n\n${patch}\n`
    const entries = parseLineLog(out)
    expect(entries).toHaveLength(2)
    expect(entries[0].commit).toEqual({
      sha: 'a'.repeat(40),
      parents: [P1, P2],
      author: 'Ann',
      email: 'ann@x',
      date: 1700000000,
      subject: 'four'
    })
    expect(entries[0].patch).toBe(patch + '\n')
    expect(entries[1].commit.subject).toBe(`with ${FS}${RS} sep`)
  })

  it('drops a record whose header is not a commit, without shifting the others', () => {
    const out = `\0nope\0\0A\0a@x\0x\0bad\0\n\n${patch}\n${header('d'.repeat(40), 'good')}\n\n${patch}\n`
    const entries = parseLineLog(out)
    expect(entries.map((e) => e.commit.subject)).toEqual(['good'])
    expect(entries[0].patch).toBe(patch + '\n')
  })

  it('handles a commit without a diff and empty output', () => {
    expect(parseLineLog('')).toEqual([])
    const entries = parseLineLog(`${header('c'.repeat(40), 'merge')}\n`)
    expect(entries[0].patch).toBe('')
  })
})

describe('gitflow helpers', () => {
  it('reads AVH and newer config keys', () => {
    const entries = parseConfigZ(
      'gitflow.branch.master\nmaster\0gitflow.branch.develop\ndev\0gitflow.prefix.feature\nf/\0gitflow.prefix.versiontag\n\0'
    )
    expect(gitflowFromConfig(entries)).toEqual({
      main: 'master',
      develop: 'dev',
      prefixes: { ...DEFAULT_PREFIXES, feature: 'f/', versiontag: '' }
    })
    const newer = parseConfigZ('gitflow.branch.main\ntrunk\0gitflow.branch.develop\ndevelop\0')
    expect(gitflowFromConfig(newer)?.main).toBe('trunk')
    expect(gitflowFromConfig(parseConfigZ('gitflow.branch.develop\ndevelop\0'))).toBeNull()
  })

  it('round-trips the entries it writes', () => {
    const map = new Map(gitflowEntries(config))
    expect(map.get('gitflow.branch.master')).toBe('main')
    expect(map.get('gitflow.branch.main')).toBe('main')
    expect(gitflowFromConfig(map)).toEqual(config)
  })

  it('validates configurations', () => {
    expect(gitflowConfigProblem(config)).toBeNull()
    expect(gitflowConfigProblem({ ...config, develop: 'main' })).toMatch(/different/)
    expect(gitflowConfigProblem({ ...config, main: ' ' })).toMatch(/production/)
    expect(
      gitflowConfigProblem({ ...config, prefixes: { ...config.prefixes, feature: '' } })
    ).toMatch(/feature prefix cannot be empty/)
    expect(
      gitflowConfigProblem({ ...config, prefixes: { ...config.prefixes, release: 'rel ease/' } })
    ).toMatch(/Invalid release prefix/)
  })

  it('recognizes flow branches, longest prefix first', () => {
    expect(parseFlowBranch(config, 'feature/login')).toEqual({ kind: 'feature', name: 'login' })
    expect(parseFlowBranch(config, 'hotfix/1.0.1')).toEqual({ kind: 'hotfix', name: '1.0.1' })
    expect(parseFlowBranch(config, 'feature/')).toBeNull()
    expect(parseFlowBranch(config, 'main')).toBeNull()
    expect(parseFlowBranch(config, null)).toBeNull()
    const nested = { ...config, prefixes: { ...config.prefixes, feature: 'f/', bugfix: 'f/fix/' } }
    expect(parseFlowBranch(nested, 'f/fix/x')).toEqual({ kind: 'bugfix', name: 'x' })
  })

  it('cleans names and picks bases', () => {
    expect(cleanFlowName(config, 'feature', '  login page ')).toBe('login-page')
    expect(cleanFlowName(config, 'feature', 'feature/x')).toBe('x')
    expect(defaultBase(config, 'hotfix')).toBe('main')
    expect(defaultBase(config, 'release')).toBe('develop')
  })

  it('plans finishes like git-flow', () => {
    expect(finishPlan(config, 'feature', 'x', { tag: false, deleteBranch: true })).toEqual([
      { type: 'merge', into: 'develop', source: 'branch' },
      { type: 'delete' }
    ])
    expect(finishPlan(config, 'release', '1.0', { tag: true, deleteBranch: false })).toEqual([
      { type: 'merge', into: 'main', source: 'branch' },
      { type: 'tag', tag: 'v1.0', on: 'main' },
      { type: 'merge', into: 'develop', source: { tag: 'v1.0' } }
    ])
    expect(
      finishPlan(config, 'hotfix', '1.0.1', {
        tag: false,
        deleteBranch: true,
        releaseBranch: 'release/1.1'
      })
    ).toEqual([
      { type: 'merge', into: 'main', source: 'branch' },
      { type: 'merge', into: 'release/1.1', source: 'branch' },
      { type: 'delete' }
    ])
  })
})

describe('conflict prevention helpers', () => {
  it('detects git versions with merge-tree --write-tree', () => {
    expect(parseGitVersion('git version 2.49.0.windows.1')).toEqual([2, 49, 0])
    expect(supportsMergeTree(parseGitVersion('git version 2.38.0'))).toBe(true)
    expect(supportsMergeTree(parseGitVersion('git version 2.37.9'))).toBe(false)
    expect(supportsMergeTree(parseGitVersion('git version 3.0'))).toBe(true)
    expect(supportsMergeTree(null)).toBe(false)
  })

  it('parses merge-tree output', () => {
    expect(parseMergeTree('3386c40e\0a.txt\0b.txt\0a.txt\0', 1)).toEqual({
      conflict: true,
      files: ['a.txt', 'b.txt']
    })
    expect(parseMergeTree('3386c40e\0', 0)).toEqual({ conflict: false, files: [] })
  })

  it('computes overlapping files', () => {
    expect(overlap(['a', 'b', 'c'], ['c', 'd', 'a', 'a'])).toEqual(['a', 'c'])
    expect(overlap([], ['a'])).toEqual([])
  })

  it('parses refs and picks recent candidates, remote first', () => {
    // What REF_FORMAT prints: NUL-terminated fields, one ref per line.
    const ref = (...f: string[]): string => f.map((x) => `${x}\0`).join('') + '\n'
    const out = [
      ref('refs/heads/mine', '1'.repeat(40), '1000', 'Me', `my work`),
      ref('refs/heads/old', '2'.repeat(40), '10', 'Old', `old`),
      ref('refs/heads/feature/y', '3'.repeat(40), '900', 'Bo', `y`),
      ref('refs/remotes/origin/HEAD', '4'.repeat(40), '950', 'x', `x`),
      ref('refs/remotes/origin/feature/y', '3'.repeat(40), '900', 'Bo', `y`),
      ref('refs/remotes/origin/z', '5'.repeat(40), '800', 'Cy', `z${FS}more`),
      ref('refs/remotes/origin/mine', '6'.repeat(40), '990', 'Me', `pushed`),
      ref('refs/tags/v1', '7'.repeat(40), '999', 'T', `t`)
    ].join('')
    const refs = parseBranchRefs(out)
    expect(refs.map((r) => r.name)).toEqual([
      'mine',
      'old',
      'feature/y',
      'origin/feature/y',
      'origin/z',
      'origin/mine'
    ])
    expect(refs.find((r) => r.name === 'origin/z')?.subject).toBe(`z${FS}more`)
    const picked = pickCandidates(refs, {
      now: 86400 + 850, // since 850: "old" and origin/z are too old
      days: 1,
      max: 10,
      exclude: ['mine', 'origin/mine'],
      headSha: '1'.repeat(40)
    })
    expect(picked.map((r: BranchRef) => r.name)).toEqual(['origin/feature/y'])
    const capped = pickCandidates(refs, {
      now: 1000,
      days: 1,
      max: 2,
      exclude: ['mine'],
      headSha: null
    })
    expect(capped.map((r) => r.name)).toEqual(['origin/mine', 'origin/feature/y'])
  })
})

describe('patch helpers', () => {
  it('tells mailboxes from plain diffs', () => {
    expect(looksLikeMbox(`From ${'a'.repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: A <a@x>\n`)).toBe(
      true
    )
    expect(looksLikeMbox('From: A <a@x>\nSubject: [PATCH] x\n\n---\ndiff --git a/x b/x\n')).toBe(
      true
    )
    expect(looksLikeMbox('diff --git a/x b/x\n--- a/x\n+++ b/x\n')).toBe(false)
    expect(looksLikeMbox('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-From: a\n+Subject: b\n')).toBe(false)
  })

  it('parses name-status output with renames', () => {
    expect(parseNameStatus('M\0a.txt\0R100\0old.txt\0new.txt\0A\0b.txt\0')).toEqual([
      { kind: 'M', path: 'a.txt' },
      { kind: 'R', origPath: 'old.txt', path: 'new.txt' },
      { kind: 'A', path: 'b.txt' }
    ])
  })
})
