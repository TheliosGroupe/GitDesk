import { useRef } from 'react'
import { clampWidth, setPanelWidth, type Panel } from '../lib/panelWidths'

const CSS_VAR: Record<Panel, string> = { sidebar: '--sidebar-w', right: '--right-w' }

/**
 * Draggable splitter on the inner edge of the sidebar or the right panel.
 * While dragging it only updates the CSS variable (no React render); the width is saved on release.
 */
export function Resizer({
  panel,
  width,
  container
}: {
  panel: Panel
  width: number
  /** The .repo-view element that holds the CSS variable. */
  container: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const drag = useRef<{ x: number; w: number; current: number } | null>(null)
  const sign = panel === 'sidebar' ? 1 : -1
  const label = panel === 'sidebar' ? 'Resize the sidebar' : 'Resize the details panel'

  const apply = (w: number): number => {
    const value = clampWidth(panel, w)
    container.current?.style.setProperty(CSS_VAR[panel], `${value}px`)
    return value
  }

  const finish = (): void => {
    const d = drag.current
    drag.current = null
    document.body.classList.remove('resizing')
    if (d && d.current !== d.w) setPanelWidth(panel, d.current)
  }

  return (
    <div
      className={`splitter splitter-${panel}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      title={`${label} (double-click to reset)`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, w: width, current: width }
        document.body.classList.add('resizing')
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d) d.current = apply(d.w + sign * (e.clientX - d.x))
      }}
      onPointerUp={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => setPanelWidth(panel, null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16
        if (e.key === 'ArrowLeft') setPanelWidth(panel, width - sign * step)
        else if (e.key === 'ArrowRight') setPanelWidth(panel, width + sign * step)
        else return
        e.preventDefault()
      }}
    />
  )
}
