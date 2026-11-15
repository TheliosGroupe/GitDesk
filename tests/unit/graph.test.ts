import { describe, expect, it } from 'vitest'
import { layoutGraph, type Segment } from '../../src/renderer/src/lib/graph'

type C = { sha: string; parents: string[] }
const c = (sha: string, ...parents: string[]): C => ({ sha, parents })

const seg = (x1: number, y1: 0 | 1 | 2, x2: number, y2: 0 | 1 | 2, color: number): Segment => ({
  x1,
  y1,
  x2,
  y2,
  color
})

describe('layoutGraph', () => {
  it('handles an empty history', () => {
    expect(layoutGraph([])).toEqual({ rows: [], lanes: 1 })
  })

  it('keeps a linear history in one lane', () => {
    const { rows, lanes } = layoutGraph([c('C', 'B'), c('B', 'A'), c('A')])
    expect(lanes).toBe(1)
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0])
    expect(rows.map((r) => r.color)).toEqual([0, 0, 0])
    // Tip: no line above the dot, one line down to its parent.
    expect(rows[0].segments).toEqual([seg(0, 1, 0, 2, 0)])
    expect(rows[1].segments).toEqual([seg(0, 0, 0, 1, 0), seg(0, 1, 0, 2, 0)])
    // Root: the line ends at the dot.
    expect(rows[2].segments).toEqual([seg(0, 0, 0, 1, 0)])
  })

  it('opens a lane for a merged branch and closes it at the fork point', () => {
    // M merges F into the main line; both come from A.
    const { rows, lanes } = layoutGraph([c('M', 'A', 'F'), c('F', 'A'), c('A')])
    expect(lanes).toBe(2)
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0])
    expect(rows.map((r) => r.color)).toEqual([0, 1, 0])

    // Merge commit: branches out to lane 1 (new color) and continues down lane 0.
    expect(rows[0].segments).toEqual([seg(0, 1, 1, 2, 1), seg(0, 1, 0, 2, 0)])
    // Branch commit: lane 0 passes through, lane 1 enters and leaves the dot.
    expect(rows[1].segments).toEqual([
      seg(0, 0, 0, 1, 0),
      seg(1, 0, 1, 1, 1),
      seg(0, 1, 0, 2, 0),
      seg(1, 1, 1, 2, 1)
    ])
    // Fork point: both lanes join the dot in lane 0, nothing continues.
    expect(rows[2].segments).toEqual([seg(0, 0, 0, 1, 0), seg(1, 0, 0, 1, 1)])
  })

  it('gives a second branch tip its own lane and color', () => {
    const { rows, lanes } = layoutGraph([c('X', 'A'), c('Y', 'A'), c('A')])
    expect(lanes).toBe(2)
    expect(rows[1]).toEqual({
      col: 1,
      color: 1,
      // No line enters Y from above: it is a tip.
      segments: [seg(0, 0, 0, 1, 0), seg(0, 1, 0, 2, 0), seg(1, 1, 1, 2, 1)]
    })
    expect(rows[2].col).toBe(0)
    expect(rows[2].segments).toEqual([seg(0, 0, 0, 1, 0), seg(1, 0, 0, 1, 1)])
  })

  it('lays out unrelated histories (several roots) side by side', () => {
    const { rows, lanes } = layoutGraph([c('A1', 'A0'), c('B1', 'B0'), c('A0'), c('B0')])
    expect(lanes).toBe(2)
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0, 1])
    expect(rows.map((r) => r.color)).toEqual([0, 1, 0, 1])
    // A0 is a root: its lane stops, lane 1 keeps going.
    expect(rows[2].segments).toEqual([seg(0, 0, 0, 1, 0), seg(1, 0, 1, 1, 1), seg(1, 1, 1, 2, 1)])
    expect(rows[3].segments).toEqual([seg(1, 0, 1, 1, 1)])
  })

  it('reuses the leftmost free lane for a new tip, with a fresh color', () => {
    const { rows } = layoutGraph([c('A1', 'A0'), c('B1', 'B0'), c('A0'), c('D', 'B0'), c('B0')])
    expect(rows[3].col).toBe(0)
    expect(rows[3].color).toBe(2)
    expect(rows[3].segments).toEqual([seg(1, 0, 1, 1, 1), seg(0, 1, 0, 2, 2), seg(1, 1, 1, 2, 1)])
    // B0 is awaited by lanes 0 and 1: it takes the leftmost and lane 1 merges in.
    expect(rows[4].col).toBe(0)
    expect(rows[4].segments).toEqual([seg(0, 0, 0, 1, 2), seg(1, 0, 0, 1, 1)])
  })

  it('starts a new color once every lane has closed', () => {
    const { rows } = layoutGraph([c('A'), c('B')])
    expect(rows.map((r) => [r.col, r.color])).toEqual([
      [0, 0],
      [0, 1]
    ])
    expect(rows[0].segments).toEqual([])
    expect(rows[1].segments).toEqual([])
  })

  it('opens one lane per extra parent of an octopus merge', () => {
    const { rows, lanes } = layoutGraph([c('O', 'A', 'B', 'C'), c('A'), c('B'), c('C')])
    expect(lanes).toBe(3)
    expect(rows[0].segments).toEqual([seg(0, 1, 1, 2, 1), seg(0, 1, 2, 2, 2), seg(0, 1, 0, 2, 0)])
    expect(rows.map((r) => [r.col, r.color])).toEqual([
      [0, 0],
      [0, 0],
      [1, 1],
      [2, 2]
    ])
    expect(rows[1].segments).toEqual([
      seg(0, 0, 0, 1, 0),
      seg(1, 0, 1, 1, 1),
      seg(2, 0, 2, 1, 2),
      seg(1, 1, 1, 2, 1),
      seg(2, 1, 2, 2, 2)
    ])
    expect(rows[3].segments).toEqual([seg(2, 0, 2, 1, 2)])
  })

  it('merges into a lane that already waits for the parent instead of opening one', () => {
    // T2 merges P, which lane 0 (T1) already waits for.
    const { rows, lanes } = layoutGraph([c('T1', 'P'), c('T2', 'Q', 'P'), c('P'), c('Q')])
    expect(lanes).toBe(2)
    expect(rows[1].col).toBe(1)
    expect(rows[1].segments).toEqual([
      seg(0, 0, 0, 1, 0),
      seg(1, 1, 0, 2, 0),
      seg(0, 1, 0, 2, 0),
      seg(1, 1, 1, 2, 1)
    ])
    expect(rows[2].col).toBe(0)
    expect(rows[3].col).toBe(1)
  })

  it('keeps a lane open for a parent outside the loaded history', () => {
    const { rows } = layoutGraph([c('B', 'A')])
    expect(rows[0].segments).toEqual([seg(0, 1, 0, 2, 0)])
  })

  it('every segment stays within the reported lane count', () => {
    const history = [
      c('M2', 'M1', 'H'),
      c('H', 'G'),
      c('M1', 'A', 'F'),
      c('G', 'A'),
      c('F', 'A'),
      c('A')
    ]
    const { rows, lanes } = layoutGraph(history)
    for (const row of rows) {
      expect(row.col).toBeLessThan(lanes)
      for (const s of row.segments) {
        expect(Math.max(s.x1, s.x2)).toBeLessThan(lanes)
        expect(s.y1).toBeLessThan(s.y2)
      }
    }
  })
})
