// Layout of the repository view, shared by every tab and kept in localStorage: collapsed side
// panels, focus mode, the maximized terminal, sidebar sections and the working copy sections.

import { clamp, createLayoutStore, isRecord } from './layoutStore'

// ---- side panels, focus mode, terminal ------------------------------------------------------

export interface PanelLayout {
  /** The sidebar is collapsed to its icon rail. */
  sidebarCollapsed: boolean
  /** The details panel (commit / working copy) is collapsed to a thin rail. */
  rightCollapsed: boolean
  /** Focus mode: both side panels hidden; turning it off brings back the state above. */
  focus: boolean
  /** The terminal fills the center column. */
  terminalMaximized: boolean
}

const PANEL_DEFAULTS: PanelLayout = {
  sidebarCollapsed: false,
  rightCollapsed: false,
  focus: false,
  terminalMaximized: false
}

export function sanitizePanelLayout(saved: unknown): PanelLayout {
  const out = { ...PANEL_DEFAULTS }
  if (isRecord(saved))
    for (const k of Object.keys(PANEL_DEFAULTS) as (keyof PanelLayout)[])
      if (typeof saved[k] === 'boolean') out[k] = saved[k]
  return out
}

const panels = createLayoutStore('gitdesk.layout.panels', sanitizePanelLayout)
export const usePanelLayout = panels.use

/** What each side panel shows: the full panel, a thin rail, or nothing (focus mode). */
export type PanelMode = 'open' | 'rail' | 'hidden'

export function panelModes(l: PanelLayout): { sidebar: PanelMode; right: PanelMode } {
  if (l.focus) return { sidebar: 'hidden', right: 'hidden' }
  return {
    sidebar: l.sidebarCollapsed ? 'rail' : 'open',
    right: l.rightCollapsed ? 'rail' : 'open'
  }
}

/**
 * Collapses or expands a side panel. In focus mode, showing a panel leaves focus mode with
 * that panel open and the other one collapsed (it was hidden a moment ago).
 */
export function togglePanelState(l: PanelLayout, panel: 'sidebar' | 'right'): PanelLayout {
  const key = panel === 'sidebar' ? 'sidebarCollapsed' : 'rightCollapsed'
  const other = panel === 'sidebar' ? 'rightCollapsed' : 'sidebarCollapsed'
  if (l.focus) return { ...l, focus: false, [key]: false, [other]: true }
  return { ...l, [key]: !l[key] }
}

export const togglePanel = (panel: 'sidebar' | 'right'): void =>
  panels.set((l) => togglePanelState(l, panel))

export const expandPanel = (panel: 'sidebar' | 'right'): void =>
  panels.set((l) => {
    const key = panel === 'sidebar' ? 'sidebarCollapsed' : 'rightCollapsed'
    return l[key] || l.focus ? togglePanelState({ ...l, [key]: true }, panel) : l
  })

export const toggleFocus = (): void => panels.set((l) => ({ ...l, focus: !l.focus }))

export const setTerminalMaximized = (terminalMaximized: boolean): void =>
  panels.set((l) => (l.terminalMaximized === terminalMaximized ? l : { ...l, terminalMaximized }))

// ---- sidebar sections -----------------------------------------------------------------------

export type SidebarSectionId =
  'local' | 'remote' | 'worktrees' | 'pulls' | 'issues' | 'tags' | 'stashes'

/** Sections opened or closed by hand (the others follow their default). */
type SectionState = Partial<Record<SidebarSectionId, boolean>>

const sections = createLayoutStore<SectionState>('gitdesk.layout.sidebarSections', (saved) => {
  const out: SectionState = {}
  if (isRecord(saved))
    for (const [k, v] of Object.entries(saved))
      if (typeof v === 'boolean') out[k as SidebarSectionId] = v
  return out
})
export const useSidebarSections = sections.use

export const setSidebarSection = (id: SidebarSectionId, open: boolean): void =>
  sections.set((s) => (s[id] === open ? s : { ...s, [id]: open }))

export const setAllSidebarSections = (ids: SidebarSectionId[], open: boolean): void =>
  sections.set((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, open])) }))

// ---- working copy sections ------------------------------------------------------------------

export type WorkingSectionId = 'unstaged' | 'staged' | 'commit'

export interface WorkingLayout {
  collapsed: Record<WorkingSectionId, boolean>
  /** Share of the unstaged list in the space of the two file lists (0.5 = half each). */
  split: number
  /** Height of the commit box in pixels, or null for its natural height. */
  commitHeight: number | null
  /** One file list takes the whole panel (the other sections show only their title). */
  maximized: 'unstaged' | 'staged' | null
}

export const SPLIT_LIMITS = { min: 0.1, max: 0.9, initial: 0.5 }
export const COMMIT_HEIGHT_LIMITS = { min: 150, max: 900 }

export function sanitizeWorkingLayout(saved: unknown): WorkingLayout {
  const out: WorkingLayout = {
    collapsed: { unstaged: false, staged: false, commit: false },
    split: SPLIT_LIMITS.initial,
    commitHeight: null,
    maximized: null
  }
  if (!isRecord(saved)) return out
  if (isRecord(saved.collapsed))
    for (const k of ['unstaged', 'staged', 'commit'] as const)
      if (typeof saved.collapsed[k] === 'boolean') out.collapsed[k] = saved.collapsed[k]
  if (typeof saved.split === 'number' && Number.isFinite(saved.split))
    out.split = clamp(saved.split, SPLIT_LIMITS.min, SPLIT_LIMITS.max)
  if (typeof saved.commitHeight === 'number' && Number.isFinite(saved.commitHeight))
    out.commitHeight = Math.round(
      clamp(saved.commitHeight, COMMIT_HEIGHT_LIMITS.min, COMMIT_HEIGHT_LIMITS.max)
    )
  if (saved.maximized === 'unstaged' || saved.maximized === 'staged')
    out.maximized = saved.maximized
  return out
}

const working = createLayoutStore('gitdesk.layout.workingCopy', sanitizeWorkingLayout)
export const useWorkingLayout = working.use

/** Collapsed as shown: a maximized list collapses the other sections. */
export function workingCollapsed(l: WorkingLayout, id: WorkingSectionId): boolean {
  if (l.maximized) return l.maximized !== id
  return l.collapsed[id]
}

export function toggleWorkingSection(id: WorkingSectionId): void {
  working.set((l) => {
    // Opening a section hidden by a maximized list brings the normal layout back.
    if (l.maximized && l.maximized !== id)
      return { ...l, maximized: null, collapsed: { ...l.collapsed, [id]: false } }
    if (l.maximized === id)
      return { ...l, maximized: null, collapsed: { ...l.collapsed, [id]: true } }
    return { ...l, collapsed: { ...l.collapsed, [id]: !l.collapsed[id] } }
  })
}

export const toggleWorkingMaximized = (id: 'unstaged' | 'staged'): void =>
  working.set((l) => ({
    ...l,
    maximized: l.maximized === id ? null : id,
    collapsed: { ...l.collapsed, [id]: false }
  }))

export const setWorkingSplit = (split: number | null): void =>
  working.set((l) => ({
    ...l,
    split: split === null ? SPLIT_LIMITS.initial : clamp(split, SPLIT_LIMITS.min, SPLIT_LIMITS.max)
  }))

export const setCommitHeight = (h: number | null): void =>
  working.set((l) => ({
    ...l,
    commitHeight:
      h === null ? null : Math.round(clamp(h, COMMIT_HEIGHT_LIMITS.min, COMMIT_HEIGHT_LIMITS.max))
  }))
