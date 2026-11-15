// The repository's terminal panel, under the center view. Once opened it stays mounted
// (hidden when toggled off), so its shells keep running while you look at something else.

import { lazy, Suspense } from 'react'
import type { TerminalState } from './terminalState'

// The terminal (xterm) is loaded the first time it is opened, not at startup.
const TerminalPanel = lazy(() =>
  import('../terminal/TerminalPanel').then((m) => ({ default: m.TerminalPanel }))
)

export function TerminalDock({
  cwd,
  state,
  tabActive,
  onHide,
  maximized,
  onToggleMaximized
}: {
  cwd: string
  state: TerminalState
  /** The repository tab is the one shown. */
  tabActive: boolean
  onHide(): void
  /** The terminal fills the center column (the graph or diff is hidden under it). */
  maximized: boolean
  onToggleMaximized(): void
}): React.JSX.Element | null {
  if (state === 'closed') return null
  return (
    <div className="terminal-dock" hidden={state === 'hidden'}>
      <Suspense fallback={null}>
        <TerminalPanel
          cwd={cwd}
          active={tabActive && state === 'open'}
          onClose={onHide}
          maximized={maximized}
          onToggleMaximized={onToggleMaximized}
        />
      </Suspense>
    </div>
  )
}
