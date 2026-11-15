import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PALETTES,
  GRAPH_BACKGROUND,
  MAX_RULES,
  PALETTE_PRESETS,
  branchNames,
  contrastRatio,
  ensureContrast,
  matchesPattern,
  paletteFor,
  readBranchColors,
  ruleColorForBranch,
  ruleColorsBySha,
  ruleIndexFor,
  textOn,
  type BranchColorRule,
  type RuleColor
} from '../../src/shared/branchColors'
import { layoutGraph } from '../../src/renderer/src/lib/graph'

const rule = (pattern: string, color: string): BranchColorRule => ({ pattern, color })
type C = { sha: string; parents: string[] }
const c = (sha: string, ...parents: string[]): C => ({ sha, parents })
const local = (name: string): { kind: string; name: string } => ({ kind: 'local', name })
const remote = (name: string): { kind: string; name: string } => ({ kind: 'remote', name })

describe('branch name patterns', () => {
  it('matches exact names, * across slashes, ? for one character, ignoring case', () => {
    expect(matchesPattern('main', 'main')).toBe(true)
    expect(matchesPattern('main', 'main2')).toBe(false)
    expect(matchesPattern('feature/*', 'feature/login')).toBe(true)
    expect(matchesPattern('feature/*', 'feature/ui/login')).toBe(true)
    expect(matchesPattern('feature/*', 'features/login')).toBe(false)
    expect(matchesPattern('*/fix-*', 'team/fix-42')).toBe(true)
    expect(matchesPattern('v?', 'v1')).toBe(true)
    expect(matchesPattern('v?', 'v10')).toBe(false)
    expect(matchesPattern('Release/*', 'release/1.0')).toBe(true)
    expect(matchesPattern('**', 'anything/at/all')).toBe(true)
  })

  it('treats regex characters literally', () => {
    expect(matchesPattern('release/1.0', 'release/1x0')).toBe(false)
    expect(matchesPattern('fix(ui)+[x]', 'fix(ui)+[x]')).toBe(true)
    expect(matchesPattern('a|b', 'a')).toBe(false)
  })

  it('matches remote branches with and without their remote', () => {
    expect(branchNames('local', 'feature/x')).toEqual(['feature/x'])
    expect(branchNames('remote', 'origin/feature/x')).toEqual(['feature/x', 'origin/feature/x'])
    expect(branchNames('tag', 'v1.0')).toEqual([])
    expect(branchNames('head', 'HEAD (detached)')).toEqual([])
  })

  it('returns the first matching rule, in rules order', () => {
    const rules = [rule('main', '#111111'), rule('feature/*', '#222222'), rule('*', '#333333')]
    expect(ruleIndexFor(rules, ['main'])).toBe(0)
    expect(ruleIndexFor(rules, ['feature/a'])).toBe(1)
    expect(ruleIndexFor(rules, ['topic'])).toBe(2)
    expect(ruleIndexFor(rules, [])).toBe(-1)
    expect(ruleIndexFor([], ['main'])).toBe(-1)
    // Several names: the rule order decides, not the name order.
    expect(ruleIndexFor(rules, ['feature/a', 'main'])).toBe(0)
  })
})

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#777777')).toBe(1)
  })

  it('keeps a visible color and adjusts a faint one for the background', () => {
    expect(ensureContrast('#0969da', GRAPH_BACKGROUND.light)).toBe('#0969da')
    const onLight = ensureContrast('#ffe39a', GRAPH_BACKGROUND.light)
    expect(contrastRatio(onLight, GRAPH_BACKGROUND.light)).toBeGreaterThanOrEqual(3)
    const onDark = ensureContrast('#202060', GRAPH_BACKGROUND.dark)
    expect(contrastRatio(onDark, GRAPH_BACKGROUND.dark)).toBeGreaterThanOrEqual(3)
  })

  it('picks readable text on a solid color', () => {
    expect(textOn('#ffd000')).toBe('#0f1216')
    expect(textOn('#0058d6')).toBe('#ffffff')
  })

  it('every preset color has 3:1 against its theme background', () => {
    for (const preset of PALETTE_PRESETS)
      for (const theme of ['dark', 'light'] as const) {
        expect(preset[theme]).toHaveLength(8)
        for (const color of preset[theme])
          expect(
            contrastRatio(color, GRAPH_BACKGROUND[theme]),
            `${preset.id} ${theme} ${color}`
          ).toBeGreaterThanOrEqual(3)
      }
  })
})

