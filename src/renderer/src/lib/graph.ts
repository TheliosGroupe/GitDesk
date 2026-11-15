/**
 * Commit graph lane layout.
 *
 * Commits arrive newest first in an order where no parent appears before all
 * of its children (git log --date-order guarantees that). We keep an array of
 * "lanes"; each lane holds the sha of the commit it is waiting for. A commit
 * takes the leftmost lane waiting for it (or a free lane if it is a branch
 * tip), other lanes waiting for it merge into it, its first parent continues
 * in the same lane and every extra parent (merge) gets a lane of its own.
 *
 * Branch color rules: a lane opened by a commit carrying a branch that matches a rule (a
 * tip, or the parent a merge brings in) takes that rule's color instead of the next
 * palette color, and keeps it until the lane ends. A lane reaching another matching
 * branch further down switches to it when that rule comes first (or the lane had none),
 * so `develop` stays `develop` below a feature branch started from it, while `main`
 * passing over a fast-forwarded `feature/*` stays `main`.
 *
 * Each row is drawn independently as an SVG strip, so a row only needs the
 * line segments that cross it. Y positions: 0 = top edge, 1 = middle (where
 * the commit dot sits), 2 = bottom edge.
 */

import type { RuleColor } from '../../../shared/branchColors'

/** A palette index (drawn as `--lane-N`, cycling) or a rule's `#rrggbb`. */
export type LaneColor = number | string

export interface Segment {
  x1: number
  y1: 0 | 1 | 2
  x2: number
  y2: 0 | 1 | 2
  color: LaneColor
}

export interface GraphRow {
  /** Lane of this commit's dot. */
  col: number
  color: LaneColor
  segments: Segment[]
}

export interface GraphLayout {
  rows: GraphRow[]
  /** Widest number of lanes used by any row. */
  lanes: number
}

export function layoutGraph(
  commits: { sha: string; parents: string[] }[],
  /** Rule color of a commit's branches (see above); none = palette colors only. */
  ruleColors?: Map<string, RuleColor>
): GraphLayout {
  const lanes: (string | null)[] = []
  const colors: LaneColor[] = []
  /** Rank of the rule that colored each lane; Infinity for a palette color. */
  const ranks: number[] = []
  let nextColor = 0
  let maxLanes = 1
  const rows: GraphRow[] = []

  /** Colors a lane opened for `sha`: its rule color, else the next palette color. */
  const open = (lane: number, sha: string): void => {
    const rule = ruleColors?.get(sha)
    colors[lane] = rule ? rule.color : nextColor++
    ranks[lane] = rule ? rule.rank : Infinity
  }

  const freeLane = (): number => {
    const i = lanes.indexOf(null)
    if (i !== -1) return i
    lanes.push(null)
    return lanes.length - 1
  }

  for (const commit of commits) {
    const segments: Segment[] = []
    const incoming: number[] = []
    lanes.forEach((sha, j) => sha === commit.sha && incoming.push(j))

    let col: number
    if (incoming.length) {
      col = incoming[0]
    } else {
      col = freeLane()
      open(col, commit.sha)
    }

    // Top half: lanes passing through, and lanes joining this commit.
    lanes.forEach((sha, j) => {
      if (sha === null) return
      segments.push({ x1: j, y1: 0, x2: sha === commit.sha ? col : j, y2: 1, color: colors[j] })
    })
    for (const j of incoming) if (j !== col) lanes[j] = null
    // A branch further down an existing lane: its rule takes over when it comes first.
    if (incoming.length && ruleColors) {
      const rule = ruleColors.get(commit.sha)
      if (rule && rule.rank < ranks[col]) {
        colors[col] = rule.color
        ranks[col] = rule.rank
      }
    }

    // Bottom half: first parent continues straight down, merges branch out.
    const [first, ...others] = commit.parents
    lanes[col] = first ?? null
    const opened = new Set<number>()
    for (const parent of others) {
      let k = lanes.indexOf(parent)
      if (k === -1) {
        k = freeLane()
        lanes[k] = parent
        open(k, parent)
        opened.add(k)
      }
      segments.push({ x1: col, y1: 1, x2: k, y2: 2, color: colors[k] })
    }
    lanes.forEach((sha, j) => {
      if (sha === null || opened.has(j)) return
      segments.push({ x1: j, y1: 1, x2: j, y2: 2, color: colors[j] })
    })

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    maxLanes = Math.max(maxLanes, lanes.length, col + 1)
    rows.push({ col, color: colors[col], segments })
  }

  return { rows, lanes: maxLanes }
}
