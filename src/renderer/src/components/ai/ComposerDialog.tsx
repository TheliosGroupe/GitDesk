import {
  ArrowDown,
  ArrowUp,
  GitCommitHorizontal,
  LoaderCircle,
  Merge,
  Plus,
  RefreshCw,
  Trash2
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AiChangeUnit, AiComposition } from '../../../../shared/features/ai'
import { filesOf } from '../../../../shared/features/ai-patch'
import { errorMessage } from '../../lib/format'
import { KindBadge, Modal } from '../ui'
import { useToasts } from '../ui-context'
import { useAiRequest, useAiStatus } from './useAi'
import { WithheldNote } from './WithheldNote'
import '../../assets/ai.css'

interface Group {
  key: number
  message: string
  units: string[]
}

let nextKey = 1000

function UnitRow({
  unit,
  groupIndex,
  groups,
  onMove
}: {
  unit: AiChangeUnit
  groupIndex: number
  groups: Group[]
  onMove(target: number | 'new'): void
}): React.JSX.Element {
  // The preview is rendered only once opened: hundreds of rows stay light.
  const [open, setOpen] = useState(false)
  return (
    <div className="ai-unit">
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <KindBadge kind={unit.status === 'B' || unit.status === 'T' ? 'M' : unit.status} />
          <span className="ai-unit-path" title={unit.path}>
            {unit.path}
          </span>
          <span className="ai-unit-header">{unit.header}</span>
          <span className="ai-unit-stat">
            {unit.added > 0 && <span className="add">+{unit.added}</span>}
            {unit.removed > 0 && <span className="del">−{unit.removed}</span>}
          </span>
        </summary>
        {open && unit.preview && (
          <pre className="ai-unit-preview">
            {unit.preview.split('\n').map((l, i) => (
              <div
                key={i}
                className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined}
              >
                {l || ' '}
              </div>
            ))}
          </pre>
        )}
      </details>
      <select
        className="input ai-unit-move"
        aria-label={`Commit for ${unit.path}${unit.kind === 'hunk' ? ' ' + unit.header : ''}`}
        value={groupIndex}
        onChange={(e) => onMove(e.target.value === 'new' ? 'new' : Number(e.target.value))}
      >
        {groups.map((g, i) => (
          <option key={g.key} value={i}>
            Commit {i + 1}
          </option>
        ))}
        <option value="new">New commit</option>
      </select>
    </div>
  )
}

