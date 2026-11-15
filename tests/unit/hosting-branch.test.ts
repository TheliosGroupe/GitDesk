import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { branchNameForIssue, slugify, uniqueBranchName } from '../../src/main/hosting/branchName'

const validBranch = (name: string): boolean => {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('branch names for issues', () => {
  it('slugifies titles', () => {
    expect(slugify('Fix the Login page (iOS)!')).toBe('fix-the-login-page-ios')
    expect(slugify('Évènement déjà vu — ça marche')).toBe('evenement-deja-vu-ca-marche')
    expect(slugify('   ')).toBe('')
    expect(slugify('a'.repeat(60))).toHaveLength(40)
    expect(slugify('one two three four five six seven eight nine ten', 20)).toBe(
      'one-two-three-four'
    )
  })

  it('names GitHub / GitLab branches after the number, others after the key', () => {
    expect(
      branchNameForIssue({ source: 'github', key: '#123', number: 123, title: 'Crash on start' })
    ).toBe('123-crash-on-start')
    expect(branchNameForIssue({ source: 'gitlab', key: '#7', number: 7, title: '' })).toBe(
      'issue-7'
    )
    expect(
      branchNameForIssue({ source: 'jira', key: 'PROJ-123', number: null, title: 'Short title' })
    ).toBe('feature/PROJ-123-short-title')
    expect(branchNameForIssue({ source: 'linear', key: 'ENG-9', number: null, title: '🎉' })).toBe(
      'feature/ENG-9'
    )
    // Odd keys cannot break the ref name.
    expect(
      branchNameForIssue({ source: 'jira', key: '../X..Y:~^', number: null, title: 'x' })
    ).toBe('feature/XY-x')
  })

  it('always gives names git accepts', () => {
    const titles = ['Fix: "quotes" & <tags>', '.hidden', 'end.lock', 'a..b', 'x~y^z:w?*[', '@{u}']
    for (const title of titles) {
      for (const source of ['github', 'jira'] as const) {
        const name = branchNameForIssue({
          source,
          key: source === 'github' ? '#5' : 'AB-5',
          number: source === 'github' ? 5 : null,
          title
        })
        expect(validBranch(name), name).toBe(true)
      }
    }
  })

  it('adds a suffix when the name is taken', () => {
    const taken = new Set(['a', 'a-2'])
    expect(uniqueBranchName('a', (n) => taken.has(n))).toBe('a-3')
    expect(uniqueBranchName('b', (n) => taken.has(n))).toBe('b')
  })
})
