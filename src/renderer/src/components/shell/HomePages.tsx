// The pages behind the Home tab, and the small per-viewer memory of which one was shown last.

import { Activity, Bot, LayoutGrid, Rocket } from 'lucide-react'

export type HomePage = 'projects' | 'launchpad' | 'agents' | 'activity'
export const HOME_PAGES: HomePage[] = ['projects', 'launchpad', 'agents', 'activity']

export const HOME_PAGE_INFO: Record<HomePage, { label: string; icon: React.JSX.Element }> = {
  projects: { label: 'Projects', icon: <LayoutGrid size={16} /> },
  launchpad: { label: 'Launchpad', icon: <Rocket size={16} /> },
  agents: { label: 'Agents', icon: <Bot size={16} /> },
  activity: { label: 'Activity', icon: <Activity size={16} /> }
}

const PAGE_KEY = 'gitdesk.homePage'

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: only not remembered.
  }
}

/** The Home page shown last (Projects the first time). */
export function readHomePage(): HomePage {
  const saved = readStored(PAGE_KEY)
  return HOME_PAGES.includes(saved as HomePage) ? (saved as HomePage) : 'projects'
}

export function saveHomePage(page: HomePage): void {
  writeStored(PAGE_KEY, page)
}
