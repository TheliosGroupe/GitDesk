import { describe, expect, it } from 'vitest'
import type { DiffTarget } from '../../src/shared/types'
import {
  changedBetween,
  chunkRanges,
  isImmutableTarget,
  lineNumberDigits,
  parseDiff,
  visibleRange
} from '../../src/renderer/src/lib/diff'

const file = { path: 'a.txt', kind: 'M' as const }
const SHA = 'a'.repeat(40)

describe('long diffs and lists drawn in parts', () => {
  it('cuts a list into chunks', () => {
    expect(chunkRanges(250, 100)).toEqual([
      [0, 100],
      [100, 200],
      [200, 250]
    ])
    expect(chunkRanges(100, 100)).toEqual([[0, 100]])
    expect(chunkRanges(0, 100)).toEqual([])
    // A 60,000-line hunk is 600 chunks: only those near the view are drawn.
    expect(chunkRanges(60000, 100)).toHaveLength(600)
  })

  it('gives the gutters of a hunk the width of its largest line number', () => {
    const diff = parseDiff(['@@ -998,3 +998,4 @@', ' a', '-b', '+c', '+d', ' e'].join('\n'))
    expect(lineNumberDigits(diff.hunks)).toBe(4) // new side reaches line 1001
    expect(lineNumberDigits([])).toBe(1)
  })

  it('picks the rows in view of a scroll box, plus some above and below', () => {
    // 5,000 rows of 26 px seen through a 260 px box.
    expect(visibleRange(0, 260, 5000, 26, 30)).toEqual([0, 40])
    expect(visibleRange(2600, 260, 5000, 26, 30)).toEqual([70, 140])
    // Scrolled to the end: the window stops at the last row.
    expect(visibleRange(5000 * 26 - 260, 260, 5000, 26, 30)).toEqual([4960, 5000])
    // A list starting 1000 px below the visible part: only rows within the overscan.
    expect(visibleRange(-1000, 260, 5000, 26, 30)).toEqual([0, 2])
    expect(visibleRange(-2000, 260, 5000, 26, 30)).toEqual([0, 0])
    expect(visibleRange(0, 260, 10, 26, 30)).toEqual([0, 10])
  })

  it('selects the changed lines of a Shift-click range only', () => {
    const diff = parseDiff(['@@ -1,4 +1,4 @@', ' a', '-b', '+B', ' c', '+d'].join('\n'))
    const hunk = diff.hunks[0]
    expect(changedBetween(hunk, 0, 4)).toEqual([1, 2, 4])
    expect(changedBetween(hunk, 4, 1)).toEqual([1, 2, 4])
    expect(changedBetween(hunk, 3, 3)).toEqual([])
    expect(changedBetween(undefined, 0, 3)).toEqual([])
  })

  it('reads history once, working-copy and branch comparisons on every refresh', () => {
    const t = (target: DiffTarget): boolean => isImmutableTarget(target)
    expect(t({ kind: 'commit', sha: SHA, parent: null, file })).toBe(true)
    expect(t({ kind: 'compare', from: SHA, to: 'b'.repeat(64), file, threeDot: true })).toBe(true)
    // A branch can move: its comparison is read again.
    expect(t({ kind: 'compare', from: 'main', to: SHA, file, threeDot: false })).toBe(false)
    expect(t({ kind: 'compare', from: SHA.slice(0, 12), to: SHA, file, threeDot: false })).toBe(
      false
    )
    expect(t({ kind: 'unstaged', file })).toBe(false)
    expect(t({ kind: 'staged', file })).toBe(false)
  })
})
