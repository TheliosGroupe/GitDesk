// Widths of the repository view's sidebar and right panel, shared by every tab and kept in localStorage.

import { useSyncExternalStore } from 'react'

export type Panel = 'sidebar' | 'right'

export const PANEL_LIMITS: Record<Panel, { min: number; max: number; initial: number }> = {
  sidebar: { min: 160, max: 520, initial: 240 },
  right: { min: 280, max: 760, initial: 380 }
}

const KEY = 'gitdesk.panelWidths'
const listeners = new Set<() => void>()

export const clampWidth = (panel: Panel, w: number): number =>
  Math.round(Math.min(PANEL_LIMITS[panel].max, Math.max(PANEL_LIMITS[panel].min, w)))

function load(): Record<Panel, number> {
  const widths = { sidebar: PANEL_LIMITS.sidebar.initial, right: PANEL_LIMITS.right.initial }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<Panel, unknown>>
    for (const p of ['sidebar', 'right'] as const)
      if (typeof saved[p] === 'number') widths[p] = clampWidth(p, saved[p])
  } catch {
    // Unreadable or blocked storage: defaults.
  }
  return widths
}

let widths = load()

export function setPanelWidth(panel: Panel, w: number | null): void {
  widths = { ...widths, [panel]: w === null ? PANEL_LIMITS[panel].initial : clampWidth(panel, w) }
  try {
    localStorage.setItem(KEY, JSON.stringify(widths))
  } catch {
    // Not persisted; still applied for this session.
  }
  listeners.forEach((l) => l())
}

export function usePanelWidths(): Record<Panel, number> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => widths
  )
}
