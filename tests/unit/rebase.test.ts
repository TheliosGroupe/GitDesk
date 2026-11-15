import { describe, expect, it } from 'vitest'
import {
  effectiveMessage,
  moveRow,
  planSummary,
  resultingCommitCount,
  setAction,
  setMessage,
  toSteps,
  validatePlan,
  type PlanRow
} from '../../src/renderer/src/lib/rebase'

const MESSAGES: Record<string, string> = {
  a1: 'Add parser\n\nHandles the basics.',
  b2: 'Fix parser bug',
  c3: 'Tidy up',
  d4: 'Add tests'
}
const messageOf = (sha: string): string => MESSAGES[sha] ?? sha

function plan(...actions: PlanRow['action'][]): PlanRow[] {
  const shas = ['a1', 'b2', 'c3', 'd4']
  return actions.map((action, i) => ({
    sha: shas[i],
    subject: MESSAGES[shas[i]].split('\n')[0],
    action
  }))
}

describe('moveRow', () => {
  const rows = plan('pick', 'pick', 'pick', 'pick')
  it('moves down and up', () => {
    expect(moveRow(rows, 0, 2).map((r) => r.sha)).toEqual(['b2', 'c3', 'a1', 'd4'])
    expect(moveRow(rows, 3, 0).map((r) => r.sha)).toEqual(['d4', 'a1', 'b2', 'c3'])
  })
  it('clamps and ignores no-ops', () => {
    expect(moveRow(rows, 1, 99).map((r) => r.sha)).toEqual(['a1', 'c3', 'd4', 'b2'])
    expect(moveRow(rows, 0, -1)).toBe(rows)
    expect(moveRow(rows, 7, 0)).toBe(rows)
  })
  it('does not mutate the input', () => {
    moveRow(rows, 0, 3)
    expect(rows.map((r) => r.sha)).toEqual(['a1', 'b2', 'c3', 'd4'])
  })
})

describe('messages', () => {
  it('reword defaults to the full message and keeps edits', () => {
    const rows = plan('reword', 'pick')
    expect(effectiveMessage(rows, 0, messageOf)).toBe(MESSAGES.a1)
    expect(effectiveMessage(setMessage(rows, 0, 'New'), 0, messageOf)).toBe('New')
    expect(effectiveMessage(rows, 1, messageOf)).toBeUndefined()
  })

  it('squash combines the previous kept commit and this one', () => {
    const rows = plan('pick', 'squash')
    expect(effectiveMessage(rows, 1, messageOf)).toBe(`${MESSAGES.a1}\n\nFix parser bug`)
  })

  it('squash skips drops and fixups, and chains through earlier squashes and rewords', () => {
    expect(effectiveMessage(plan('pick', 'drop', 'squash'), 2, messageOf)).toBe(
      `${MESSAGES.a1}\n\nTidy up`
    )
    expect(effectiveMessage(plan('pick', 'fixup', 'squash'), 2, messageOf)).toBe(
      `${MESSAGES.a1}\n\nTidy up`
    )
    expect(effectiveMessage(plan('pick', 'squash', 'squash'), 2, messageOf)).toBe(
      `${MESSAGES.a1}\n\nFix parser bug\n\nTidy up`
    )
    const reworded = setMessage(plan('reword', 'squash'), 0, 'Parser')
    expect(effectiveMessage(reworded, 1, messageOf)).toBe('Parser\n\nFix parser bug')
  })

  it('toSteps keeps display order and only sends messages for reword / squash', () => {
    const rows = setMessage(plan('pick', 'squash', 'fixup', 'reword'), 3, '  Tests  ')
    expect(toSteps(rows, messageOf)).toEqual([
      { action: 'pick', sha: 'a1' },
      { action: 'squash', sha: 'b2', message: `${MESSAGES.a1}\n\nFix parser bug` },
      { action: 'fixup', sha: 'c3' },
      { action: 'reword', sha: 'd4', message: 'Tests' }
    ])
  })
})

describe('validatePlan', () => {
  const order = ['a1', 'b2', 'c3']

  it('accepts a normal plan and flags an untouched one', () => {
    const v = validatePlan(plan('pick', 'pick', 'pick'), messageOf, order)
    expect(v.errors).toEqual([])
    expect(v.allDropped).toBe(false)
    expect(v.unchanged).toBe(true)
    expect(validatePlan(plan('pick', 'drop', 'pick'), messageOf, order).unchanged).toBe(false)
    expect(
      validatePlan(moveRow(plan('pick', 'pick', 'pick'), 0, 1), messageOf, order).unchanged
    ).toBe(false)
  })

  it('rejects squash or fixup on the first row', () => {
    expect(validatePlan(plan('squash', 'pick'), messageOf).errors).toHaveLength(1)
    expect(validatePlan(plan('fixup', 'pick'), messageOf).errors).toHaveLength(1)
  })

  it('rejects squash on the first kept row after drops', () => {
    const v = validatePlan(plan('drop', 'fixup', 'pick'), messageOf)
    expect(v.errors[0]).toMatch(/first kept commit/)
  })

  it('reports when everything is dropped', () => {
    const v = validatePlan(plan('drop', 'drop'), messageOf)
    expect(v.allDropped).toBe(true)
    expect(v.errors).toEqual([])
    expect(validatePlan([], messageOf).allDropped).toBe(false)
  })

  it('requires a message for reword and squash', () => {
    const rows = setMessage(setAction(plan('pick', 'reword'), 1, 'reword'), 1, '   ')
    expect(validatePlan(rows, messageOf).errors[0]).toMatch(/needs a message/)
    const squash = setMessage(plan('pick', 'squash'), 1, '')
    expect(validatePlan(squash, messageOf).errors[0]).toMatch(/needs a message/)
  })
})

describe('planSummary', () => {
  it('counts actions in a fixed order, leaving zeros out', () => {
    expect(planSummary(plan('pick', 'drop', 'squash', 'pick'))).toBe(
      '2 picked, 1 squashed, 1 dropped'
    )
    expect(planSummary(plan('reword', 'fixup'))).toBe('1 reworded, 1 fixed up')
    expect(planSummary([])).toBe('')
  })

  it('counts resulting commits', () => {
    expect(resultingCommitCount(plan('pick', 'squash', 'reword', 'drop'))).toBe(2)
  })
})
