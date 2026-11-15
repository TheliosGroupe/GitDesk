// Settings → Appearance → Branch colors: the lane palette of each theme and rules by branch name.
import { ArrowDown, ArrowUp, Plus, RotateCcw, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COMMON_RULES,
  DEFAULT_PALETTES,
  GRAPH_BACKGROUND,
  MAX_PATTERN_LENGTH,
  MAX_RULES,
  MIN_LANE_CONTRAST,
  PALETTE_PRESETS,
  contrastRatio,
  ensureContrast,
  isHexColor,
  paletteFor,
  type BranchColorRule,
  type BranchColors,
  type PaletteTheme
} from '../../../shared/branchColors'
import type { AppState, Settings } from '../../../shared/types'
import '../assets/branch-colors.css'
import { useResolvedTheme } from '../lib/theme'

const THEME_NAMES: Record<PaletteTheme, string> = { dark: 'dark', light: 'light' }
/** Color pickers fire on every move: settings are written once they settle. */
const SAVE_DELAY = 250

/** A native color picker with a hex text field next to it. */
function ColorField({
  value,
  label,
  onChange
}: {
  value: string
  label: string
  onChange(color: string): void
}): React.JSX.Element {
  // What is typed in the hex field while it has the focus (null = shows `value`).
  const [typed, setTyped] = useState<string | null>(null)
  const text = typed ?? value
  const valid = isHexColor(text)
  return (
    <span className="color-field">
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
      />
      <input
        className={valid ? 'input mono color-hex' : 'input mono color-hex invalid'}
        aria-label={`${label}, hex`}
        aria-invalid={!valid}
        value={text}
        maxLength={7}
        spellCheck={false}
        onChange={(e) => {
          const next = e.target.value.trim()
          setTyped(next)
          const hex = next.startsWith('#') ? next : `#${next}`
          if (isHexColor(hex)) onChange(hex.toLowerCase())
        }}
        onBlur={() => setTyped(null)}
      />
    </span>
  )
}

/** A small graph drawn with the palette on the theme's background. */
function PalettePreview({
  palette,
  theme
}: {
  palette: string[]
  theme: PaletteTheme
}): React.JSX.Element {
  const step = 22
  const x = (i: number): number => 12 + i * step
  return (
    <svg
      className="palette-preview"
      width={x(palette.length - 1) + 12}
      height={64}
      role="img"
      aria-label={`Preview of the ${THEME_NAMES[theme]} theme lanes`}
      style={{ background: GRAPH_BACKGROUND[theme] }}
    >
      {palette.map((color, i) => {
        const top = 10 + (i % 3) * 9
        return (
          <g key={i} stroke={color} fill={color} strokeWidth={2}>
            {/* Every other lane branches off its left neighbor. */}
            {i > 0 && i % 2 === 1 ? (
              <path
                d={`M${x(i)} ${top}L${x(i)} 40C${x(i)} 50,${x(i - 1)} 46,${x(i - 1)} 58`}
                fill="none"
              />
            ) : (
              <path d={`M${x(i)} ${top}L${x(i)} 64`} fill="none" />
            )}
            <circle cx={x(i)} cy={top} r={5} />
          </g>
        )
      })}
    </svg>
  )
}

