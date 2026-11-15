// Keyboard shortcuts of the repository view: one table for matching keys, button titles and the help.

import { hasMod, modKey } from './platform'

export type ShortcutId =
  | 'sync'
  | 'push'
  | 'pull'
  | 'branch'
  | 'stash'
  | 'undo'
  | 'search'
  | 'stageAll'
  | 'terminal'
  | 'toggleSidebar'
  | 'toggleDetails'
  | 'focusMode'
  | 'help'

interface Def {
  /** KeyboardEvent.key, lowercase for letters. */
  key: string
  /** KeyboardEvent.code that also matches (keys that move between layouts, e.g. the backquote). */
  code?: string
  mod?: boolean
  shift?: boolean
  label: string
  /** Also works while typing in a text field (no text-editing meaning). */
  inFields?: boolean
}

const DEFS: Record<ShortcutId, Def> = {
  sync: { key: 'F5', label: 'Sync: fetch all remotes and refresh', inFields: true },
  push: { key: 'p', mod: true, shift: true, label: 'Push current branch' },
  pull: { key: 'l', mod: true, shift: true, label: 'Pull (fast-forward only)' },
  branch: { key: 'b', mod: true, label: 'Create a branch' },
  stash: { key: 's', mod: true, shift: true, label: 'Stash all changes' },
  undo: { key: 'z', mod: true, label: 'Undo the last action' },
  search: { key: 'f', mod: true, label: 'Search commits', inFields: true },
  stageAll: { key: 'a', mod: true, shift: true, label: 'Stage all changes' },
  terminal: {
    key: '`',
    code: 'Backquote',
    mod: true,
    label: 'Show or hide the terminal',
    inFields: true
  },
  toggleSidebar: {
    key: 'b',
    mod: true,
    shift: true,
    label: 'Collapse or expand the sidebar',
    inFields: true
  },
  toggleDetails: {
    key: 'j',
    mod: true,
    shift: true,
    label: 'Collapse or expand the details panel',
    inFields: true
  },
  focusMode: {
    key: 'f',
    mod: true,
    shift: true,
    label: 'Focus mode: hide both side panels',
    inFields: true
  },
  help: { key: '?', label: 'Show keyboard shortcuts' }
}

/** e.g. "Ctrl+Shift+P" (or "⌘+Shift+P" on macOS). */
export function keysOf(id: ShortcutId): string {
  const d = DEFS[id]
  return [d.mod && modKey, d.shift && 'Shift', d.key.length === 1 ? d.key.toUpperCase() : d.key]
    .filter(Boolean)
    .join('+')
}

/** Button title with its shortcut, e.g. "Push current branch (Ctrl+Shift+P)". */
export function titled(text: string, id: ShortcutId): string {
  return `${text} (${keysOf(id)})`
}

/** True when the key goes to a text field (inputs, textareas, editable content). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement)
    return !['checkbox', 'radio', 'button', 'submit'].includes(target.type)
  return false
}

export function matchShortcut(e: KeyboardEvent): ShortcutId | null {
  if (e.altKey || e.repeat) return null
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const typing = isTypingTarget(e.target)
  for (const [id, d] of Object.entries(DEFS) as [ShortcutId, Def][]) {
    if ((d.key !== key && !(d.code && d.code === e.code)) || (typing && !d.inFields)) continue
    // "?" needs Shift on most layouts, so only the modifier is checked for it.
    if (id === 'help') {
      if (!e.ctrlKey && !e.metaKey) return id
      continue
    }
    if (!!d.mod === hasMod(e) && !!d.shift === e.shiftKey) return id
  }
  return null
}

/** Everything listed in the shortcuts help, including keys handled elsewhere. */
export const HELP_SECTIONS: { title: string; items: { keys: string; label: string }[] }[] = [
  {
    title: 'Repository',
    items: (
      [
        'sync',
        'pull',
        'push',
        'branch',
        'stash',
        'undo',
        'stageAll',
        'terminal',
        'toggleSidebar',
        'toggleDetails',
        'focusMode'
      ] as const
    ).map((id) => ({ keys: keysOf(id), label: DEFS[id].label }))
  },
  {
    title: 'Navigation',
    items: [
      { keys: keysOf('search'), label: DEFS.search.label },
      { keys: '↑ / ↓', label: 'Previous / next commit in the graph' },
      { keys: `${modKey}+Click`, label: 'Compare the selected commit with another one' },
      { keys: 'Esc', label: 'Close the diff, a menu or a dialog' },
      { keys: '?', label: DEFS.help.label }
    ]
  },
  {
    title: 'Commit',
    items: [{ keys: `${modKey}+Enter`, label: 'Commit (in the summary or description)' }]
  },
  {
    // Handled by App.tsx.
    title: 'Tabs',
    items: [
      { keys: `${modKey}+1`, label: 'Home' },
      { keys: `${modKey}+2…9`, label: 'Repository tabs, in order' },
      { keys: `${modKey}+Shift+1…4`, label: 'Home: Projects, Launchpad, Agents, Activity' },
      { keys: `${modKey}+Tab`, label: 'Next tab (Shift: previous)' },
      {
        keys: `${modKey}+Shift+PageUp / PageDown`,
        label: 'Move the repository tab left / right (or drag it)'
      },
      { keys: `${modKey}+W`, label: 'Close the repository tab' },
      { keys: `${modKey}+,`, label: 'Settings' }
    ]
  }
]
