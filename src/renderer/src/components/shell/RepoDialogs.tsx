// Dialogs the repository view opens (one at a time), from menus, the toolbar or shortcuts.

import { lazy, Suspense } from 'react'
import type { AppState } from '../../../../shared/types'
import { ComposerDialog } from '../ai/ComposerDialog'
import { ExplainDialog } from '../ai/ExplainDialog'
import { CreatePullRequestDialog } from '../hosting/CreatePullRequestDialog'
import { ShortcutsHelp } from '../ShortcutsHelp'
import { StartAgentDialog } from '../terminal/StartAgentDialog'

// Loaded when first opened, not at startup.
const RebaseDialog = lazy(() =>
  import('../RebaseDialog').then((m) => ({ default: m.RebaseDialog }))
)

export type ExplainTarget =
  { kind: 'commit'; sha: string } | { kind: 'branch'; branch: string; base: string | null }

export type RepoDialog =
  | { kind: 'rebase'; base: string; baseLabel: string }
  | { kind: 'startAgent'; baseRef: string | null }
  | { kind: 'explain'; target: ExplainTarget }
  | { kind: 'composer' }
  | { kind: 'createPullRequest'; branch: string }
  | { kind: 'help' }

export function RepoDialogs({
  repo,
  dialog,
  getState,
  onClose,
  onRefresh,
  onAgentStarted
}: {
  repo: string
  dialog: RepoDialog | null
  /** The app state as it is now (read when the dialog renders). */
  getState(): AppState | null
  onClose(): void
  /** The repository changed (rebase, composed commits…). */
  onRefresh(): void
  onAgentStarted(worktreePath: string, state: AppState): void
}): React.JSX.Element | null {
  if (!dialog) return null
  const done = (): void => {
    onClose()
    onRefresh()
  }
  switch (dialog.kind) {
    case 'rebase':
      return (
        <Suspense fallback={null}>
          <RebaseDialog
            repo={repo}
            base={dialog.base}
            baseLabel={dialog.baseLabel}
            onClose={onClose}
            onDone={done}
          />
        </Suspense>
      )
    case 'startAgent': {
      const state = getState()
      if (!state) return null
      return (
        <StartAgentDialog
          repo={repo}
          baseRef={dialog.baseRef}
          state={state}
          onClose={onClose}
          onStarted={(worktreePath, next) => {
            onClose()
            onAgentStarted(worktreePath, next)
          }}
        />
      )
    }
    case 'explain':
      return <ExplainDialog repo={repo} target={dialog.target} onClose={onClose} />
    case 'composer':
      return <ComposerDialog repo={repo} onClose={onClose} onDone={done} />
    case 'createPullRequest':
      return (
        <CreatePullRequestDialog
          repo={repo}
          branch={dialog.branch}
          onClose={onClose}
          // The dialog shows the "created" toast itself.
          onCreated={onClose}
        />
      )
    case 'help':
      return <ShortcutsHelp onClose={onClose} />
  }
}
