// Columns of the commit graph: widths and visibility, shared by every tab and kept in localStorage.
// The graph applies them as CSS variables on its container, so resizing never re-renders the rows.

import { clamp, createLayoutStore, isRecord } from './layoutStore'

export type ColumnId = 'refs' | 'graph' | 'msg' | 'author' | 'date' | 'sha'

export interface ColumnDef {
  id: ColumnId
  label: string
  /** Default width; null: the graph follows its lanes, the message takes the remaining space. */
  initial: number | null
  min: number
  max: number
  /** The commit message cannot be hidden. */
  required?: boolean
}

export const COLUMNS: ColumnDef[] = [
  { id: 'refs', label: 'Branch / Tag', initial: 160, min: 48, max: 600 },
  { id: 'graph', label: 'Graph', initial: null, min: 24, max: 800 },
  { id: 'msg', label: 'Commit message', initial: null, min: 120, max: 2000, required: true },
  { id: 'author', label: 'Author', initial: 140, min: 48, max: 480 },
  { id: 'date', label: 'Date', initial: 110, min: 48, max: 320 },
  { id: 'sha', label: 'SHA', initial: 72, min: 48, max: 320 }
]

export const COLUMN_BY_ID = Object.fromEntries(COLUMNS.map((c) => [c.id, c])) as Record<
  ColumnId,
  ColumnDef
>

export interface GraphColumns {
  /** Widths set by hand, in pixels. */
  widths: Partial<Record<ColumnId, number>>
  hidden: ColumnId[]
}

export const clampColumn = (id: ColumnId, w: number): number =>
  Math.round(clamp(w, COLUMN_BY_ID[id].min, COLUMN_BY_ID[id].max))

export function sanitizeColumns(saved: unknown): GraphColumns {
  const out: GraphColumns = { widths: {}, hidden: [] }
  if (!isRecord(saved)) return out
  if (isRecord(saved.widths))
    for (const c of COLUMNS) {
      const w = saved.widths[c.id]
      if (typeof w === 'number' && Number.isFinite(w)) out.widths[c.id] = clampColumn(c.id, w)
    }
  if (Array.isArray(saved.hidden))
    out.hidden = COLUMNS.filter(
      (c) => !c.required && (saved.hidden as unknown[]).includes(c.id)
    ).map((c) => c.id)
  return out
}

const store = createLayoutStore('gitdesk.layout.graphColumns', sanitizeColumns)
export const useGraphColumns = store.use

export const setColumnWidth = (id: ColumnId, w: number | null): void =>
  store.set((s) => {
    const widths = { ...s.widths }
    if (w === null) delete widths[id]
    else widths[id] = clampColumn(id, w)
    return { ...s, widths }
  })

export const setColumnHidden = (id: ColumnId, hidden: boolean): void =>
  store.set((s) => {
    if (COLUMN_BY_ID[id].required || s.hidden.includes(id) === hidden) return s
    return { ...s, hidden: hidden ? [...s.hidden, id] : s.hidden.filter((h) => h !== id) }
  })

export const resetColumns = (): void => store.set({ widths: {}, hidden: [] })

export const visibleColumns = (s: GraphColumns): ColumnDef[] =>
  COLUMNS.filter((c) => !s.hidden.includes(c.id))

/** Width of a column in pixels, or null for a message column that fills the remaining space. */
export function columnWidth(s: GraphColumns, id: ColumnId, graphNatural: number): number | null {
  const set = s.widths[id]
  if (set !== undefined) return set
  if (id === 'graph') return graphNatural
  return COLUMN_BY_ID[id].initial
}

type Sized = Partial<Record<ColumnId, number>>

/**
 * grid-template-columns of the header and every row, one CSS variable per column. Columns sized
 * by hand keep their width; in a narrow view the others give up width down to their minimum
 * (the graph keeps its lanes), and the message column, unless sized, takes whatever is left.
 */
export function columnsTemplate(visible: ColumnDef[], sized: Sized): string {
  return visible
    .map((c) =>
      sized[c.id] !== undefined || c.id === 'graph'
        ? `var(--col-${c.id})`
        : c.id === 'msg'
          ? `minmax(${c.min}px, 1fr)`
          : `minmax(${c.min}px, var(--col-${c.id}))`
    )
    .join(' ')
}

/** The narrowest the rows can get before the graph scrolls sideways. */
export function minRowWidth(visible: ColumnDef[], sized: Sized, graphWidth: number): number {
  let total = 0
  for (const c of visible) total += sized[c.id] ?? (c.id === 'graph' ? graphWidth : c.min)
  return total
}

/** Columns that give way first when the graph is too narrow for all of them. */
const AUTO_HIDE_ORDER: ColumnId[] = ['sha', 'date', 'author']
/** Room the message column wants before other columns are hidden for it. */
const MESSAGE_ROOM = 160

/**
 * Columns hidden for now because the graph is `width` pixels wide (not saved). Columns sized by
 * hand are never hidden this way.
 */
export function autoHiddenColumns(
  visible: ColumnDef[],
  sized: Sized,
  graphWidth: number,
  width: number
): ColumnId[] {
  if (width <= 0) return []
  const want = (c: ColumnDef): number =>
    sized[c.id] ?? (c.id === 'graph' ? graphWidth : c.id === 'msg' ? MESSAGE_ROOM : c.initial!)
  let need = visible.reduce((sum, c) => sum + want(c), 0)
  const hidden: ColumnId[] = []
  for (const id of AUTO_HIDE_ORDER) {
    if (need <= width) break
    const c = visible.find((v) => v.id === id)
    if (!c || sized[id] !== undefined) continue
    need -= want(c)
    hidden.push(id)
  }
  return hidden
}
