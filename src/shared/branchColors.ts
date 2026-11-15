/**
 * Branch colors: the lane palette of the commit graph (per theme) and rules that give
 * branches matching a name pattern their own color. Pure: shared by the main process
 * (settings validation) and the renderer (graph, sidebar, settings).
 */

export interface BranchColorRule {
  /** Glob on the branch name: `*` matches any characters (`/` included), `?` one. */
  pattern: string
  /** `#rrggbb`; adjusted per theme so it stays visible on the graph background. */
  color: string
}

export interface BranchColors {
  /** The 8 lane colors of the dark theme; empty = the built-in palette. */
  dark: string[]
  /** The 8 lane colors of the light theme; empty = the built-in palette. */
  light: string[]
  /** First matching rule wins. None by default. */
  rules: BranchColorRule[]
}

export type PaletteTheme = 'dark' | 'light'

export const LANE_COUNT = 8
export const MAX_RULES = 50
export const MAX_PATTERN_LENGTH = 200

/** Same values as `--hue-0…7` in main.css. */
export const DEFAULT_PALETTES: Record<PaletteTheme, string[]> = {
  dark: ['#4aa8ff', '#ef7b5a', '#43c983', '#c584ff', '#f0c84b', '#2fc6c6', '#ff6f9e', '#a3cf62'],
  light: ['#0969da', '#c4501a', '#1a7f37', '#8250df', '#9a6700', '#0a7b83', '#bf3989', '#557a12']
}

/** Graph background of each theme (`--bg` in main.css). */
export const GRAPH_BACKGROUND: Record<PaletteTheme, string> = { dark: '#1b1e24', light: '#ffffff' }

export interface PalettePreset {
  id: string
  name: string
  dark: string[]
  light: string[]
}

/** Every color keeps at least 3:1 against its theme's graph background. */
export const PALETTE_PRESETS: PalettePreset[] = [
  { id: 'default', name: 'Default', ...DEFAULT_PALETTES },
  {
    id: 'vivid',
    name: 'Vivid',
    dark: ['#1f9bff', '#ff5a36', '#00d46a', '#b85cff', '#ffd000', '#00dccf', '#ff3d8b', '#9be000'],
    light: ['#0058d6', '#d93a00', '#00873c', '#7a2ee0', '#a35f00', '#007c85', '#cc1470', '#4a7800']
  },
  {
    id: 'pastel',
    name: 'Pastel',
    dark: ['#9ccbff', '#ffb3a1', '#a6e8c2', '#d9b8ff', '#ffe39a', '#9ee6e6', '#ffb3cd', '#cfe8a6'],
    light: ['#4f7fc2', '#b8694f', '#3f8a5c', '#8a6cc0', '#8f7020', '#2f8282', '#b55a82', '#66823a']
  },
  {
    // Okabe–Ito, the usual palette for color vision deficiencies, with the darkest and
    // lightest colors adjusted so each one stays visible on its background.
    id: 'colorblind',
    name: 'Colorblind-safe',
    dark: ['#56b4e9', '#e69f00', '#2ec4a0', '#f0e442', '#5c9fd6', '#ff7f3f', '#cc79a7', '#bbbbbb'],
    light: ['#0072b2', '#c25400', '#008566', '#8a7d00', '#3a6fa8', '#a8449b', '#b8527f', '#6b6b6b']
  }
]

/** Rules offered by "Add common rules" (gitflow-style names). */
export const COMMON_RULES: BranchColorRule[] = [
  { pattern: 'main', color: '#4aa8ff' },
  { pattern: 'master', color: '#4aa8ff' },
  { pattern: 'develop', color: '#c584ff' },
  { pattern: 'feature/*', color: '#43c983' },
  { pattern: 'bugfix/*', color: '#f0c84b' },
  { pattern: 'release/*', color: '#2fc6c6' },
  { pattern: 'hotfix/*', color: '#ef5b5b' }
]

export const EMPTY_BRANCH_COLORS: BranchColors = { dark: [], light: [], rules: [] }

const HEX = /^#[0-9a-f]{6}$/i

export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

function readPalette(raw: unknown): string[] {
  // A palette is all or nothing: 8 valid colors, else the defaults.
  if (!Array.isArray(raw) || raw.length !== LANE_COUNT || !raw.every(isHexColor)) return []
  return raw.map((c) => c.toLowerCase())
}

/** Validates stored or incoming branch colors; anything invalid falls back to the defaults. */
export function readBranchColors(raw: unknown): BranchColors {
  if (!raw || typeof raw !== 'object') return { dark: [], light: [], rules: [] }
  const r = raw as Record<string, unknown>
  const rules = Array.isArray(r.rules)
    ? r.rules
        .flatMap((rule) => {
          if (!rule || typeof rule !== 'object') return []
          const { pattern, color } = rule as Record<string, unknown>
          if (typeof pattern !== 'string' || !isHexColor(color)) return []
          const p = pattern.trim()
          return p && p.length <= MAX_PATTERN_LENGTH
            ? [{ pattern: p, color: color.toLowerCase() }]
            : []
        })
        .slice(0, MAX_RULES)
    : []
  return { dark: readPalette(r.dark), light: readPalette(r.light), rules }
}