describe('readBranchColors (settings validation)', () => {
  it('defaults when missing or malformed (older settings files)', () => {
    const empty = { dark: [], light: [], rules: [] }
    expect(readBranchColors(undefined)).toEqual(empty)
    expect(readBranchColors('red')).toEqual(empty)
    expect(readBranchColors({ dark: 'nope', rules: {} })).toEqual(empty)
  })

  it('keeps a palette only when it is 8 valid #rrggbb colors', () => {
    const eight = Array.from({ length: 8 }, () => '#A0B0C0')
    expect(readBranchColors({ dark: eight }).dark).toEqual(eight.map((x) => x.toLowerCase()))
    expect(readBranchColors({ dark: eight.slice(1) }).dark).toEqual([])
    expect(readBranchColors({ light: [...eight.slice(1), 'red'] }).light).toEqual([])
    expect(readBranchColors({ light: [...eight.slice(1), '#abc'] }).light).toEqual([])
  })

  it('drops invalid rules, trims patterns and caps the list', () => {
    const out = readBranchColors({
      rules: [
        { pattern: ' main ', color: '#FF0000' },
        { pattern: '', color: '#ff0000' },
        { pattern: 'x', color: 'blue' },
        { pattern: 'y'.repeat(201), color: '#00ff00' },
        { pattern: 3, color: '#00ff00' },
        null
      ]
    })
    expect(out.rules).toEqual([{ pattern: 'main', color: '#ff0000' }])
    const many = Array.from({ length: 80 }, (_, i) => ({ pattern: `b${i}`, color: '#123456' }))
    expect(readBranchColors({ rules: many }).rules).toHaveLength(MAX_RULES)
  })

  it('falls back to the default palette of the theme', () => {
    expect(paletteFor(undefined, 'dark')).toEqual(DEFAULT_PALETTES.dark)
    const custom = Array.from({ length: 8 }, () => '#123456')
    expect(paletteFor({ dark: custom, light: [], rules: [] }, 'dark')).toEqual(custom)
    expect(paletteFor({ dark: custom, light: [], rules: [] }, 'light')).toEqual(
      DEFAULT_PALETTES.light
    )
  })
})

describe('rule colors per commit', () => {
  const rules = [rule('main', '#4aa8ff'), rule('feature/*', '#43c983')]

  it('first matching rule wins when several branches point at one commit', () => {
    const map = ruleColorsBySha(
      new Map([
        ['A', [local('feature/x'), local('main')]],
        ['B', [{ kind: 'tag', name: 'main' }]],
        ['C', [remote('origin/feature/y')]],
        ['D', [local('topic')]]
      ]),
      rules,
      'dark'
    )
    expect(map.get('A')).toEqual({ color: '#4aa8ff', rank: 0 })
    expect(map.has('B')).toBe(false) // tags never match
    expect(map.get('C')).toEqual({ color: '#43c983', rank: 1 })
    expect(map.has('D')).toBe(false)
  })

  it('adjusts a rule color per theme', () => {
    const pale = [rule('main', '#ffe39a')]
    const dark = ruleColorForBranch(pale, 'local', 'main', 'dark')
    const light = ruleColorForBranch(pale, 'local', 'main', 'light')
    expect(dark).toBe('#ffe39a')
    expect(light).not.toBe('#ffe39a')
    expect(contrastRatio(light!, GRAPH_BACKGROUND.light)).toBeGreaterThanOrEqual(3)
    expect(ruleColorForBranch(pale, 'remote', 'origin/main', 'dark')).toBe('#ffe39a')
    expect(ruleColorForBranch(pale, 'local', 'topic', 'dark')).toBeUndefined()
  })
})

