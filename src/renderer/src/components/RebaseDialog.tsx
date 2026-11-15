import { ArrowDown, ArrowUp, GripVertical, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Commit } from '../../../shared/types'
import { errorMessage, relativeTime, shortSha } from '../lib/format'
import {
  ACTION_KEYS,
  REBASE_ACTIONS,
  effectiveMessage,
  moveRow,
  planSummary,
  previousMessage,
  resultingCommitCount,
  setAction,
  setMessage,
  toSteps,
  validatePlan,
  type PlanRow,
  type RebaseAction
} from '../lib/rebase'
import { Modal } from './ui'
import { useToasts } from './ui-context'
import '../assets/features.css'
import { isolateText } from '../lib/highlight'

interface Props {
  repo: string
  base: string
  baseLabel: string
  onClose(): void
  onDone(): void
}

const ACTION_TITLES: Record<RebaseAction, string> = {
  pick: 'Pick: keep the commit (P)',
  reword: 'Reword: keep it with a new message (R)',
  squash: 'Squash: meld into the previous commit, combining messages (S)',
  fixup: "Fixup: meld into the previous commit, discarding this commit's message (F)",
  drop: 'Drop: remove the commit (D)'
}

type Loaded = { key: string; commits: Commit[] | null; error: string | null }

export function RebaseDialog({ repo, base, baseLabel, onClose, onDone }: Props): React.JSX.Element {
  const toasts = useToasts()
  const key = `${repo}\0${base}`
  const [loaded, setLoaded] = useState<Loaded>()
  const [rows, setRows] = useState<PlanRow[]>([])
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [confirmDropAll, setConfirmDropAll] = useState(false)
  const [running, setRunning] = useState(false)
  const [drag, setDrag] = useState<{ from: number; before: number | null } | null>(null)
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const focusAfterRender = useRef<string | null>(null)
  const requested = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    window.api.rebaseCommits(repo, base).then(
      (commits) => {
        if (cancelled) return
        setLoaded({ key, commits, error: null })
        setRows(commits.map((c) => ({ sha: c.sha, subject: c.subject, action: 'pick' })))
      },
      (e) => !cancelled && setLoaded({ key, commits: null, error: errorMessage(e) })
    )
    return () => {
      cancelled = true
    }
  }, [repo, base, key])

  const current = loaded?.key === key ? loaded : undefined
  const commits = current?.commits ?? null
  const byShas = useMemo(() => new Map((commits ?? []).map((c) => [c.sha, c])), [commits])
  const originalOrder = useMemo(() => (commits ?? []).map((c) => c.sha), [commits])

  const messageOf = useCallback(
    (sha: string): string => messages[sha] ?? byShas.get(sha)?.subject ?? '',
    [messages, byShas]
  )

  // Full messages (subject + body) are needed for reword / squash rows and every row before a squash.
  useEffect(() => {
    let last = -1
    rows.forEach((r, i) => {
      if (r.action === 'reword' || r.action === 'squash') last = i
    })
    const wanted = rows.slice(0, last + 1).map((r) => r.sha)
    for (const sha of wanted) {
      if (requested.current.has(sha)) continue
      requested.current.add(sha)
      window.api.commitDetails(repo, sha).then(
        (d) => {
          const full = d.body.trim() ? `${d.subject}\n\n${d.body.trim()}` : d.subject
          setMessages((m) => ({ ...m, [sha]: full }))
        },
        () => {
          /* the subject is a fine fallback */
        }
      )
    }
  }, [rows, repo])

  useEffect(() => {
    const sha = focusAfterRender.current
    if (!sha) return
    focusAfterRender.current = null
    rowRefs.current.get(sha)?.focus()
  })

  const validation = useMemo(
    () => validatePlan(rows, messageOf, originalOrder),
    [rows, messageOf, originalOrder]
  )

  const move = (from: number, to: number): void => {
    const sha = rows[from]?.sha
    if (sha) focusAfterRender.current = sha
    setRows((r) => moveRow(r, from, to))
  }

  const changeAction = (index: number, action: RebaseAction): void => {
    setRows((r) => setAction(r, index, action))
    if (action !== 'drop') setConfirmDropAll(false)
  }

  const onRowKey = (e: React.KeyboardEvent<HTMLLIElement>, index: number): void => {
    if (e.target !== e.currentTarget) return
    const lower = e.key.toLowerCase()
    if (!e.ctrlKey && !e.metaKey && !e.altKey && ACTION_KEYS[lower]) {
      e.preventDefault()
      changeAction(index, ACTION_KEYS[lower])
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const to = index + (e.key === 'ArrowUp' ? -1 : 1)
      if (e.altKey) move(index, to)
      else if (rows[to]) rowRefs.current.get(rows[to].sha)?.focus()
    }
  }

  const onDragOver = (e: React.DragEvent<HTMLLIElement>, index: number): void => {
    if (!drag) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2 ? index : index + 1
    if (before !== drag.before) setDrag({ ...drag, before })
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    if (drag && drag.before !== null) {
      const to = drag.before > drag.from ? drag.before - 1 : drag.before
      move(drag.from, to)
    }
    setDrag(null)
  }

  const start = async (): Promise<void> => {
    setRunning(true)
    try {
      await window.api.rebaseInteractive(repo, base, toSteps(rows, messageOf))
      toasts.info(`Rebased onto ${isolateText(baseLabel)}`)
    } catch (e) {
      // Conflicts leave the rebase in progress; the message says what to do next.
      toasts.error(errorMessage(e))
    } finally {
      setRunning(false)
      onDone()
    }
  }

  const close = useCallback(() => {
    if (!running) onClose()
  }, [running, onClose])

  const canStart =
    !running &&
    rows.length > 0 &&
    validation.errors.length === 0 &&
    (!validation.allDropped || confirmDropAll)

  return (
    <Modal title={`Interactive rebase onto ${isolateText(baseLabel)}`} onClose={close} wide>
      <div className="rebase">
        {current?.error && <div className="empty-state error">{current.error}</div>}
        {!current && <div className="empty-state">Loading commits…</div>}
        {commits && commits.length === 0 && (
          <div className="empty-state">
            Nothing to rebase: the current branch has no commits that are not on {baseLabel}.
          </div>
        )}
        {commits && commits.length > 0 && (
          <>
            <div className="rebase-help muted">
              Oldest commit first, like git&apos;s todo list. Drag <GripVertical size={12} /> or
              press Alt+↑/↓ to reorder; on a focused row press <kbd>P</kbd> pick, <kbd>R</kbd>{' '}
              reword, <kbd>S</kbd> squash, <kbd>F</kbd> fixup, <kbd>D</kbd> drop.
            </div>
            <ol className="rebase-list" onDragLeave={(e) => e.preventDefault()}>
              {rows.map((row, i) => {
                const commit = byShas.get(row.sha)
                const message = effectiveMessage(rows, i, messageOf)
                const into =
                  row.action === 'squash' || row.action === 'fixup'
                    ? previousMessage(rows, i, (sha) => byShas.get(sha)?.subject ?? '')
                    : null
                const dropClass =
                  drag && drag.before === i
                    ? ' drop-before'
                    : drag && drag.before === i + 1 && i === rows.length - 1
                      ? ' drop-after'
                      : ''
                return (
                  <li
                    key={row.sha}
                    ref={(el) => {
                      if (el) rowRefs.current.set(row.sha, el)
                      else rowRefs.current.delete(row.sha)
                    }}
                    className={`rebase-row action-${row.action}${drag?.from === i ? ' dragging' : ''}${dropClass}`}
                    tabIndex={0}
                    aria-label={`${row.action} ${shortSha(row.sha)} ${row.subject}`}
                    onKeyDown={(e) => onRowKey(e, i)}
                    onDragOver={(e) => onDragOver(e, i)}
                    onDrop={onDrop}
                  >
                    <div className="rebase-line">
                      <span
                        className="rebase-handle"
                        draggable={!running}
                        title="Drag to reorder"
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move'
                          e.dataTransfer.setData('text/plain', row.sha)
                          const li = rowRefs.current.get(row.sha)
                          if (li) e.dataTransfer.setDragImage(li, 12, 14)
                          setDrag({ from: i, before: null })
                        }}
                        onDragEnd={() => setDrag(null)}
                      >
                        <GripVertical size={14} />
                      </span>
                      <select
                        className="rebase-action"
                        value={row.action}
                        disabled={running}
                        title={ACTION_TITLES[row.action]}
                        aria-label="Action"
                        onChange={(e) => changeAction(i, e.target.value as RebaseAction)}
                      >
                        {REBASE_ACTIONS.map((a) => (
                          <option key={a} value={a} title={ACTION_TITLES[a]}>
                            {a}
                          </option>
                        ))}
                      </select>
                      <span className="rebase-sha mono">{shortSha(row.sha)}</span>
                      <span className="rebase-subject" title={row.subject}>
                        {row.subject}
                      </span>
                      {commit && (
                        <span className="rebase-meta muted" title={commit.author}>
                          {commit.author} · {relativeTime(commit.date)}
                        </span>
                      )}
                      <span className="rebase-move">
                        <button
                          className="icon-btn"
                          title="Move up (Alt+↑)"
                          aria-label="Move up"
                          disabled={running || i === 0}
                          onClick={() => move(i, i - 1)}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          className="icon-btn"
                          title="Move down (Alt+↓)"
                          aria-label="Move down"
                          disabled={running || i === rows.length - 1}
                          onClick={() => move(i, i + 1)}
                        >
                          <ArrowDown size={14} />
                        </button>
                      </span>
                    </div>
                    {into !== null && row.action === 'fixup' && (
                      <div className="rebase-note muted">
                        Melds into “{into}”; this commit&apos;s message is discarded.
                      </div>
                    )}
                    {message !== undefined && (
                      <div className="rebase-editor">
                        <label className="modal-label">
                          {row.action === 'reword'
                            ? 'New message'
                            : into !== null
                              ? `Combined message (melds into “${into}”)`
                              : 'Combined message'}
                        </label>
                        <textarea
                          className="input mono"
                          rows={Math.min(8, Math.max(2, message.split('\n').length + 1))}
                          value={message}
                          disabled={running}
                          spellCheck={false}
                          onChange={(e) => setRows((r) => setMessage(r, i, e.target.value))}
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>

            {validation.errors.map((err) => (
              <div key={err} className="rebase-error">
                <TriangleAlert size={14} /> {err}
              </div>
            ))}
            {validation.allDropped && (
              <label className="rebase-warning checkbox">
                <input
                  type="checkbox"
                  checked={confirmDropAll}
                  onChange={(e) => setConfirmDropAll(e.target.checked)}
                />
                Every commit is dropped: the branch will point at {baseLabel}. I really want this.
              </label>
            )}
          </>
        )}

        <div className="modal-actions rebase-actions">
          {rows.length > 0 && (
            <span className="rebase-summary muted">
              {planSummary(rows)} → {resultingCommitCount(rows)} commit
              {resultingCommitCount(rows) === 1 ? '' : 's'}
              {validation.unchanged && ' (no changes to the plan)'}
            </span>
          )}
          <span className="spacer" />
          <button className="btn" onClick={close} disabled={running}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canStart} onClick={start}>
            {running ? 'Rebasing…' : 'Start rebase'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
