import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { niceTicks, seriesColor, WEEKDAYS, type DayBucket } from '../lib/activity'
import { LOCALE } from '../lib/format'

/** Width of an element, kept up to date. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(600)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

function Tooltip({
  at,
  y,
  children
}: {
  at: { x: number; flip: boolean }
  y: number
  children: ReactNode
}): React.JSX.Element {
  // A flipped tooltip is anchored by its right edge, so it hugs the mark whatever its width.
  const style = { left: at.x, top: y, transform: at.flip ? 'translateX(-100%)' : undefined }
  return (
    <div className="viz-tip" style={style} role="tooltip">
      {children}
    </div>
  )
}

const TIP_WIDTH = 220

/** Tooltip anchor: right of the mark, or left of it when it would leave the chart. */
function beside(markX: number, markW: number, chartW: number): { x: number; flip: boolean } {
  const right = markX + markW + 8
  return right + TIP_WIDTH <= chartW ? { x: right, flip: false } : { x: markX - 8, flip: true }
}

/** Top-rounded bar segment (4px data end, square at the bottom). */
function topRounded(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h)
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`
}

// ---------------------------------------------------------------------------
// Commits per day, stacked by person
// ---------------------------------------------------------------------------

export interface Series {
  key: string
  label: string
  slot: number | null
}

export function StackedColumns({
  buckets,
  series,
  unit
}: {
  buckets: DayBucket[]
  /** Bottom to top; the last one may be "Other". */
  series: Series[]
  unit: string
}): React.JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = 200
  const pad = { l: 34, r: 8, t: 10, b: 24 }
  const plotW = Math.max(50, width - pad.l - pad.r)
  const plotH = H - pad.t - pad.b
  const n = Math.max(1, buckets.length)
  const slotW = plotW / n
  const colW = Math.max(2, Math.min(24, slotW - 2))
  const ticks = niceTicks(Math.max(0, ...buckets.map((b) => b.total)))
  const top = ticks[ticks.length - 1] || 1
  const y = (v: number): number => pad.t + plotH - (v / top) * plotH
  const labelEvery = Math.ceil(n / Math.max(2, Math.floor(plotW / 70)))

  // Series value for a bucket ("other" sums everyone not listed).
  const listed = new Set(series.filter((s) => s.key !== 'other').map((s) => s.key))
  const value = (b: DayBucket, s: Series): number =>
    s.key === 'other'
      ? [...b.counts].reduce((sum, [k, v]) => (listed.has(k) ? sum : sum + v), 0)
      : (b.counts.get(s.key) ?? 0)

  const hovered = hover === null ? null : buckets[hover]
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1))
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1))
    else if (e.key === 'Escape') setHover(null)
    else return
    e.preventDefault()
  }

  return (
    <div
      className="viz"
      ref={ref}
      tabIndex={0}
      aria-label={`${unit} per day; use the arrow keys to read each day`}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setHover(null)}
      onBlur={() => setHover(null)}
    >
      <svg width={width} height={H} role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line
              className="viz-grid"
              x1={pad.l}
              x2={pad.l + plotW}
              y1={y(t) + 0.5}
              y2={y(t) + 0.5}
            />
            <text className="viz-tick" x={pad.l - 6} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = pad.l + i * slotW + (slotW - colW) / 2
          const parts = series.map((s) => ({ s, v: value(b, s) })).filter((p) => p.v > 0)
          let cum = 0
          return (
            <g key={b.start} className={hover === i ? 'viz-col hover' : 'viz-col'}>
              {parts.map(({ s, v }, k) => {
                const y1 = y(cum)
                cum += v
                const y0 = y(cum)
                const isTop = k === parts.length - 1
                // 2px surface gap above every segment that has another one on top.
                const h = Math.max(0.5, y1 - y0 - (isTop ? 0 : 2))
                const yy = isTop ? y0 : y0 + 2
                return isTop ? (
                  <path key={s.key} d={topRounded(x, yy, colW, h)} fill={seriesColor(s.slot)} />
                ) : (
                  <rect
                    key={s.key}
                    x={x}
                    y={yy}
                    width={colW}
                    height={h}
                    fill={seriesColor(s.slot)}
                  />
                )
              })}
              {i % labelEvery === 0 && (
                <text className="viz-tick" x={x + colW / 2} y={H - 6} textAnchor="middle">
                  {b.label}
                </text>
              )}
              <rect
                className="viz-hit"
                x={pad.l + i * slotW}
                y={pad.t}
                width={slotW}
                height={plotH}
                onMouseEnter={() => setHover(i)}
              />
            </g>
          )
        })}
        <line className="viz-axis" x1={pad.l} x2={pad.l + plotW} y1={y(0) + 0.5} y2={y(0) + 0.5} />
      </svg>
      {hovered && hover !== null && (
        <Tooltip at={beside(pad.l + hover * slotW, slotW, width)} y={pad.t}>
          <div className="viz-tip-title">
            {new Date(hovered.start * 1000).toLocaleDateString(LOCALE, {
              weekday: 'long',
              day: 'numeric',
              month: 'long'
            })}
          </div>
          <div className="viz-tip-row total">
            <strong>{hovered.total}</strong> {unit}
          </div>
          {series
            .map((s) => ({ s, v: value(hovered, s) }))
            .filter((p) => p.v > 0)
            .sort((a, b) => b.v - a.v)
            .map(({ s, v }) => (
              <div className="viz-tip-row" key={s.key}>
                <span className="viz-key-line" style={{ background: seriesColor(s.slot) }} />
                <strong>{v}</strong>
                <span>{s.label}</span>
              </div>
            ))}
        </Tooltip>
      )}
    </div>
  )
}

export function Legend({
  series,
  totals,
  selected,
  onSelect
}: {
  series: Series[]
  totals: Map<string, number>
  selected: string | null
  onSelect(key: string | null): void
}): React.JSX.Element {
  return (
    <div className="viz-legend">
      {series.map((s) => (
        <button
          key={s.key}
          className={selected === s.key ? 'viz-legend-item active' : 'viz-legend-item'}
          disabled={s.key === 'other'}
          onClick={() => onSelect(selected === s.key ? null : s.key)}
          title={s.key === 'other' ? 'Everyone else' : `Show only ${s.label}`}
        >
          <span className="viz-swatch" style={{ background: seriesColor(s.slot) }} />
          <span>{s.label}</span>
          <span className="muted">{totals.get(s.key) ?? 0}</span>
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Week x hour heatmap
// ---------------------------------------------------------------------------

const HEAT_STEPS = 7

export function Heatmap({ grid, unit }: { grid: number[][]; unit: string }): React.JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<[number, number] | null>(null)
  const labelW = 38
  const top = 18
  const gap = 2
  const cell = Math.max(8, (width - labelW) / 24 - gap)
  const cellH = Math.min(22, Math.max(14, cell * 0.8))
  const height = top + 7 * (cellH + gap)
  const max = Math.max(0, ...grid.flat())
  const step = (v: number): number => (v === 0 ? 0 : Math.max(1, Math.ceil((v / max) * HEAT_STEPS)))
  const xOf = (h: number): number => labelW + h * (cell + gap)
  const yOf = (d: number): number => top + d * (cellH + gap)

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const [d, h] = hover ?? [0, 0]
    const moves: Record<string, [number, number]> = {
      ArrowRight: [d, Math.min(23, h + 1)],
      ArrowLeft: [d, Math.max(0, h - 1)],
      ArrowDown: [Math.min(6, d + 1), h],
      ArrowUp: [Math.max(0, d - 1), h]
    }
    if (e.key === 'Escape') setHover(null)
    else if (moves[e.key]) setHover(hover ? moves[e.key] : [0, 0])
    else return
    e.preventDefault()
  }

  const hv = hover ? grid[hover[0]][hover[1]] : 0
  return (
    <div
      className="viz"
      ref={ref}
      tabIndex={0}
      aria-label={`${unit} by weekday and hour; use the arrow keys to read each cell`}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setHover(null)}
      onBlur={() => setHover(null)}
    >
      <svg width={width} height={height} role="img">
        {Array.from({ length: 8 }, (_, i) => i * 3).map((h) => (
          <text key={h} className="viz-tick" x={xOf(h)} y={12}>
            {String(h).padStart(2, '0')}h
          </text>
        ))}
        {grid.map((row, d) => (
          <g key={d}>
            <text className="viz-tick" x={labelW - 8} y={yOf(d) + cellH / 2 + 4} textAnchor="end">
              {WEEKDAYS[d].slice(0, 3)}
            </text>
            {row.map((v, h) => (
              <rect
                key={h}
                className={
                  hover && hover[0] === d && hover[1] === h ? 'viz-cell hover' : 'viz-cell'
                }
                x={xOf(h)}
                y={yOf(d)}
                width={cell}
                height={cellH}
                rx={2}
                fill={`var(--heat-${step(v)})`}
                onMouseEnter={() => setHover([d, h])}
              />
            ))}
          </g>
        ))}
      </svg>
      {hover && (
        <Tooltip at={beside(xOf(hover[1]), cell, width)} y={Math.max(0, yOf(hover[0]) - 8)}>
          <div className="viz-tip-row total">
            <strong>{hv}</strong> {unit}
          </div>
          <div className="viz-tip-title">
            {WEEKDAYS[hover[0]]} · {String(hover[1]).padStart(2, '0')}:00–
            {String(hover[1] + 1).padStart(2, '0')}:00
          </div>
        </Tooltip>
      )}
      <div className="viz-scale">
        <span className="muted">Fewer</span>
        {Array.from({ length: HEAT_STEPS }, (_, i) => (
          <span key={i} className="viz-scale-step" style={{ background: `var(--heat-${i + 1})` }} />
        ))}
        <span className="muted">More</span>
        <span className="muted">
          · busiest hour: {max} {unit}
        </span>
      </div>
    </div>
  )
}

/** 24 small bars: when in the day someone works. Single series, no legend. */
export function HourStrip({
  hours,
  color,
  label
}: {
  hours: number[]
  color: string
  label: string
}): React.JSX.Element {
  const max = Math.max(1, ...hours)
  const w = 3
  const gap = 1
  const H = 18
  return (
    <svg width={24 * (w + gap)} height={H} role="img" aria-label={label}>
      <line className="viz-axis" x1={0} x2={24 * (w + gap)} y1={H - 0.5} y2={H - 0.5} />
      {hours.map((v, h) => {
        const bh = v ? Math.max(2, (v / max) * (H - 2)) : 0
        return (
          <rect key={h} x={h * (w + gap)} y={H - 1 - bh} width={w} height={bh} rx={1} fill={color}>
            <title>{`${String(h).padStart(2, '0')}h: ${v}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}
