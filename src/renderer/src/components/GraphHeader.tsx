// Header row of the commit graph: resizable columns (drag a border, double-click to fit) and the
// column menu (right-click, or the button at the end) to show or hide columns.

import { Check, Columns3 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  COLUMNS,
  clampColumn,
  columnsTemplate,
  minRowWidth,
  resetColumns,
  setColumnHidden,
  setColumnWidth,
  type ColumnDef,
  type ColumnId,
  type GraphColumns
} from '../lib/layoutColumns'

interface Props {
  columns: GraphColumns
  /** Columns stepping aside while the graph is narrow. */
  autoHidden: ColumnId[]
  visible: ColumnDef[]
  /** Current width of each visible column; null for a message column that fills the rest. */
  widths: Partial<Record<ColumnId, number | null>>
  /** Width of the graph column that fits its lanes. */
  naturalGraph: number
  /** The .graph element that holds the column CSS variables. */
  graphRef: React.RefObject<HTMLDivElement | null>
  clipRef: React.RefObject<HTMLDivElement | null>
  /** Extra content of the message header (the compare hint). */
  messageExtra?: ReactNode
}

export function GraphHeader({
  columns,
  autoHidden,
  visible,
  widths,
  naturalGraph,
  graphRef,
  clipRef,
  messageExtra
}: Props): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ id: ColumnId; x: number; w: number; current: number } | null>(null)

  const vars = (): CSSStyleDeclaration | undefined => graphRef.current?.style

  /** Rendered width of a column (its header cell). */
  const measured = (id: ColumnId): number =>
    graphRef.current
      ?.querySelector<HTMLElement>(`.graph-th[data-col="${id}"]`)
      ?.getBoundingClientRect().width ?? 0

  /** While dragging: only the CSS variables change, the rows are not re-rendered. */
  const apply = (id: ColumnId, w: number): number => {
    const value = clampColumn(id, w)
    const style = vars()
    if (style) {
      const sized = { ...columns.widths, [id]: value }
      style.setProperty(`--col-${id}`, `${value}px`)
      style.setProperty('--graph-cols', columnsTemplate(visible, sized))
      style.setProperty('--graph-min-w', `${minRowWidth(visible, sized, naturalGraph)}px`)
    }
    return value
  }

  /** Puts back the variables React rendered (a drag that changed nothing). */
  const restore = (id: ColumnId): void => {
    const style = vars()
    if (!style) return
    const w = widths[id]
    if (w === null || w === undefined) style.removeProperty(`--col-${id}`)
    else style.setProperty(`--col-${id}`, `${w}px`)
    style.setProperty('--graph-cols', columnsTemplate(visible, columns.widths))
    style.setProperty('--graph-min-w', `${minRowWidth(visible, columns.widths, naturalGraph)}px`)
  }

  const finish = (): void => {
    const d = drag.current
    drag.current = null
    document.body.classList.remove('col-resizing')
    if (!d) return
    if (d.current !== d.w) setColumnWidth(d.id, d.current)
    else restore(d.id)
  }

  /** Double-click: fit the column to the rows on screen (graph and message: back to default). */
  const fit = (id: ColumnId): void => {
    if (id === 'graph' || id === 'msg') return setColumnWidth(id, null)
    const g = graphRef.current
    if (!g) return
    // Measured as a max-content track (never squeezed), then put back.
    const previous = g.style.getPropertyValue(`--col-${id}`)
    const template = g.style.getPropertyValue('--graph-cols')
    g.style.setProperty(`--col-${id}`, 'max-content')
    g.style.setProperty('--graph-cols', columnsTemplate(visible, { ...columns.widths, [id]: 0 }))
    let w = 0
    for (const el of g.querySelectorAll<HTMLElement>(`[data-col="${id}"]`))
      w = Math.max(w, el.getBoundingClientRect().width)
    g.style.setProperty(`--col-${id}`, previous)
    g.style.setProperty('--graph-cols', template)
    if (w > 0) setColumnWidth(id, Math.ceil(w) + 2)
  }

  const openMenu = (x: number, y: number): void => setMenu({ x, y })

  return (
    <div className="graph-header-wrap">
      <div className="graph-header-clip" ref={clipRef}>
        <div
          className="graph-header"
          onContextMenu={(e) => {
            e.preventDefault()
            openMenu(e.clientX, e.clientY)
          }}
        >
          {visible.map((c) => (
            <div
              key={c.id}
              className={c.id === 'msg' ? 'graph-th graph-header-msg' : 'graph-th'}
              data-col={c.id}
            >
              <span className="graph-th-label">{c.label}</span>
              {c.id === 'msg' && messageExtra}
              <div
                className="col-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize the ${c.label} column`}
                aria-valuenow={widths[c.id] ?? undefined}
                aria-valuemin={c.min}
                aria-valuemax={c.max}
                tabIndex={0}
                title={
                  c.id === 'msg'
                    ? 'Drag to resize (double-click: fill the remaining space)'
                    : c.id === 'graph'
                      ? 'Drag to resize (double-click: fit the lanes)'
                      : 'Drag to resize (double-click: fit the content)'
                }
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.preventDefault()
                  e.stopPropagation()
                  e.currentTarget.setPointerCapture(e.pointerId)
                  const w = Math.round(measured(c.id))
                  drag.current = { id: c.id, x: e.clientX, w, current: w }
                  document.body.classList.add('col-resizing')
                }}
                onPointerMove={(e) => {
                  const d = drag.current
                  if (d && d.id === c.id) d.current = apply(c.id, d.w + e.clientX - d.x)
                }}
                onPointerUp={finish}
                onLostPointerCapture={finish}
                onDoubleClick={() => fit(c.id)}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 32 : 8
                  const w = Math.round(measured(c.id))
                  if (e.key === 'ArrowLeft') setColumnWidth(c.id, w - step)
                  else if (e.key === 'ArrowRight') setColumnWidth(c.id, w + step)
                  else if (e.key === 'Enter') fit(c.id)
                  else return
                  e.preventDefault()
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <button
        className="icon-btn graph-columns-btn"
        aria-label="Choose columns"
        title="Choose columns (or right-click the header)"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          openMenu(r.right - 220, r.bottom + 4)
        }}
      >
        <Columns3 size={14} />
      </button>
      {menu && (
        <ColumnMenu
          at={menu}
          columns={columns}
          autoHidden={autoHidden}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

function ColumnMenu({
  at,
  columns,
  autoHidden,
  onClose
}: {
  at: { x: number; y: number }
  columns: GraphColumns
  autoHidden: ColumnId[]
  onClose(): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.x, top: at.y })
  const closeRef = useRef(onClose)
  // Where the keyboard was before the menu took it (given back on close).
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })

  // Inside the window, with the keyboard on the first item.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(at.y, window.innerHeight - height - 8))
    })
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [at])

  useEffect(() => {
    const onClose = (): void => closeRef.current()
    const close = onClose
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (opener?.isConnected) opener.focus()
        onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter(
        (b) => !b.disabled
      )
      const i = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [opener])

  return (
    <div
      className="context-menu col-menu"
      ref={ref}
      style={pos}
      role="menu"
      aria-label="Columns"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="col-menu-title">Columns</div>
      {COLUMNS.map((c) => {
        const shown = !columns.hidden.includes(c.id)
        return (
          <button
            key={c.id}
            role="menuitemcheckbox"
            aria-checked={shown}
            className="menu-item"
            disabled={c.required}
            title={
              c.required
                ? 'Always shown'
                : autoHidden.includes(c.id)
                  ? 'Hidden while the graph is narrow (widen it, or size the column by hand)'
                  : undefined
            }
            onClick={() => setColumnHidden(c.id, shown)}
          >
            <span className="col-menu-label">
              <span className="col-menu-check">{shown && <Check size={13} />}</span>
              {c.label}
            </span>
            {autoHidden.includes(c.id) && <span className="menu-hint">narrow view</span>}
          </button>
        )
      })}
      <div className="menu-sep" />
      <button
        role="menuitem"
        className="menu-item"
        onClick={() => {
          resetColumns()
          onClose()
        }}
      >
        <span>Reset columns</span>
      </button>
    </div>
  )
}