describe('layoutGraph with branch color rules', () => {
  const colors = (
    labels: Record<string, string[]>,
    rules: BranchColorRule[]
  ): Map<string, RuleColor> =>
    ruleColorsBySha(
      new Map(Object.entries(labels).map(([sha, names]) => [sha, names.map(local)])),
      rules,
      'dark'
    )

  it('keeps the palette colors without rules', () => {
    const history = [c('M', 'A', 'F'), c('F', 'A'), c('A')]
    expect(layoutGraph(history, new Map())).toEqual(layoutGraph(history))
  })

  it('colors the lane of a matching tip and of a merged-in matching branch', () => {
    // M (main) merges F (feature/x); both come from A.
    const rc = colors({ M: ['main'], F: ['feature/x'] }, [
      rule('main', '#4aa8ff'),
      rule('feature/*', '#43c983')
    ])
    const main = rc.get('M')!.color
    const { rows } = layoutGraph([c('M', 'A', 'F'), c('F', 'A'), c('A')], rc)
    expect(rows.map((r) => r.color)).toEqual([main, '#43c983', main])
    // The merge line into the feature lane is drawn in the feature color.
    expect(rows[0].segments).toContainEqual({ x1: 0, y1: 1, x2: 1, y2: 2, color: '#43c983' })
    // The feature lane joins the fork point in its own color.
    expect(rows[2].segments).toContainEqual({ x1: 1, y1: 0, x2: 0, y2: 1, color: '#43c983' })
  })

  it('does not use up palette colors for rule-colored lanes', () => {
    const rc = colors({ X: ['feature/x'] }, [rule('feature/*', '#43c983')])
    const { rows } = layoutGraph([c('X', 'A'), c('Y', 'A'), c('A')], rc)
    expect(rows.map((r) => r.color)).toEqual(['#43c983', 0, '#43c983'])
  })

  it('a lane switches to a branch further down when its rule comes first', () => {
    // feature/x (F2, F1) was started from develop (D); develop's rule comes first.
    const rc = colors({ F2: ['feature/x'], D: ['develop'] }, [
      rule('develop', '#c584ff'),
      rule('feature/*', '#43c983')
    ])
    const { rows } = layoutGraph([c('F2', 'F1'), c('F1', 'D'), c('D', 'R'), c('R')], rc)
    expect(rows.map((r) => r.color)).toEqual(['#43c983', '#43c983', '#c584ff', '#c584ff'])
    // The line entering D is still the feature lane; below it is develop.
    expect(rows[2].segments).toEqual([
      { x1: 0, y1: 0, x2: 0, y2: 1, color: '#43c983' },
      { x1: 0, y1: 1, x2: 0, y2: 2, color: '#c584ff' }
    ])
  })

  it('a lane keeps its color over a branch whose rule comes later', () => {
    // feature/x was fast-forwarded into main: its tip sits on main's lane.
    const rc = colors({ M: ['main'], F: ['feature/x'] }, [
      rule('main', '#4aa8ff'),
      rule('feature/*', '#43c983')
    ])
    const { rows } = layoutGraph([c('M', 'F'), c('F', 'A'), c('A')], rc)
    expect(rows.map((r) => r.color)).toEqual(['#4aa8ff', '#4aa8ff', '#4aa8ff'])
  })

  it('an unmatched lane takes the color of a matching branch it reaches', () => {
    const rc = colors({ D: ['develop'] }, [rule('develop', '#c584ff')])
    const { rows } = layoutGraph([c('T', 'D'), c('D', 'R'), c('R')], rc)
    expect(rows.map((r) => r.color)).toEqual([0, '#c584ff', '#c584ff'])
  })
})