/** Splits the uncommitted changes into commits proposed by the model, editable before committing. */
export function ComposerDialog({
  repo,
  onClose,
  onDone
}: {
  repo: string
  onClose(): void
  onDone(): void
}): React.JSX.Element {
  const toasts = useToasts()
  const status = useAiStatus()
  const [attempt, setAttempt] = useState(0)
  const request = useAiRequest(
    (id) => window.api.aiComposeCommits(repo, id),
    `${repo}
${attempt}`
  )
  const plan = request.result
  const error = request.error
  const streamed = request.streamed
  const [applying, setApplying] = useState(false)
  // The groups as edited, for one plan; a new plan starts from its proposal.
  const [edited, setEdited] = useState<{ plan: AiComposition; groups: Group[] } | null>(null)
  const proposed = useMemo(
    () =>
      plan ? plan.commits.map((c, i) => ({ key: i + 1, message: c.message, units: c.units })) : [],
    [plan]
  )
  const groups = edited && edited.plan === plan ? edited.groups : proposed
  const setGroups = (fn: (gs: Group[]) => Group[]): void => {
    if (plan) setEdited({ plan, groups: fn(groups) })
  }
  const run = (): void => setAttempt((n) => n + 1)

  const unitsById = useMemo(() => new Map((plan?.units ?? []).map((u) => [u.id, u])), [plan])

  const update = (fn: (gs: Group[]) => Group[]): void =>
    setGroups((gs) => fn(gs.map((g) => ({ ...g, units: [...g.units] }))))

  const moveUnit = (id: string, from: number, target: number | 'new'): void =>
    update((gs) => {
      gs[from].units = gs[from].units.filter((u) => u !== id)
      if (target === 'new') gs.push({ key: nextKey++, message: '', units: [id] })
      else gs[target].units.push(id)
      return gs
    })

  const moveGroup = (i: number, delta: number): void =>
    update((gs) => {
      const j = i + delta
      if (j < 0 || j >= gs.length) return gs
      ;[gs[i], gs[j]] = [gs[j], gs[i]]
      return gs
    })

  const mergeWithNext = (i: number): void =>
    update((gs) => {
      if (i + 1 >= gs.length) return gs
      const next = gs[i + 1]
      gs[i].units.push(...next.units)
      if (next.message.trim() && !gs[i].message.includes(next.message.trim()))
        gs[i].message = gs[i].message.trim()
          ? `${gs[i].message.trim()}\n\n${next.message.trim()}`
          : next.message
      gs.splice(i + 1, 1)
      return gs
    })

  const removeGroup = (i: number): void =>
    update((gs) => {
      // Its changes go to the previous commit (or the next one for the first).
      const into = i > 0 ? i - 1 : 1
      if (gs[into]) gs[into].units.push(...gs[i].units)
      gs.splice(i, 1)
      return gs
    })

  const kept = groups.filter((g) => g.units.length)
  const missingMessage = kept.some((g) => !g.message.trim())
  const tooLong = kept.some((g) => (g.message.split('\n')[0] ?? '').length > 72)

  const apply = async (): Promise<void> => {
    if (!plan) return
    setApplying(true)
    try {
      const result = await window.api.aiApplyComposition(repo, {
        ...plan,
        commits: kept.map((g) => ({
          message: g.message.trim(),
          units: g.units,
          files: filesOf(g.units, plan.units)
        }))
      })
      toasts.info(
        `${result.commits} commit${result.commits > 1 ? 's' : ''} created. Undo takes them all back.`
      )
      onDone()
    } catch (e) {
      toasts.error(errorMessage(e))
    } finally {
      setApplying(false)
    }
  }

  const busy = !plan && !error

  return (
    <Modal title="Compose commits with AI" onClose={onClose} wide>
      <div className="ai-composer">
        {busy && (
          <div className="ai-working">
            <LoaderCircle size={14} className="spin" />
            {streamed
              ? `Planning… (${streamed.length.toLocaleString()} characters received)`
              : `Sending your changes to ${status?.model || 'the model'}…`}
          </div>
        )}
        {error && <div className="empty-state error">{error}</div>}
        {plan && (
          <>
            <div className="ai-composer-intro">
              {plan.level === 'hunk'
                ? 'Changes are split by hunk. Move any of them to another commit with its menu.'
                : 'Changes are grouped by file. Move any of them to another commit with its menu.'}
              {plan.truncated && ' Some changes were too large to show the model in full.'}
            </div>
            <WithheldNote paths={plan.withheld ?? []} />
            {groups.map((g, i) => (
              <section className="ai-group" key={g.key}>
                <div className="ai-group-bar">
                  <GitCommitHorizontal size={14} />
                  <span className="ai-group-title">Commit {i + 1}</span>
                  <span className="ai-group-count">
                    {g.units.length} change{g.units.length === 1 ? '' : 's'}
                  </span>
                  <span className="spacer" />
                  <button
                    className="icon-btn"
                    title="Move up"
                    aria-label={`Move commit ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => moveGroup(i, -1)}
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Move down"
                    aria-label={`Move commit ${i + 1} down`}
                    disabled={i === groups.length - 1}
                    onClick={() => moveGroup(i, 1)}
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Merge with the next commit"
                    aria-label={`Merge commit ${i + 1} with the next one`}
                    disabled={i === groups.length - 1}
                    onClick={() => mergeWithNext(i)}
                  >
                    <Merge size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Remove (its changes join the previous commit)"
                    aria-label={`Remove commit ${i + 1}`}
                    disabled={groups.length < 2}
                    onClick={() => removeGroup(i)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <textarea
                  className="input ai-group-message"
                  rows={Math.min(6, Math.max(2, g.message.split('\n').length))}
                  value={g.message}
                  placeholder="Commit message"
                  aria-label={`Message of commit ${i + 1}`}
                  onChange={(e) => {
                    const value = e.target.value
                    setGroups((gs) =>
                      gs.map((x) => (x.key === g.key ? { ...x, message: value } : x))
                    )
                  }}
                />
                {!g.units.length && (
                  <div className="ai-group-empty">No changes: this commit will be skipped.</div>
                )}
                {g.units.map((id) => {
                  const unit = unitsById.get(id)
                  return unit ? (
                    <UnitRow
                      key={id}
                      unit={unit}
                      groupIndex={i}
                      groups={groups}
                      onMove={(target) => moveUnit(id, i, target)}
                    />
                  ) : null
                })}
              </section>
            ))}
            <button
              className="btn small"
              onClick={() => setGroups((gs) => [...gs, { key: nextKey++, message: '', units: [] }])}
            >
              <Plus size={13} /> Add a commit
            </button>
          </>
        )}
      </div>
      <div className="ai-privacy-line">
        Your uncommitted changes were sent to{' '}
        {status?.provider === 'ollama' ? status.endpoint : 'your AI provider'}. Nothing is committed
        until you press “Commit all”.
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={run} disabled={busy || applying}>
          <RefreshCw size={14} /> New plan
        </button>
        <span className="spacer" />
        {tooLong && <span className="ai-warn">A summary is longer than 72 characters.</span>}
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!plan || applying || !kept.length || missingMessage}
          title={missingMessage ? 'Every commit needs a message' : undefined}
          onClick={apply}
        >
          {applying ? <LoaderCircle size={14} className="spin" /> : null} Commit all ({kept.length})
        </button>
      </div>
    </Modal>
  )
}
