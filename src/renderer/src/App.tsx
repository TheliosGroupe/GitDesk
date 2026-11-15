import { CircleArrowUp, X } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { Account, AppState, UpdateStatus } from '../../shared/types'
import { CloneDialog, SignInDialog } from './components/GitHub'
import { RepoView } from './components/RepoView'
import { useEvent } from './components/shell/refresh'
import { CrashNotice, ErrorBoundary } from './components/shell/ErrorBoundary'
import { Home } from './components/shell/Home'
import { HOME_PAGES, readHomePage, saveHomePage, type HomePage } from './components/shell/HomePages'
import { TabBar } from './components/shell/TabBar'
import { DialogProvider, ToastProvider } from './components/ui'
import { useToasts } from './components/ui-context'
import { errorMessage, repoName } from './lib/format'
import { isolateText } from './lib/highlight'
import { hasMod, isMac } from './lib/platform'
import { useLanePalette, useTheme } from './lib/theme'

// Loaded when first opened, not at startup.
const SettingsDialog = lazy(() =>
  import('./components/SettingsDialog').then((m) => ({ default: m.SettingsDialog }))
)

/** Physical digit keys, so Ctrl+1 works on AZERTY keyboards too (where the key types "&"). */
function digitOf(e: KeyboardEvent): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)
  return m ? Number(m[1]) : null
}

