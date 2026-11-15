// What the center of the repository view shows: the commit graph, or one view on top of it.

import { useCallback, useState } from 'react'
import type { DiffTarget } from '../../../../shared/types'

export type CenterView =
  | { kind: 'graph' }
  | { kind: 'diff'; target: DiffTarget }
  | { kind: 'history'; path: string }
  | { kind: 'compare'; from: string; to: string }

const GRAPH: CenterView = { kind: 'graph' }

export interface CenterViewState {
  view: CenterView
  /** The file shown in the diff view (highlighted in the file lists), or null. */
  diffTarget: DiffTarget | null
  openDiff(target: DiffTarget): void
  openHistory(path: string): void
  openCompare(from: string, to: string): void
  /** Back to the commit graph. */
  close(): void
  /** Closes a commit diff that belongs to another commit than `sha`. */
  followSelection(sha: string): void
}

export function useCenterView(): CenterViewState {
  const [view, setView] = useState<CenterView>(GRAPH)
  const openDiff = useCallback((target: DiffTarget) => setView({ kind: 'diff', target }), [])
  const openHistory = useCallback((path: string) => setView({ kind: 'history', path }), [])
  const openCompare = useCallback(
    (from: string, to: string) => setView({ kind: 'compare', from, to }),
    []
  )
  const close = useCallback(() => setView(GRAPH), [])
  const followSelection = useCallback(
    (sha: string) =>
      setView((v) =>
        v.kind === 'diff' && v.target.kind === 'commit' && v.target.sha !== sha ? GRAPH : v
      ),
    []
  )
  return {
    view,
    diffTarget: view.kind === 'diff' ? view.target : null,
    openDiff,
    openHistory,
    openCompare,
    close,
    followSelection
  }
}
