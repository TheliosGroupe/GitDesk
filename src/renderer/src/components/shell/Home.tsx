// The Home tab: Projects, Launchpad, Agents and Activity behind one pinned tab, with a compact
// navigation on the left that can be collapsed to icons.

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { lazy, Suspense, useRef, useState } from 'react'
import type { Account, AppState } from '../../../../shared/types'
import { Dashboard } from '../Dashboard'
import { modKey } from '../../lib/platform'
import { HOME_PAGE_INFO, HOME_PAGES, readStored, writeStored, type HomePage } from './HomePages'

const COLLAPSED_KEY = 'gitdesk.homeNavCollapsed'

// Loaded when first shown, not at startup (Agents brings the terminal, xterm).
const ActivityView = lazy(() => import('../Activity').then((m) => ({ default: m.ActivityView })))
const LaunchpadView = lazy(() =>
  import('../hosting/LaunchpadView').then((m) => ({ default: m.LaunchpadView }))
)
const AgentsView = lazy(() =>
  import('../terminal/AgentsView').then((m) => ({ default: m.AgentsView }))
)

interface Props {
  page: HomePage
  onPage(page: HomePage): void
  state: AppState
  accounts: Account[]
  onOpenRepo(path: string): void
  onStateChange(state: AppState): void
  onAccounts(accounts: Account[]): void
  onSignIn(): void
}

export function Home({
  page,
  onPage,
  state,
  accounts,
  onOpenRepo,
  onStateChange,
  onAccounts,
  onSignIn
}: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(() => readStored(COLLAPSED_KEY) === '1')
  const navRef = useRef<HTMLDivElement>(null)

  const toggle = (): void => {
    setCollapsed((c) => {
      writeStored(COLLAPSED_KEY, c ? '0' : '1')
      return !c
    })
  }

  /** Small counts next to the pages, from what is already loaded (nothing fetched for them). */
  const badges: Partial<Record<HomePage, number>> = {
    projects: state.repos.length,
    agents: state.agentSessions.length
  }

  // Arrow keys move between the pages, like any vertical tab list.
  const onNavKey = (e: React.KeyboardEvent): void => {
    const delta = { ArrowDown: 1, ArrowUp: -1 }[e.key]
    const edge = { Home: 0, End: HOME_PAGES.length - 1 }[e.key]
    if (delta === undefined && edge === undefined) return
    e.preventDefault()
    const next = edge ?? (HOME_PAGES.indexOf(page) + delta! + HOME_PAGES.length) % HOME_PAGES.length
    onPage(HOME_PAGES[next])
    navRef.current?.querySelectorAll<HTMLElement>('[role=tab]')[next]?.focus()
  }

  return (
    <div className={collapsed ? 'home collapsed' : 'home'}>
      <nav className="home-nav" aria-label="Home">
        <div
          ref={navRef}
          role="tablist"
          aria-orientation="vertical"
          aria-label="Home pages"
          className="home-nav-list"
          onKeyDown={onNavKey}
        >
          {HOME_PAGES.map((p, i) => {
            const { label, icon } = HOME_PAGE_INFO[p]
            const badge = badges[p]
            const selected = p === page
            return (
              <button
                key={p}
                role="tab"
                id={`home-tab-${p}`}
                aria-selected={selected}
                aria-controls="home-page"
                aria-label={label}
                tabIndex={selected ? 0 : -1}
                className={selected ? 'home-nav-item active' : 'home-nav-item'}
                title={`${label}${badge ? ` (${badge})` : ''} — ${modKey}+Shift+${i + 1}`}
                onClick={() => onPage(p)}
              >
                {icon}
                <span className="home-nav-label">{label}</span>
                {!!badge && <span className="home-nav-badge">{badge}</span>}
              </button>
            )
          })}
        </div>
        <button
          className="home-nav-item home-nav-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand the navigation' : 'Collapse the navigation'}
          title={collapsed ? 'Expand the navigation' : 'Collapse the navigation'}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          <span className="home-nav-label">Collapse</span>
        </button>
      </nav>
      <div
        className="home-page"
        id="home-page"
        role="tabpanel"
        aria-labelledby={`home-tab-${page}`}
      >
        <Suspense fallback={<div className="empty-state">Loading…</div>}>
          {page === 'projects' && (
            <Dashboard
              state={state}
              accounts={accounts}
              onOpen={onOpenRepo}
              onStateChange={onStateChange}
              onAccounts={onAccounts}
              onSignIn={onSignIn}
            />
          )}
          {page === 'launchpad' && (
            <LaunchpadView
              state={state}
              accounts={accounts}
              onOpenRepo={onOpenRepo}
              onSignIn={onSignIn}
            />
          )}
          {page === 'agents' && (
            <AgentsView state={state} onOpenRepo={onOpenRepo} onStateChange={onStateChange} />
          )}
          {page === 'activity' && (
            <ActivityView
              state={state}
              accounts={accounts}
              onOpenRepo={onOpenRepo}
              onSignIn={onSignIn}
            />
          )}
        </Suspense>
      </div>
    </div>
  )
}
