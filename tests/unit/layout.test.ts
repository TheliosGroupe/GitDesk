import { describe, expect, it } from 'vitest'
import {
  panelModes,
  sanitizePanelLayout,
  sanitizeWorkingLayout,
  togglePanelState,
  workingCollapsed,
  type PanelLayout
} from '../../src/renderer/src/lib/layout'
import {
  COLUMNS,
  autoHiddenColumns,
  columnsTemplate,
  minRowWidth,
  sanitizeColumns
} from '../../src/renderer/src/lib/layoutColumns'

const base: PanelLayout = {
  sidebarCollapsed: false,
  rightCollapsed: false,
  focus: false,
  terminalMaximized: false
}

describe('panel layout', () => {
  it('reads only booleans from storage', () => {
    expect(sanitizePanelLayout(undefined)).toEqual(base)
    expect(sanitizePanelLayout({ focus: 'yes', sidebarCollapsed: true })).toEqual({
      ...base,
      sidebarCollapsed: true
    })
  })

  it('focus mode hides both panels and keeps their state for later', () => {
    const l = { ...base, sidebarCollapsed: true, focus: true }
    expect(panelModes(l)).toEqual({ sidebar: 'hidden', right: 'hidden' })
    expect(panelModes({ ...l, focus: false })).toEqual({ sidebar: 'rail', right: 'open' })
  })

  it('showing a panel in focus mode leaves it, with the other panel collapsed', () => {
    expect(togglePanelState({ ...base, focus: true }, 'sidebar')).toEqual({
      ...base,
      rightCollapsed: true
    })
    expect(togglePanelState(base, 'right')).toEqual({ ...base, rightCollapsed: true })
  })
})

describe('working copy layout', () => {
  it('clamps the split and the commit box height', () => {
    const l = sanitizeWorkingLayout({ split: 3, commitHeight: 20, maximized: 'other' })
    expect(l.split).toBe(0.9)
    expect(l.commitHeight).toBe(150)
    expect(l.maximized).toBeNull()
  })

  it('a maximized list folds the other sections', () => {
    const l = { ...sanitizeWorkingLayout(undefined), maximized: 'staged' as const }
    expect(workingCollapsed(l, 'staged')).toBe(false)
    expect(workingCollapsed(l, 'unstaged')).toBe(true)
    expect(workingCollapsed(l, 'commit')).toBe(true)
  })
})

describe('graph columns', () => {
  it('drops unknown columns and never hides the message', () => {
    const s = sanitizeColumns({ widths: { author: 9999, nope: 3 }, hidden: ['msg', 'sha', 'x'] })
    expect(s.widths).toEqual({ author: 480 })
    expect(s.hidden).toEqual(['sha'])
  })

  it('sized columns keep their width, the others can shrink, the message fills', () => {
    expect(columnsTemplate(COLUMNS, { author: 200 })).toBe(
      'minmax(48px, var(--col-refs)) var(--col-graph) minmax(120px, 1fr) ' +
        'var(--col-author) minmax(48px, var(--col-date)) minmax(48px, var(--col-sha))'
    )
    expect(columnsTemplate(COLUMNS, { msg: 300 })).toContain('var(--col-msg)')
    expect(minRowWidth(COLUMNS, { author: 200 }, 64)).toBe(48 + 64 + 120 + 200 + 48 + 48)
  })

  it('narrow graphs hide SHA, then date, then author, but not columns sized by hand', () => {
    expect(autoHiddenColumns(COLUMNS, {}, 64, 1000)).toEqual([])
    expect(autoHiddenColumns(COLUMNS, {}, 64, 650)).toEqual(['sha'])
    expect(autoHiddenColumns(COLUMNS, {}, 64, 380)).toEqual(['sha', 'date', 'author'])
    expect(autoHiddenColumns(COLUMNS, { date: 110 }, 64, 380)).toEqual(['sha', 'author'])
  })
})
