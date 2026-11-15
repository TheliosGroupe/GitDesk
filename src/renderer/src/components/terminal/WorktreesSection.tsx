// Content of the sidebar's "Worktrees" section: the repository's working trees.

import { FolderGit2, Plus, Eraser } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Worktree } from '../../../../shared/features/terminal'
import type { AppState, RefsInfo } from '../../../../shared/types'
import { errorMessage } from '../../lib/format'
import { ContextMenu, Modal, type MenuState } from '../ui'
import { useDialogs, useToasts } from '../ui-context'
import { baseName, samePath } from './util'
import '../../assets/terminal.css'
import { isolateText } from '../../lib/highlight'
import { CodeText } from '../DiffView'

/** Focus within this long of the last listing does not list the worktrees again. */
const FOCUS_REFRESH_MS = 2000

export function WorktreesSection({
  repo,
  onOpenRepo,
  onChanged,
  onStateChange
}: {
  repo: string
  onOpenRepo(path: string): void
  onChanged(): void
  /** New app state after a worktree was registered or removed (closes its tab). */
  onStateChange?(state: AppState): void
}): React.JSX.Element {
  const toasts = useToasts()
  const dialogs = useDialogs()
  const [list, setList] = useState<Worktree[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [adding, setAdding] = useState(false)

  const lastRefresh = useRef(0)
  const refresh = useCallback(() => {
    lastRefresh.current = Date.now()
    window.api.worktrees(repo).then(
      (l) => {
        setList(l)
        setError(null)
      },
      (e) => setError(errorMessage(e))
    )
  }, [repo])

  // A hidden tab keeps its sidebar mounted (display: none): it lists worktrees (a status
  // per worktree) only while shown, and catches up once when shown again.
  const probe = useRef<HTMLDivElement>(null)
  const stale = useRef(true)
  const refreshIfShown = useCallback(() => {
    const shown = !!probe.current && probe.current.getClientRects().length > 0
    stale.current = !shown
    if (shown) refresh()
  }, [refresh])

  useEffect(() => {
    refreshIfShown()
    const off = window.api.onRepoChanged((r) => samePath(r, repo) && refreshIfShown())
    // A focus right after a refresh brings nothing new (the watcher reports changes).
    const onFocus = (): void => {
      if (Date.now() - lastRefresh.current > FOCUS_REFRESH_MS) refreshIfShown()
    }
    window.addEventListener('focus', onFocus)
    // Fires when the section gets a size again (its tab or panel is shown).
    const resized = new ResizeObserver(() => stale.current && refreshIfShown())
    if (probe.current) resized.observe(probe.current)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
      resized.disconnect()
    }
  }, [repo, refreshIfShown])

  const openTab = async (wt: Worktree): Promise<void> => {
    try {
      const state = await window.api.openWorktree(repo, wt.path)
      onStateChange?.(state)
      onChanged()
      onOpenRepo(state.repos.find((r) => samePath(r, wt.path)) ?? wt.path)
    } catch (e) {
      toasts.error(errorMessage(e))
    }
  }

  const remove = async (wt: Worktree): Promise<void> => {
    const dirty = (wt.changes ?? 0) > 0
    const ok = await dialogs.confirm({
      title: `Remove the worktree ${isolateText(wt.branch ?? baseName(wt.path))}?`,
      message: dirty ? (
        <>
          <b>{wt.changes} uncommitted change(s)</b> in {wt.path} will be lost. The branch itself is
          kept.
        </>
      ) : (
        `Deletes the folder ${isolateText(wt.path)}. The branch itself is kept.`
      ),
      okLabel: dirty ? 'Discard changes and remove' : 'Remove',
      danger: true
    })
    if (!ok) return
    try {
      // Not inside `onStateChange?.(…)`: an optional call skips its arguments when undefined.
      const state = await window.api.removeWorktree(repo, wt.path, dirty || wt.locked)
      onStateChange?.(state)
      toasts.info(`Removed the worktree ${isolateText(wt.path)}`)
      onChanged()
    } catch (e) {
      toasts.error(errorMessage(e))
    }
    refresh()
  }

  const prune = async (): Promise<void> => {
    try {
      await window.api.pruneWorktrees(repo)
      onChanged()
    } catch (e) {
      toasts.error(errorMessage(e))
    }
    refresh()
  }

  const showMenu = (e: React.MouseEvent, wt: Worktree): void => {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: wt.isCurrent ? 'Already open here' : 'Open in a tab',
          disabled: wt.isCurrent || wt.prunable,
          onClick: () => void openTab(wt)
        },
        {
          label: 'Show in folder',
          disabled: wt.prunable,
          onClick: () =>
            window.api
              .showWorktreeFolder(repo, wt.path)
              .catch((err) => toasts.error(errorMessage(err)))
        },
        {
          label: 'Copy path',
          onClick: () => void navigator.clipboard.writeText(wt.path).catch(() => {})
        },
        'separator',
        wt.prunable
          ? { label: 'Prune missing worktrees', onClick: () => void prune() }
          : {
              label: 'Remove worktree…',
              danger: true,
              disabled: wt.isMain || wt.isCurrent,
              hint: wt.isMain ? 'main' : wt.isCurrent ? 'open here' : undefined,
              onClick: () => void remove(wt)
            }
      ]
    })
  }

  return (
    <>
      {error && <div className="sb-empty">{error}</div>}
      {list?.map((wt) => (
        <div
          key={wt.path}
          className={['sb-item', 'wt-item', wt.isCurrent && 'current', wt.prunable && 'prunable']
            .filter(Boolean)
            .join(' ')}
          title={`${wt.path}${wt.lockReason ? `\nLocked: ${wt.lockReason}` : ''}`}
          onClick={() => !wt.isCurrent && !wt.prunable && void openTab(wt)}
          onContextMenu={(e) => showMenu(e, wt)}
        >
          <FolderGit2 size={13} />
          <span className="sb-name">
            <CodeText text={wt.branch ?? `(detached ${wt.head.slice(0, 7)})`} />{' '}
            <span className="wt-path">
              <CodeText text={baseName(wt.path)} />
            </span>
          </span>
          <span className="sb-badges">
            {!!wt.changes && (
              <span className="badge warn" title={`${wt.changes} uncommitted change(s)`}>
                {wt.changes}
              </span>
            )}
            {wt.isMain && <span className="badge muted">main</span>}
            {wt.locked && <span className="badge muted">locked</span>}
            {wt.prunable && <span className="badge bad">missing</span>}
          </span>
        </div>
      ))}
      {list && list.length <= 1 && <div className="sb-empty">No other worktrees</div>}
      <div className="wt-actions" ref={probe}>
        <button className="btn small" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add worktree…
        </button>
        {list?.some((w) => w.prunable) && (
          <button className="btn small" onClick={() => void prune()} title="git worktree prune">
            <Eraser size={13} /> Prune
          </button>
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {adding && (
        <AddWorktreeDialog
          repo={repo}
          worktrees={list ?? []}
          onClose={() => setAdding(false)}
          onAdded={(path, open) => {
            setAdding(false)
            refresh()
            onChanged()
            if (open) {
              window.api.openWorktree(repo, path).then(
                (state) => {
                  onStateChange?.(state)
                  onChanged()
                  onOpenRepo(state.repos.find((r) => samePath(r, path)) ?? path)
                },
                (e) => toasts.error(errorMessage(e))
              )
            }
          }}
        />
      )}
    </>
  )
}

function AddWorktreeDialog({
  repo,
  worktrees,
  onClose,
  onAdded
}: {
  repo: string
  worktrees: Worktree[]
  onClose(): void
  onAdded(path: string, open: boolean): void
}): React.JSX.Element {
  const toasts = useToasts()
  const [refs, setRefs] = useState<RefsInfo | null>(null)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [existing, setExisting] = useState('')
  const [folder, setFolder] = useState('')
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.api.refs(repo).then(
      (r) => {
        setRefs(r)
        setStart(r.headBranch ?? r.headSha ?? '')
      },
      (e) => toasts.error(errorMessage(e))
    )
  }, [repo, toasts])

  // A branch can be checked out in one worktree only.
  const free = useMemo(
    () =>
      (refs?.branches ?? []).filter(
        (b) => !worktrees.some((w) => w.branch === b.name) && !b.isHead
      ),
    [refs, worktrees]
  )
  const chosen = existing || free[0]?.name || ''
  const branch = mode === 'new' ? name.trim() : chosen
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!branch || busy) return
    setBusy(true)
    try {
      const { path } = await window.api.addWorktree(repo, {
        branch,
        createBranch: mode === 'new',
        startPoint: mode === 'new' ? start || null : null,
        path: folder.trim() || null
      })
      toasts.info(`Created the worktree ${isolateText(path)}`)
      onAdded(path, open)
    } catch (err) {
      toasts.error(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="Add a worktree" onClose={onClose}>
      <form className="wt-form" onSubmit={submit}>
        <div className="segmented-choice" role="radiogroup" aria-label="Branch">
          <label>
            <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> New
            branch
          </label>
          <label>
            <input
              type="radio"
              checked={mode === 'existing'}
              disabled={!free.length}
              onChange={() => setMode('existing')}
            />{' '}
            Existing branch
          </label>
        </div>
        {mode === 'new' ? (
          <>
            <div>
              <label className="modal-label" htmlFor="wt-name">
                Branch name
              </label>
              <input
                id="wt-name"
                className="input"
                autoFocus
                value={name}
                placeholder="feature/my-change"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="modal-label" htmlFor="wt-start">
                Starting from
              </label>
              <select
                id="wt-start"
                className="input"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              >
                {refs?.headBranch === null && refs.headSha && (
                  <option value={refs.headSha}>HEAD ({refs.headSha.slice(0, 7)})</option>
                )}
                {refs?.branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
                {refs?.remoteBranches.map((b) => (
                  <option key={b.fullName} value={b.fullName}>
                    {b.fullName}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : (
          <div>
            <label className="modal-label" htmlFor="wt-existing">
              Branch
            </label>
            <select
              id="wt-existing"
              className="input"
              value={chosen}
              onChange={(e) => setExisting(e.target.value)}
            >
              {free.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="modal-label" htmlFor="wt-folder">
            Folder (optional)
          </label>
          <input
            id="wt-folder"
            className="input mono"
            value={folder}
            placeholder="Default: next to the repository, or the worktree folder of Settings"
            onChange={(e) => setFolder(e.target.value)}
          />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
          Open it in a tab
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!branch || busy}>
            {busy ? 'Creating…' : 'Add worktree'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
