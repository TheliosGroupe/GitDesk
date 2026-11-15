// Pure helpers for the interactive rebase dialog (no React, no window.api: unit-tested).
import type { RebaseStep } from '../../../shared/types'

export type RebaseAction = RebaseStep['action']

export const REBASE_ACTIONS: RebaseAction[] = ['pick', 'reword', 'squash', 'fixup', 'drop']

/** Single-key shortcuts on a focused row, named after the commands of git's todo list. */
export const ACTION_KEYS: Record<string, RebaseAction> = {
  p: 'pick',
  r: 'reword',
  s: 'squash',
  f: 'fixup',
  d: 'drop'
}

export interface PlanRow {
  sha: string
  subject: string
  action: RebaseAction
  /**
   * Message typed by the user for reword / squash. Undefined = use the default
   * (the commit's message for reword, the combined message for squash).
   */
  message?: string
}

/** Full message (subject + body) of a commit; falls back to whatever the caller knows. */
export type MessageOf = (sha: string) => string

export function setAction(rows: PlanRow[], index: number, action: RebaseAction): PlanRow[] {
  return rows.map((r, i) => (i === index ? { ...r, action } : r))
}

export function setMessage(rows: PlanRow[], index: number, message: string): PlanRow[] {
  return rows.map((r, i) => (i === index ? { ...r, message } : r))
}

/** Moves the row at `from` so it ends up at index `to` (clamped). */
export function moveRow(rows: PlanRow[], from: number, to: number): PlanRow[] {
  if (from < 0 || from >= rows.length) return rows
  const target = Math.max(0, Math.min(rows.length - 1, to))
  if (target === from) return rows
  const next = rows.slice()
  const [row] = next.splice(from, 1)
  next.splice(target, 0, row)
  return next
}

/**
 * Message of the commit that a squash at `index` melds into: the nearest earlier
 * row that is kept (fixups add nothing and are skipped, like drops). Null when
 * there is none (the squash would be invalid).
 */
export function previousMessage(
  rows: PlanRow[],
  index: number,
  messageOf: MessageOf
): string | null {
  for (let j = index - 1; j >= 0; j--) {
    const row = rows[j]
    if (row.action === 'drop' || row.action === 'fixup') continue
    if (row.action === 'pick') return messageOf(row.sha)
    return effectiveMessage(rows, j, messageOf) ?? messageOf(row.sha)
  }
  return null
}

export function combineMessages(first: string, second: string): string {
  const a = first.trim()
  const b = second.trim()
  if (!a) return b
  if (!b) return a
  return `${a}\n\n${b}`
}

/** Message sent for a row: the edited one, or the default; undefined for other actions. */
export function effectiveMessage(
  rows: PlanRow[],
  index: number,
  messageOf: MessageOf
): string | undefined {
  const row = rows[index]
  if (!row) return undefined
  if (row.action === 'reword') return row.message ?? messageOf(row.sha)
  if (row.action === 'squash') {
    if (row.message !== undefined) return row.message
    const prev = previousMessage(rows, index, messageOf)
    return prev === null ? messageOf(row.sha) : combineMessages(prev, messageOf(row.sha))
  }
  return undefined
}

export function toSteps(rows: PlanRow[], messageOf: MessageOf): RebaseStep[] {
  return rows.map((row, i) => {
    const message = effectiveMessage(rows, i, messageOf)
    return message === undefined
      ? { action: row.action, sha: row.sha }
      : { action: row.action, sha: row.sha, message: message.trim() }
  })
}

export interface PlanValidation {
  /** Blocking problems, one per message. */
  errors: string[]
  /** Every commit is dropped: allowed only after an explicit confirmation. */
  allDropped: boolean
  /** Same actions and order as the original list (rebasing still replays onto the base). */
  unchanged: boolean
}

export function validatePlan(
  rows: PlanRow[],
  messageOf: MessageOf,
  originalOrder: string[] = []
): PlanValidation {
  const errors: string[] = []
  const firstKept = rows.findIndex((r) => r.action !== 'drop')
  const allDropped = rows.length > 0 && firstKept === -1
  if (firstKept !== -1) {
    const action = rows[firstKept].action
    if (action === 'squash' || action === 'fixup') {
      errors.push(
        firstKept === 0
          ? `The first commit can't be ${action === 'squash' ? 'squashed' : 'fixed up'}: there is no earlier commit to meld it into.`
          : `The first kept commit can't be ${action === 'squash' ? 'squashed' : 'fixed up'}: every commit before it is dropped.`
      )
    }
  }
  rows.forEach((row, i) => {
    if (row.action !== 'reword' && row.action !== 'squash') return
    if (!(effectiveMessage(rows, i, messageOf) ?? '').trim()) {
      errors.push(
        `${row.action === 'reword' ? 'Reworded' : 'Squashed'} commit ${row.sha.slice(0, 7)} needs a message.`
      )
    }
  })
  const unchanged =
    rows.length === originalOrder.length &&
    rows.every(
      (r, i) => r.action === 'pick' && r.message === undefined && r.sha === originalOrder[i]
    )
  return { errors, allDropped, unchanged }
}

const SUMMARY_WORDS: Record<RebaseAction, string> = {
  pick: 'picked',
  reword: 'reworded',
  squash: 'squashed',
  fixup: 'fixed up',
  drop: 'dropped'
}

/** e.g. "3 picked, 1 squashed, 1 dropped" (actions in their usual order, zeros left out). */
export function planSummary(rows: PlanRow[]): string {
  const counts = new Map<RebaseAction, number>()
  for (const r of rows) counts.set(r.action, (counts.get(r.action) ?? 0) + 1)
  const parts = REBASE_ACTIONS.filter((a) => counts.get(a)).map(
    (a) => `${counts.get(a)} ${SUMMARY_WORDS[a]}`
  )
  return parts.join(', ')
}

/** Number of commits the rebase produces. */
export function resultingCommitCount(rows: PlanRow[]): number {
  return rows.filter((r) => r.action === 'pick' || r.action === 'reword').length
}
