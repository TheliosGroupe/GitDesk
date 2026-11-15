import { describe, expect, it } from 'vitest'
import { matchesPattern, ruleIndexFor } from '../../src/shared/branchColors'

/** The anchored regex the matcher replaces, as a reference on short inputs. */
function viaRegex(pattern: string, name: string): boolean {
  const body = pattern
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&')))
    .join('')
  return new RegExp(`^${body}$`, 'i').test(name)
}

/** Small deterministic generator (mulberry32), so a failure can be replayed. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('branch color patterns (linear-time glob)', () => {
  it('matches like the glob regex did', () => {
    const next = random(42)
    const pick = (chars: string, max: number): string =>
      Array.from(
        { length: Math.floor(next() * (max + 1)) },
        () => chars[Math.floor(next() * chars.length)]
      ).join('')
    for (let i = 0; i < 20000; i++) {
      const pattern = pick('aB/*?.', 7)
      const name = pick('abAB/.', 9)
      expect(matchesPattern(pattern, name), `${pattern} vs ${name}`).toBe(viaRegex(pattern, name))
    }
  })

  it('handles the usual shapes', () => {
    expect(matchesPattern('', '')).toBe(true)
    expect(matchesPattern('', 'a')).toBe(false)
    expect(matchesPattern('*', '')).toBe(true)
    expect(matchesPattern('feature/*', 'Feature/UI/login')).toBe(true)
    expect(matchesPattern('*/fix-*', 'team/fix-42')).toBe(true)
    expect(matchesPattern('*/fix-*', 'team/fax-42')).toBe(false)
    expect(matchesPattern('a*b*c', 'aXbYc')).toBe(true)
    expect(matchesPattern('a*b*c', 'aXbYd')).toBe(false)
  })

  it('stays fast on a very long branch name and several wildcards', () => {
    // A backtracking regex took seconds here (polynomial in the name length).
    const name = 'a'.repeat(5000)
    const start = performance.now()
    expect(matchesPattern('*a*a*a*b', name)).toBe(false)
    expect(matchesPattern('*a*?*a*a*a*b*', `origin/${name}`)).toBe(false)
    expect(
      ruleIndexFor(
        [
          { pattern: '*a*a*a*b', color: '#123456' },
          { pattern: 'origin/*a', color: '#654321' }
        ],
        [name, `origin/${name}`]
      )
    ).toBe(1)
    expect(performance.now() - start).toBeLessThan(50)
  })
})