export function BranchColorsSettings({
  settings,
  onChange
}: {
  settings: Settings
  onChange(state: AppState): void
}): React.JSX.Element {
  const shown = useResolvedTheme()
  const [theme, setTheme] = useState<PaletteTheme>(shown)
  // Edited here and written shortly after, so dragging a picker does not flood the disk.
  const [draft, setDraft] = useState<BranchColors>(settings.branchColors)
  const pending = useRef<BranchColors | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })
  const flush = useCallback((): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const next = pending.current
    pending.current = null
    if (next)
      void window.api.setSettings({ branchColors: next }).then((s) => onChangeRef.current(s))
  }, [])
  // Closing the dialog writes what is still pending.
  useEffect(() => flush, [flush])

  const update = (next: BranchColors): void => {
    setDraft(next)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY)
  }

  const palette = paletteFor(draft, theme)
  const custom = draft[theme].length > 0
  const preset = PALETTE_PRESETS.find((p) => p[theme].join() === palette.join())
  const setPalette = (next: string[]): void =>
    update({ ...draft, [theme]: next.join() === DEFAULT_PALETTES[theme].join() ? [] : next })
  const lowContrast = palette
    .map((color, i) => ({ i, ratio: contrastRatio(color, GRAPH_BACKGROUND[theme]) }))
    .filter((c) => c.ratio < MIN_LANE_CONTRAST)

  const rules = draft.rules
  const setRules = (next: BranchColorRule[]): void =>
    update({ ...draft, rules: next.slice(0, MAX_RULES) })
  const setRule = (i: number, patch: Partial<BranchColorRule>): void =>
    setRules(rules.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const move = (i: number, by: number): void => {
    const next = [...rules]
    const [rule] = next.splice(i, 1)
    next.splice(i + by, 0, rule)
    setRules(next)
    // Keep the focus on the button that was pressed, now on the moved row.
    requestAnimationFrame(() => {
      const row = document.querySelectorAll('.branch-rule')[i + by]
      const button = row?.querySelector<HTMLButtonElement>(by < 0 ? '.rule-up' : '.rule-down')
      ;(button && !button.disabled ? button : row?.querySelector<HTMLElement>('input'))?.focus()
    })
  }
  const missingCommon = COMMON_RULES.filter(
    (c) => !rules.some((r) => r.pattern.toLowerCase() === c.pattern)
  )

  return (
    <div className="branch-colors">
      <div className="field">
        <span className="field-label" id="settings-palette">
          Lane colors
        </span>
        <div className="palette-head">
          <div
            className="segmented text"
            role="group"
            aria-label="Theme whose lane colors are edited"
          >
            {(['dark', 'light'] as const).map((t) => (
              <button
                key={t}
                aria-pressed={theme === t}
                className={theme === t ? 'active' : ''}
                onClick={() => setTheme(t)}
              >
                {t === 'dark' ? 'Dark theme' : 'Light theme'}
              </button>
            ))}
          </div>
          <select
            className="input palette-preset"
            aria-label="Palette preset"
            value={preset?.id ?? ''}
            onChange={(e) => {
              const p = PALETTE_PRESETS.find((x) => x.id === e.target.value)
              if (p) setPalette([...p[theme]])
            }}
          >
            {!preset && <option value="">Custom</option>}
            {PALETTE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn small" disabled={!custom} onClick={() => setPalette([])}>
            <RotateCcw size={12} /> Reset to defaults
          </button>
        </div>
        <div className="palette-grid" role="group" aria-labelledby="settings-palette">
          {palette.map((color, i) => {
            const ratio = contrastRatio(color, GRAPH_BACKGROUND[theme])
            return (
              <div key={i} className="palette-item" data-lane={i}>
                <span className="palette-index">{i + 1}</span>
                <ColorField
                  value={color}
                  label={`Lane ${i + 1} color, ${THEME_NAMES[theme]} theme`}
                  onChange={(c) => setPalette(palette.map((x, k) => (k === i ? c : x)))}
                />
                {ratio < MIN_LANE_CONTRAST && (
                  <span
                    className="contrast-warn"
                    role="img"
                    aria-label={`Low contrast: ${ratio.toFixed(1)}:1`}
                    title={`Low contrast on the graph background: ${ratio.toFixed(1)}:1 (3:1 recommended)`}
                  >
                    <TriangleAlert size={14} aria-hidden />
                  </span>
                )}
              </div>
            )
          })}
        </div>
        <PalettePreview palette={palette} theme={theme} />
        {lowContrast.length > 0 ? (
          <span className="help warn-text" role="status">
            Lane {lowContrast.map((c) => c.i + 1).join(', ')}{' '}
            {lowContrast.length > 1 ? 'have' : 'has'} less than 3:1 contrast with the{' '}
            {THEME_NAMES[theme]} graph background and may be hard to see.
          </span>
        ) : (
          <span className="help">
            The graph cycles through these colors. Each theme has its own palette
            {theme !== shown ? ` (the ${THEME_NAMES[shown]} theme is on screen)` : ''}.
          </span>
        )}
      </div>

      <div className="field">
        <span className="field-label" id="settings-branch-rules">
          Colors by branch name
        </span>
        <span className="help">
          A branch matching a pattern gets its color on its lane, its label and in the sidebar. The
          first matching rule wins. <code>*</code> matches anything (<code>/</code> included);
          remote branches match without their remote (<code>origin/</code>). Colors are lightened or
          darkened when needed to stay visible in each theme.
        </span>
        {rules.length > 0 && (
          <ol className="branch-rules" aria-labelledby="settings-branch-rules">
            {rules.map((rule, i) => {
              const dark = ensureContrast(rule.color, GRAPH_BACKGROUND.dark)
              const light = ensureContrast(rule.color, GRAPH_BACKGROUND.light)
              return (
                <li key={i} className="branch-rule">
                  <input
                    className="input mono rule-pattern"
                    aria-label={`Rule ${i + 1} branch pattern`}
                    placeholder="feature/*"
                    value={rule.pattern}
                    maxLength={MAX_PATTERN_LENGTH}
                    spellCheck={false}
                    onChange={(e) => setRule(i, { pattern: e.target.value })}
                  />
                  <ColorField
                    value={rule.color}
                    label={`Rule ${i + 1} color`}
                    onChange={(color) => setRule(i, { color })}
                  />
                  <span
                    className="rule-swatches"
                    title={`As drawn: ${dark} in the dark theme, ${light} in the light theme`}
                  >
                    <span style={{ background: GRAPH_BACKGROUND.dark, color: dark }}>●</span>
                    <span style={{ background: GRAPH_BACKGROUND.light, color: light }}>●</span>
                  </span>
                  <button
                    className="icon-btn small rule-up"
                    aria-label={`Move rule ${i + 1} up`}
                    title="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    className="icon-btn small rule-down"
                    aria-label={`Move rule ${i + 1} down`}
                    title="Move down"
                    disabled={i === rules.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    className="icon-btn small"
                    aria-label={`Remove rule ${i + 1}`}
                    title="Remove"
                    onClick={() => setRules(rules.filter((_, k) => k !== i))}
                  >
                    <X size={13} />
                  </button>
                </li>
              )
            })}
          </ol>
        )}
        <div className="field-row">
          <button
            className="btn small"
            disabled={rules.length >= MAX_RULES}
            onClick={() => {
              setRules([...rules, { pattern: '', color: palette[rules.length % palette.length] }])
              requestAnimationFrame(() =>
                [...document.querySelectorAll<HTMLInputElement>('.rule-pattern')].pop()?.focus()
              )
            }}
          >
            <Plus size={12} /> Add rule
          </button>
          <button
            className="btn small"
            disabled={!missingCommon.length || rules.length >= MAX_RULES}
            title={COMMON_RULES.map((r) => r.pattern).join(', ')}
            onClick={() => setRules([...rules, ...missingCommon])}
          >
            Add common rules
          </button>
          {rules.length > 0 && (
            <button className="btn small" onClick={() => setRules([])}>
              Remove all
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