/** The lane colors in use for a theme (the custom palette, or the defaults). */
export function paletteFor(colors: BranchColors | undefined, theme: PaletteTheme): string[] {
  const custom = colors?.[theme]
  return custom && custom.length === LANE_COUNT ? custom : DEFAULT_PALETTES[theme]
}

// ---------- patterns ----------

/**
 * `*` matches any run of characters (`/` included), `?` one character; case-insensitive.
 * A greedy two-pointer match, not a regex: a backtracking `.*a.*b` regex takes seconds on a
 * long branch name from a remote, this is at most (name length × pattern length) steps.
 */
export function matchesPattern(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase()
  const s = name.toLowerCase()
  let i = 0 // in s
  let j = 0 // in p
  let star = -1 // index in p of the last `*` seen
  let from = 0 // where in s that `*` started matching
  while (i < s.length) {
    if (j < p.length && (p[j] === '?' || (p[j] !== '*' && p[j] === s[i]))) {
      i++
      j++
    } else if (j < p.length && p[j] === '*') {
      star = j++
      from = i
    } else if (star >= 0) {
      // The last `*` takes one more character; the rest of the pattern starts over after it.
      j = star + 1
      i = ++from
    } else {
      return false
    }
  }
  while (p[j] === '*') j++
  return j === p.length
}

/**
 * Names a branch label is matched with: a local branch by its name, a remote branch
 * ("origin/feature/x") without its remote ("feature/x") and with it.
 */
export function branchNames(kind: string, name: string): string[] {
  if (kind === 'local') return [name]
  if (kind === 'remote') {
    const slash = name.indexOf('/')
    return slash > 0 ? [name.slice(slash + 1), name] : [name]
  }
  return []
}

/** Index of the first rule matching any of `names`, or -1. */
export function ruleIndexFor(rules: BranchColorRule[], names: string[]): number {
  if (!names.length) return -1
  for (let i = 0; i < rules.length; i++) {
    const { pattern } = rules[i]
    if (names.some((n) => matchesPattern(pattern, n))) return i
  }
  return -1
}

// ---------- contrast ----------

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

const toHex = (rgb: number[]): string =>
  '#' +
  rgb
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')

export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Lines and dots need 3:1 against the background to be seen (WCAG non-text contrast). */
export const MIN_LANE_CONTRAST = 3

/**
 * Mixes `color` toward white (dark background) or black (light background) until it
 * reaches `min` contrast with `background`, so one rule color works in both themes.
 */
export function ensureContrast(color: string, background: string, min = MIN_LANE_CONTRAST): string {
  if (contrastRatio(color, background) >= min) return color
  const target = luminance(background) < 0.5 ? 255 : 0
  const rgb = channels(color)
  for (let step = 1; step <= 20; step++) {
    const t = step / 20
    const mixed = toHex(rgb.map((v) => v + (target - v) * t))
    if (contrastRatio(mixed, background) >= min) return mixed
  }
  return toHex([target, target, target])
}

/** Readable text color (near-black or white) on a solid `background`. */
export function textOn(background: string): string {
  return contrastRatio('#0f1216', background) >= contrastRatio('#ffffff', background)
    ? '#0f1216'
    : '#ffffff'
}

// ---------- graph ----------

/** A lane color from a rule: `rank` is the rule's position (lower wins). */
export interface RuleColor {
  color: string
  rank: number
}

/**
 * For each commit carrying a branch that matches a rule: the color of the first matching
 * rule (rules order), adjusted for the theme's background.
 */
export function ruleColorsBySha(
  labelsBySha: Map<string, { kind: string; name: string }[]>,
  rules: BranchColorRule[],
  theme: PaletteTheme
): Map<string, RuleColor> {
  const out = new Map<string, RuleColor>()
  if (!rules.length) return out
  const adjusted = rules.map((r) => ensureContrast(r.color, GRAPH_BACKGROUND[theme]))
  for (const [sha, labels] of labelsBySha) {
    const rank = ruleIndexFor(
      rules,
      labels.flatMap((l) => branchNames(l.kind, l.name))
    )
    if (rank !== -1) out.set(sha, { color: adjusted[rank], rank })
  }
  return out
}

/** Theme-adjusted color of the first rule matching a branch label, or undefined. */
export function ruleColorForBranch(
  rules: BranchColorRule[],
  kind: string,
  name: string,
  theme: PaletteTheme
): string | undefined {
  const i = ruleIndexFor(rules, branchNames(kind, name))
  return i === -1 ? undefined : ensureContrast(rules[i].color, GRAPH_BACKGROUND[theme])
}
