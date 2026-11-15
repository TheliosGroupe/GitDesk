// The tab strip: the pinned Home tab, the repository tabs (reorderable by dragging, scrolling
// when there are many), a "+" menu to open or clone a repository, and the settings button.

import { FolderGit2, GitFork, House, Plus, Settings as SettingsIcon, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { repoName } from '../../lib/format'
import { modKey } from '../../lib/platform'
import { ContextMenu, type MenuState } from '../ui'

/** Pixels the pointer moves before a press on a tab becomes a drag (a click otherwise). */
const DRAG_THRESHOLD = 5
/** Distance from the strip's edges where a drag scrolls it, and the fastest speed (px/frame). */
const EDGE = 40
const MAX_SPEED = 14

interface Props {
  tabs: string[]
  activeTab: string | null
  worktreeParents: Record<string, string>
  onHome(): void
  onSelect(path: string): void
  onClose(path: string): void
  onReorder(tabs: string[]): void
  onOpenRepository(): void
  onClone(): void
  onProjects(): void
  onSettings(): void
}

interface Press {
  path: string
  pointerId: number
  startX: number
  /** Pointer x in strip content coordinates at the press. */
  startContentX: number
  dragging: boolean
  /** Content-coordinate boxes of every tab, measured when the drag starts. */
  boxes: { path: string; left: number; width: number }[]
  clientX: number
  /** The latest drop position, while dragging. */
  drop: Drag | null
}

interface Drag {
  path: string
  dx: number
  /** Index in the tabs without the dragged one where it would land. */
  insertAt: number
  /** Where it would land (content coordinates), shown as a slot the other tabs make room for. */
  slot: { left: number; width: number }
  /** Sideways offset of the other tabs, sliding aside to open the slot. */
  shifts: Record<string, number>
}

export function TabBar(props: Props): React.JSX.Element {
  const { tabs, activeTab, worktreeParents, onSelect, onClose, onReorder } = props
  const scroller = useRef<HTMLDivElement>(null)
  const press = useRef<Press | null>(null)
  const suppressClick = useRef(false)
  const frame = useRef(0)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** Tabs hidden past the left / right edge of the strip (a shadow hints at them). */
  const [overflow, setOverflow] = useState({ left: false, right: false })

  const measure = useCallback((): void => {
    const el = scroller.current
    if (!el) return
    const left = el.scrollLeft > 0
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setOverflow((o) => (o.left === left && o.right === right ? o : { left, right }))
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure])

  useLayoutEffect(measure, [measure, tabs])

  const contentX = (clientX: number): number => {
    const el = scroller.current!
    return clientX - el.getBoundingClientRect().left + el.scrollLeft
  }

  /** Recomputes where the dragged tab is and where it would drop. */
  const update = useCallback((): void => {
    const p = press.current
    const el = scroller.current
    if (!p || !p.dragging || !el) return
    const own = p.boxes.find((b) => b.path === p.path)!
    const last = p.boxes[p.boxes.length - 1]
    const max = last.left + last.width - own.width - own.left
    const dx = Math.max(-own.left, Math.min(max, contentX(p.clientX) - p.startContentX))
    // It lands where the pointer is: before the first tab whose middle is right of it.
    const x = contentX(p.clientX)
    const others = p.boxes.filter((b) => b.path !== p.path)
    const insertAt = others.filter((b) => b.left + b.width / 2 < x).length
    const from = p.boxes.indexOf(own)
    const shifts: Record<string, number> = {}
    others.forEach((b, i) => {
      const j = p.boxes.indexOf(b)
      if (j > from && i < insertAt) shifts[b.path] = -own.width
      else if (j < from && i >= insertAt) shifts[b.path] = own.width
    })
    const left = others.slice(0, insertAt).reduce((sum, b) => sum + b.width, p.boxes[0].left)
    p.drop = { path: p.path, dx, insertAt, slot: { left, width: own.width }, shifts }
    setDrag(p.drop)
  }, [])

  const stop = useCallback(
    (commit: boolean): void => {
      const p = press.current
      press.current = null
      cancelAnimationFrame(frame.current)
      if (!p?.dragging) return
      setDrag(null)
      const d = p.drop
      if (commit && d) {
        const others = tabs.filter((t) => t !== d.path)
        const next = [...others.slice(0, d.insertAt), d.path, ...others.slice(d.insertAt)]
        if (next.some((t, i) => t !== tabs[i])) onReorder(next)
      }
      // The click that follows the release must not select the tab.
      suppressClick.current = true
      setTimeout(() => (suppressClick.current = false), 0)
    },
    [tabs, onReorder]
  )

  useEffect(() => {
    // Scrolls the strip while the dragged tab is held near one of its edges.
    const autoScroll = (): void => {
      const p = press.current
      const el = scroller.current
      if (!p?.dragging || !el) return
      const { left, right } = el.getBoundingClientRect()
      const speed =
        p.clientX < left + EDGE
          ? -Math.min(MAX_SPEED, ((left + EDGE - p.clientX) / EDGE) * MAX_SPEED)
          : p.clientX > right - EDGE
            ? Math.min(MAX_SPEED, ((p.clientX - right + EDGE) / EDGE) * MAX_SPEED)
            : 0
      if (speed) {
        el.scrollLeft += speed
        update()
      }
      frame.current = requestAnimationFrame(autoScroll)
    }

    const onMove = (e: PointerEvent): void => {
      const p = press.current
      if (!p || e.pointerId !== p.pointerId) return
      p.clientX = e.clientX
      if (!p.dragging) {
        if (Math.abs(e.clientX - p.startX) < DRAG_THRESHOLD) return
        const el = scroller.current
        if (!el || tabs.length < 2) return
        p.dragging = true
        p.boxes = [...el.querySelectorAll<HTMLElement>('[data-tab-path]')].map((t) => ({
          path: t.dataset.tabPath!,
          left: t.offsetLeft,
          width: t.offsetWidth
        }))
        el.querySelector<HTMLElement>(`[data-tab-path="${CSS.escape(p.path)}"]`)?.setPointerCapture(
          p.pointerId
        )
        frame.current = requestAnimationFrame(autoScroll)
      }
      update()
    }
    const onUp = (e: PointerEvent): void => {
      if (press.current && e.pointerId === press.current.pointerId) stop(e.type === 'pointerup')
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && press.current?.dragging) {
        e.preventDefault()
        e.stopPropagation()
        stop(false)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [tabs, update, stop])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // Keep the active tab in view (shortcuts, a tab opened from Home, a moved tab).
  useLayoutEffect(() => {
    if (!activeTab || !scroller.current) return
    scroller.current
      .querySelector<HTMLElement>(`[data-tab-path="${CSS.escape(activeTab)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTab, tabs])

  const onPointerDown = (e: React.PointerEvent, path: string): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tab-close')) return
    press.current = {
      path,
      pointerId: e.pointerId,
      startX: e.clientX,
      startContentX: contentX(e.clientX),
      dragging: false,
      boxes: [],
      clientX: e.clientX,
      drop: null
    }
  }

  // Left / Right move the focus along the tabs (Home included); Enter or Space selects.
  const onStripKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[role=tab]')]
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    e.preventDefault()
    all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length].focus()
  }

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: 'Open repository…', onClick: props.onOpenRepository },
        { label: 'Clone…', onClick: props.onClone },
        'separator',
        { label: 'Projects', onClick: props.onProjects, hint: `${modKey}+Shift+1` }
      ]
    })
  }

  return (
    <div className={drag ? 'tabbar dragging' : 'tabbar'}>
      <div
        className={
          'tabbar-strip' +
          (overflow.left ? ' overflow-left' : '') +
          (overflow.right ? ' overflow-right' : '')
        }
        role="tablist"
        aria-label="Tabs"
        onKeyDown={onStripKey}
      >
        <button
          role="tab"
          aria-selected={activeTab === null}
          className={activeTab === null ? 'tab tab-home active' : 'tab tab-home'}
          title={`Home (${modKey}+1)`}
          onClick={props.onHome}
        >
          <House size={15} />
          <span>Home</span>
        </button>
        <div
          className="tabbar-tabs"
          ref={scroller}
          onScroll={measure}
          onWheel={(e) => {
            // A vertical wheel scrolls the strip sideways.
            if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY
          }}
        >
          {tabs.map((path, i) => {
            const name = repoName(path)
            const dragged = drag?.path === path
            const classes = ['tab']
            if (activeTab === path) classes.push('active')
            if (dragged) classes.push('drag-source')
            return (
              <div
                key={path}
                role="tab"
                tabIndex={0}
                data-tab-path={path}
                aria-selected={activeTab === path}
                className={classes.join(' ')}
                style={
                  drag && (dragged || drag.shifts[path])
                    ? { transform: `translateX(${dragged ? drag.dx : drag.shifts[path]}px)` }
                    : undefined
                }
                title={i < 8 ? `${path}\n${modKey}+${i + 2}` : path}
                onPointerDown={(e) => onPointerDown(e, path)}
                onClick={() => {
                  if (!suppressClick.current) onSelect(path)
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(path)
                  } else if (e.key === 'Delete') {
                    e.preventDefault()
                    onClose(path)
                  }
                }}
                // Middle click closes; its press would otherwise start autoscroll in the strip.
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                onAuxClick={(e) => e.button === 1 && onClose(path)}
              >
                {worktreeParents[path] ? (
                  <GitFork size={15} aria-label="worktree" />
                ) : (
                  <FolderGit2 size={15} />
                )}
                <span>{name}</span>
                <button
                  className="tab-close"
                  aria-label={`Close ${name}`}
                  title={`Close (${modKey}+W)`}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(path)
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            )
          })}
          {drag && (
            <div
              className="tab-drop-indicator"
              style={{ left: drag.slot.left, width: drag.slot.width }}
              aria-hidden="true"
            />
          )}
          <button
            className="tab-add"
            aria-label="Open or clone a repository"
            aria-haspopup="menu"
            title="Open or clone a repository"
            onClick={openMenu}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>
      <button
        className="tab tab-settings"
        onClick={props.onSettings}
        title={`Settings (${modKey}+,)`}
        aria-label="Settings"
      >
        <SettingsIcon size={15} />
      </button>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
