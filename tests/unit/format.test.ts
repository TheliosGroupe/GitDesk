import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dirName,
  errorMessage,
  fileName,
  fullDate,
  hueFor,
  initials,
  relativeTime,
  repoName,
  shortSha
} from '../../src/renderer/src/lib/format'

describe('relativeTime', () => {
  const now = new Date(2024, 5, 17, 12, 0, 0)
  const sec = now.getTime() / 1000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('says "this minute" for less than a minute', () => {
    expect(relativeTime(sec)).toBe('this minute')
    expect(relativeTime(sec - 59)).toBe('this minute')
  })

  it('picks the largest unit that fits', () => {
    expect(relativeTime(sec - 5 * 60)).toBe('5 minutes ago')
    expect(relativeTime(sec - 3 * 3600)).toBe('3 hours ago')
    expect(relativeTime(sec - 24 * 3600)).toBe('yesterday')
    expect(relativeTime(sec - 3 * 24 * 3600)).toBe('3 days ago')
    expect(relativeTime(sec - 14 * 24 * 3600)).toBe('2 weeks ago')
    expect(relativeTime(sec - 60 * 24 * 3600)).toBe('2 months ago')
    expect(relativeTime(sec - 365 * 24 * 3600)).toBe('last year')
  })

  it('handles future times', () => {
    expect(relativeTime(sec + 2 * 60)).toBe('in 2 minutes')
    expect(relativeTime(sec + 24 * 3600)).toBe('tomorrow')
  })
})

describe('fullDate', () => {
  it('formats in en-GB, day before month', () => {
    const t = new Date(2024, 5, 15, 14, 30).getTime() / 1000
    expect(fullDate(t)).toBe('15 Jun 2024, 14:30')
  })
})

describe('shortSha', () => {
  it('keeps 7 characters', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456')
    expect(shortSha('abc')).toBe('abc')
  })
})

describe('initials', () => {
  it('uses the first and last name', () => {
    expect(initials('Ada Lovelace')).toBe('AL')
    expect(initials('  john  ronald   tolkien ')).toBe('JT')
  })

  it('uses one letter for a single name and ? for nothing', () => {
    expect(initials('linus')).toBe('L')
    expect(initials('')).toBe('?')
    expect(initials('   ')).toBe('?')
  })
})

describe('hueFor', () => {
  it('is stable and within 0..359', () => {
    expect(hueFor('')).toBe(0)
    expect(hueFor('a')).toBe(97)
    expect(hueFor('ab')).toBe((97 * 31 + 98) % 360)
    expect(hueFor('Ada Lovelace')).toBe(hueFor('Ada Lovelace'))
    for (const name of ['x', 'Someone Else', 'a much longer name '.repeat(20)]) {
      const h = hueFor(name)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
    }
  })
})

describe('path helpers', () => {
  it('splits git paths (forward slashes) into file and directory', () => {
    expect(fileName('src/lib/diff.ts')).toBe('diff.ts')
    expect(dirName('src/lib/diff.ts')).toBe('src/lib/')
    expect(fileName('README.md')).toBe('README.md')
    expect(dirName('README.md')).toBe('')
  })

  it('names a repository after its last folder, Windows or POSIX', () => {
    expect(repoName('C:\\dev\\gitdesk')).toBe('gitdesk')
    expect(repoName('/home/me/projects/app/')).toBe('app')
    expect(repoName('C:/dev/mixed\\repo')).toBe('repo')
    expect(repoName('')).toBe('')
  })
})

describe('errorMessage', () => {
  it("strips Electron's remote-method prefix", () => {
    const commit = new Error("Error invoking remote method 'api:commit': Error: nothing to commit")
    expect(errorMessage(commit)).toBe('nothing to commit')
    const push = new Error("Error invoking remote method 'api:push': GitError: rejected")
    expect(errorMessage(push)).toBe('rejected')
  })

  it('passes other errors and values through, trimmed', () => {
    expect(errorMessage(new Error('  plain  '))).toBe('plain')
    expect(errorMessage('a string')).toBe('a string')
    expect(errorMessage(42)).toBe('42')
  })
})