function App(): React.JSX.Element {
  const toasts = useToasts()
  const [state, setState] = useState<AppState | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [dialog, setDialog] = useState<'settings' | 'signin' | 'clone' | null>(null)
  /** The Home page shown when no repository tab is active (the last one chosen). */
  const [home, setHome] = useState<HomePage>(readHomePage)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)

  useTheme(state?.settings.theme)
  useLanePalette(state?.settings.branchColors)

  useEffect(() => {
    window.api.getState().then(setState)
    window.api.accounts().then(setAccounts)
    window.api.updateStatus().then(setUpdate, () => {})
    return window.api.onUpdateStatus((status) => {
      setUpdate(status)
      if (status.state === 'ready' || status.state === 'available') setUpdateDismissed(false)
    })
  }, [])

  const updateTabs = useCallback((openTabs: string[], activeTab: string | null) => {
    setState((s) => (s ? { ...s, openTabs, activeTab } : s))
    window.api.setTabs(openTabs, activeTab)
  }, [])

  const showHome = useCallback(
    (page: HomePage | null, openTabs: string[]) => {
      if (page) {
        setHome(page)
        saveHomePage(page)
      }
      updateTabs(openTabs, null)
    },
    [updateTabs]
  )

  const close = useCallback(
    (path: string): void => {
      if (!state) return
      const index = state.openTabs.indexOf(path)
      const tabs = state.openTabs.filter((t) => t !== path)
      const active =
        state.activeTab === path
          ? (tabs[Math.min(index, tabs.length - 1)] ?? null)
          : state.activeTab
      updateTabs(tabs, active)
    },
    [state, updateTabs]
  )

  // Tab shortcuts. Repository-specific keys (F5, Ctrl+F…) belong to the repository view.
  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent): void => {
      if (!hasMod(e) || e.altKey) return
      if (dialog || document.querySelector('.modal-backdrop')) return
      const { openTabs, activeTab } = state
      // Every tab in strip order: Home (null), then the repositories.
      const order: (string | null)[] = [null, ...openTabs]
      const select = (i: number): void => {
        const target = order[i]
        if (target === null) showHome(null, openTabs)
        else updateTabs(openTabs, target)
      }
      const digit = digitOf(e)
      const key = e.key.toLowerCase()
      // On Windows and Linux the terminal keeps Ctrl+W (the shell's delete-a-word) for itself.
      // On macOS ⌘W is not a terminal key: xterm ignores it, and the default menu's Close
      // Window would close the whole window, so it closes the tab as anywhere else.
      const inTerminal = !isMac && e.target instanceof HTMLElement && !!e.target.closest('.xterm')
      if (digit !== null && e.shiftKey) {
        // Shift+1-4: a Home page, from anywhere.
        if (digit <= HOME_PAGES.length) showHome(HOME_PAGES[digit - 1], openTabs)
      } else if (digit !== null) {
        // 1: Home, 2-9: repository tabs in order.
        if (digit - 1 < order.length) select(digit - 1)
      } else if (key === 'tab') {
        const current = order.indexOf(activeTab)
        select((current + (e.shiftKey ? -1 : 1) + order.length) % order.length)
      } else if ((key === 'pageup' || key === 'pagedown') && e.shiftKey) {
        // Moves the active repository tab left or right (the keyboard way to drag it).
        const from = activeTab ? openTabs.indexOf(activeTab) : -1
        const to = from + (key === 'pageup' ? -1 : 1)
        if (from >= 0 && to >= 0 && to < openTabs.length) {
          const tabs = [...openTabs]
          ;[tabs[from], tabs[to]] = [tabs[to], tabs[from]]
          updateTabs(tabs, activeTab)
        }
      } else if (key === 'w' && !e.shiftKey && !inTerminal) {
        // Also keeps Ctrl+W from closing the window when a home tab is active.
        if (activeTab) close(activeTab)
      } else if (key === ',') {
        setDialog('settings')
      } else {
        return
      }
      e.preventDefault()
      e.stopPropagation()
    }
    // Capture phase: the terminal would otherwise turn Ctrl+digit into control characters.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state, dialog, showHome, updateTabs, close])

  // Stable identities for the memoized repository views: each call sees the latest state.
  const getState = useEvent((): AppState | null => state)
  const open = useEvent((path: string): void => {
    if (!state) return
    if (!state.repos.includes(path)) {
      // Added by the main process (e.g. cloned from the Launchpad): reload the list first,
      // otherwise the new tab would be dropped as unknown.
      window.api.getState().then((next) => {
        const tabs = next.openTabs.includes(path) ? next.openTabs : [...next.openTabs, path]
        setState(next)
        if (next.repos.includes(path)) updateTabs(tabs, path)
      })
      return
    }
    const tabs = state.openTabs.includes(path) ? state.openTabs : [...state.openTabs, path]
    updateTabs(tabs, path)
  })

  if (!state) return <div className="app" />

  /** "+" → Open repository…: adds the chosen folder and opens it in a tab. */
  const openRepository = async (): Promise<void> => {
    try {
      const before = new Set(state.repos)
      const next = await window.api.addRepo()
      const added = next.repos.find((r) => !before.has(r))
      setState(next)
      if (added) updateTabs([...next.openTabs.filter((t) => t !== added), added], added)
    } catch (e) {
      toasts.error(errorMessage(e))
    }
  }

  return (
    <div className="app">
      <TabBar
        tabs={state.openTabs}
        activeTab={state.activeTab}
        worktreeParents={state.worktreeParents}
        onHome={() => showHome(null, state.openTabs)}
        onSelect={(path) => updateTabs(state.openTabs, path)}
        onClose={close}
        onReorder={(tabs) => updateTabs(tabs, state.activeTab)}
        onOpenRepository={openRepository}
        onClone={() => setDialog('clone')}
        onProjects={() => showHome('projects', state.openTabs)}
        onSettings={() => setDialog('settings')}
      />
      <div className="tab-content">
        {state.activeTab === null && (
          <ErrorBoundary
            resetKey={home}
            fallback={(error, retry) => (
              <div className="repo-view loading">
                <CrashNotice title="This page of Home ran into a problem." error={error}>
                  <button className="btn primary" onClick={retry}>
                    Try again
                  </button>
                </CrashNotice>
              </div>
            )}
          >
            <Home
              page={home}
              onPage={(page) => showHome(page, state.openTabs)}
              state={state}
              accounts={accounts}
              onOpenRepo={open}
              onStateChange={setState}
              onAccounts={setAccounts}
              onSignIn={() => setDialog('signin')}
            />
          </ErrorBoundary>
        )}
        {/* One boundary per tab: a crashed repository view can still be closed. */}
        {state.openTabs.map((path) => (
          <ErrorBoundary
            key={path}
            fallback={(error, retry) => (
              <div
                className="repo-view loading"
                style={{ display: state.activeTab === path ? undefined : 'none' }}
              >
                <CrashNotice
                  title={`${isolateText(repoName(path))} could not be shown.`}
                  error={error}
                >
                  <button className="btn primary" onClick={() => close(path)}>
                    Close tab
                  </button>
                  <button className="btn" onClick={retry}>
                    Try again
                  </button>
                </CrashNotice>
              </div>
            )}
          >
            <RepoView
              repo={path}
              active={state.activeTab === path}
              settings={state.settings}
              worktreeOf={state.worktreeParents[path] ?? null}
              getState={getState}
              accountsKey={accounts.map((a) => a.login).join(',')}
              onOpenRepo={open}
              onStateChange={setState}
            />
          </ErrorBoundary>
        ))}
      </div>

      {(update?.state === 'ready' || update?.state === 'available') && !updateDismissed && (
        <div className="update-banner" role="status">
          <CircleArrowUp size={16} className="update-banner-icon" />
          <span>
            GitDesk {update.version ? `v${update.version} ` : ''}
            {update.state === 'ready' ? 'is ready to install.' : 'is available.'}
          </span>
          {/* "available": downloads it, or opens the release page where GitDesk cannot
              install itself (unsigned macOS builds). */}
          <button className="btn small primary" onClick={() => window.api.installUpdate()}>
            {update.state === 'ready' ? 'Restart to update' : 'Get update'}
          </button>
          <button
            className="icon-btn"
            aria-label="Later"
            title="Later"
            onClick={() => setUpdateDismissed(true)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {dialog === 'settings' && (
        <Suspense fallback={null}>
          <SettingsDialog
            state={state}
            accounts={accounts}
            onAccounts={setAccounts}
            onChange={setState}
            onClose={() => setDialog(null)}
          />
        </Suspense>
      )}
      {dialog === 'clone' && (
        <CloneDialog
          accounts={accounts}
          settings={state.settings}
          followed={new Set()}
          onClose={() => setDialog(null)}
          onSettings={setState}
          onSignIn={() => setDialog('signin')}
          onCloned={({ state: next, path }) => {
            setDialog(null)
            setState(next)
            updateTabs(
              next.openTabs.includes(path) ? next.openTabs : [...next.openTabs, path],
              path
            )
            toasts.info(`Cloned ${isolateText(repoName(path))}`)
          }}
        />
      )}
      {dialog === 'signin' && (
        <SignInDialog
          settings={state.settings}
          onSettings={setState}
          onClose={() => setDialog(null)}
          onSignedIn={(account) => {
            setDialog(null)
            setAccounts((list) => [...list.filter((a) => a.id !== account.id), account])
            if (account.tokenExpires) {
              toasts.error(
                `Signed in as ${account.login}, but this OAuth App gives tokens that expire after 8 hours. ` +
                  'On GitHub, untick “Expire user access tokens” in the app settings, then sign in again.'
              )
            } else {
              toasts.info(`Signed in to GitHub as ${account.login}`)
            }
          }}
        />
      )}
    </div>
  )
}

export default function Root(): React.JSX.Element {
  return (
    <ToastProvider>
      <DialogProvider>
        <App />
      </DialogProvider>
    </ToastProvider>
  )
}
