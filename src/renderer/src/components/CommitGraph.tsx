import { Cloud, Laptop, Tag } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { textOn } from '../../../shared/branchColors'
import type { AvatarMap, Commit } from '../../../shared/types'
import { branchDragSource, branchDropTarget, type DraggedBranch } from '../lib/branchDrag'
import { relativeTime, shortSha, fullDate } from '../lib/format'
import { CodeText } from './DiffView'
import type { GraphLayout, LaneColor, Segment } from '../lib/graph'
import {
  autoHiddenColumns,
  columnWidth,
  columnsTemplate,
  minRowWidth,
  useGraphColumns,
  visibleColumns,
  type ColumnId
} from '../lib/layoutColumns'
import { hasMod, modKey } from '../lib/platform'
import { GraphHeader } from './GraphHeader'
import { Avatar } from './ui'

export const WIP_SHA = 'WIP'
const ROW_H = 28
const PAD = 6
const LANE_COLORS = 8
// Lanes are wider when commits are drawn as profile pictures.
const LANE_W = { dots: 16, avatars: 24 }
const AVATAR = 20
const AVATAR_MERGE = 16
// Busy repositories can have dozens of parallel lanes; past this they are clipped.
const MAX_VISIBLE_LANES = { dots: 10, avatars: 7 }
// Wide enough for the "Graph" header (11px uppercase + 2 × 8px padding) with a single lane.
const MIN_GRAPH_W = 64

export interface RefLabel {
  kind: 'local' | 'remote' | 'tag' | 'head'
  name: string
  /** Checked-out branch. */
  current?: boolean
  /** Local branch whose upstream points at the same commit. */
  synced?: boolean
}

interface Props {
  commits: Commit[]
  layout: GraphLayout
  refsBySha: Map<string, RefLabel[]>
  /** Color of the first branch color rule matching a branch, if any (theme-adjusted). */
  branchColor?(kind: RefLabel['kind'], name: string): string | undefined
  /** Lane colors of the theme on screen when they are custom (null = built-in palette). */
  customPalette?: string[] | null
  headSha: string | null
  selected: string | null
  wipText: string
  hasMore: boolean
  showAvatars: boolean
  avatars: AvatarMap
  onSelect(sha: string): void
  /** Ctrl/⌘+click on a commit: compare it with the selected one. */
  onCompare?(sha: string): void
  onContextMenu(e: React.MouseEvent, commit: Commit): void
  onRefContextMenu(e: React.MouseEvent, label: RefLabel, sha: string): void
  onRefDoubleClick(label: RefLabel): void
  /** Click on "+N": every label of the row. */
  onMoreRefs(e: React.MouseEvent, labels: RefLabel[], sha: string): void
  /** Double-click on a commit row (not on a label). */
  onRowDoubleClick(commit: Commit): void
  /** A branch label was dropped on the checked-out branch's label. */
  onBranchDrop(e: React.DragEvent, branch: DraggedBranch): void
  /** Commits matching the active search (other rows are dimmed), or null. */
  matches: Set<string> | null
  onLoadMore(): void
  /**
   * The shared minute clock (useNow): the graph is memoized, so this is what makes its
   * relative dates ("3 minutes ago") move on while nothing else changes.
   */
  now: number
}

const laneVar = (color: LaneColor): string =>
  typeof color === 'string' ? color : `var(--lane-${color % LANE_COLORS})`
const yOf = (y: 0 | 1 | 2): number => (y * ROW_H) / 2

function segmentPath(s: Segment, xOf: (lane: number) => number): string {
  const x1 = xOf(s.x1)
  const x2 = xOf(s.x2)
  const y1 = yOf(s.y1)
  const y2 = yOf(s.y2)
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`
  const ym = (y1 + y2) / 2
  return `M${x1} ${y1}C${x1} ${ym},${x2} ${ym},${x2} ${y2}`
}

function RefPill({
  label,
  color,
  onColor,
  onContextMenu,
  onDoubleClick,
  onBranchDrop
}: {
  label: RefLabel
  /** The branch's own color (a rule), instead of its row's lane. */
  color?: string
  /** Text on the solid label of the checked-out branch, when the color is a custom one. */
  onColor?: string
  onContextMenu: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onBranchDrop: (e: React.DragEvent, branch: DraggedBranch) => void
}): React.JSX.Element {
  const [dropping, setDropping] = useState(false)
  const branch = label.kind === 'local' || label.kind === 'remote' ? label.kind : null
  // Branches can be dragged; only the checked-out branch accepts a drop.
  const dragProps = branch ? branchDragSource({ kind: branch, name: label.name }) : {}
  const dropProps =
    branch === 'local' && label.current
      ? branchDropTarget(label.name, setDropping, onBranchDrop)
      : {}
  const icon =
    label.kind === 'tag' ? (
      <Tag size={11} />
    ) : label.kind === 'remote' ? (
      <Cloud size={11} />
    ) : (
      <Laptop size={11} />
    )
  return (
    <span
      className={`ref ref-${label.kind}${label.current ? ' current' : ''}${dropping ? ' drop-over' : ''}`}
      title={
        branch ? `${label.name} (drag onto the checked-out branch to merge or rebase)` : undefined
      }
      style={
        color || onColor
          ? ({
              ...(color ? { '--lane': color } : {}),
              ...(onColor ? { '--ref-on': onColor } : {})
            } as React.CSSProperties)
          : undefined
      }
      {...dragProps}
      {...dropProps}
      onContextMenu={(e) => {
        e.stopPropagation()
        onContextMenu(e)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onDoubleClick()
      }}
    >
      {icon}
      <bdi className="ref-name">
        <CodeText text={label.name} />
      </bdi>
      {label.synced && <Cloud size={11} className="ref-synced" aria-label="in sync with remote" />}
    </span>
  )
}

// Memoized: an unchanged refresh or a click elsewhere keeps the rows as they are.
export const CommitGraph = memo(function CommitGraph(props: Props): React.JSX.Element {
  const { commits, layout, refsBySha, headSha, selected, onSelect, showAvatars, avatars } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<HTMLDivElement>(null)
  const headerClipRef = useRef<HTMLDivElement>(null)
  const columnState = useGraphColumns()
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(800)
  // Width of the rows, in steps of 16px: some columns step aside when it gets narrow.
  const [viewWidth, setViewWidth] = useState(0)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setViewHeight(el.clientHeight)
      setViewWidth(Math.floor(el.clientWidth / 16) * 16)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const selectedIndex = useMemo(
    () => commits.findIndex((c) => c.sha === selected),
    [commits, selected]
  )

  // Keep the selected row visible (keyboard navigation, clicks in the sidebar).
  useEffect(() => {
    const el = scrollRef.current
    if (!el || selectedIndex < 0) return
    const top = selectedIndex * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight)
      el.scrollTop = top + ROW_H - el.clientHeight + 4
  }, [selectedIndex])

  const mode = showAvatars ? 'avatars' : 'dots'
  const laneW = LANE_W[mode]
  const xOf = (lane: number): number => PAD + lane * laneW + laneW / 2
  // A graph column sized by hand shows every lane that fits; by default busy graphs are clipped.
  const customGraph = columnState.widths.graph !== undefined
  const lanes = customGraph ? layout.lanes : Math.min(layout.lanes, MAX_VISIBLE_LANES[mode])
  const naturalGraph = Math.max(
    MIN_GRAPH_W,
    PAD * 2 + Math.min(layout.lanes, MAX_VISIBLE_LANES[mode]) * laneW
  )
  const svgWidth = Math.max(MIN_GRAPH_W, PAD * 2 + lanes * laneW)

  // Column widths live in CSS variables on .graph: resizing does not re-render the rows.
  const autoHidden = autoHiddenColumns(
    visibleColumns(columnState),
    columnState.widths,
    naturalGraph,
    viewWidth
  )
  const visible = visibleColumns(columnState).filter((c) => !autoHidden.includes(c.id))
  const show = new Set(visible.map((c) => c.id))
  const widths: Partial<Record<ColumnId, number | null>> = {}
  for (const c of visible) widths[c.id] = columnWidth(columnState, c.id, naturalGraph)
  const graphStyle: Record<string, string> = {
    '--graph-cols': columnsTemplate(visible, columnState.widths),
    '--graph-min-w': `${minRowWidth(visible, columnState.widths, naturalGraph)}px`
  }
  for (const [id, w] of Object.entries(widths)) if (w !== null) graphStyle[`--col-${id}`] = `${w}px`
  // Lanes cut off by a narrow graph column fade out instead of ending sharply.
  const clipped = show.has('graph') && (widths.graph ?? naturalGraph) < svgWidth

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10)
  const last = Math.min(commits.length, Math.ceil((scrollTop + viewHeight) / ROW_H) + 10)

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const next = Math.min(
      commits.length - 1,
      Math.max(0, selectedIndex + (e.key === 'ArrowDown' ? 1 : -1))
    )
    if (commits[next]) onSelect(commits[next].sha)
  }

  return (
    <div
      ref={graphRef}
      className={['graph', props.matches && 'searching', clipped && 'lanes-clipped']
        .filter(Boolean)
        .join(' ')}
      style={graphStyle as React.CSSProperties}
    >
      <GraphHeader
        columns={columnState}
        autoHidden={autoHidden}
        visible={visible}
        widths={widths}
        naturalGraph={naturalGraph}
        graphRef={graphRef}
        clipRef={headerClipRef}
        messageExtra={
          props.onCompare &&
          selected &&
          selected !== WIP_SHA && (
            <span className="graph-hint">{modKey}+click another commit to compare</span>
          )
        }
      />
      <div
        className="graph-scroll"
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          const el = e.currentTarget
          // The header follows sideways scrolling (columns wider than the view).
          if (headerClipRef.current) headerClipRef.current.scrollLeft = el.scrollLeft
          setScrollTop(el.scrollTop)
        }}
      >
        <div
          className="graph-rows"
          style={{ height: commits.length * ROW_H + (props.hasMore ? 48 : 0) }}
        >
          {commits.slice(first, last).map((commit, offset) => {
            const index = first + offset
            const row = layout.rows[index]
            if (!row) return null
            const wip = commit.sha === WIP_SHA
            const merge = commit.parents.length > 1
            const labels = refsBySha.get(commit.sha) ?? []
            const isHead = commit.sha === headSha
            const color = laneVar(row.color)
            const pillColor = labels.length
              ? props.branchColor?.(labels[0].kind, labels[0].name)
              : undefined
            const solid =
              pillColor ??
              (typeof row.color === 'string'
                ? row.color
                : props.customPalette?.[row.color % LANE_COLORS])
            const cx = xOf(row.col)
            const photo = showAvatars && !wip && row.col < lanes && show.has('graph')
            // Merge commits get a smaller picture, so they still read as merges.
            const size = merge ? AVATAR_MERGE : AVATAR
            const avatar = avatars[commit.email.toLowerCase()]
            const cls = [
              'graph-row',
              commit.sha === selected && 'selected',
              isHead && 'head',
              wip && 'wip',
              props.matches?.has(commit.sha) && 'match'
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <div
                key={commit.sha}
                className={cls}
                style={{
                  top: index * ROW_H,
                  height: ROW_H,
                  ['--lane' as string]: color
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return onSelect(commit.sha)
                  if (hasMod(e) && props.onCompare && !wip) {
                    e.preventDefault()
                    props.onCompare(commit.sha)
                  } else onSelect(commit.sha)
                }}
                onContextMenu={(e) => !wip && props.onContextMenu(e, commit)}
                onDoubleClick={() => !wip && props.onRowDoubleClick(commit)}
              >
                {show.has('refs') && (
                  <div
                    className="cell refs"
                    data-col="refs"
                    title={labels.map((l) => l.name).join(', ')}
                  >
                    {labels.length > 0 && (
                      <>
                        <RefPill
                          label={labels[0]}
                          color={pillColor}
                          onColor={solid && labels[0].current ? textOn(solid) : undefined}
                          onContextMenu={(e) => props.onRefContextMenu(e, labels[0], commit.sha)}
                          onDoubleClick={() => props.onRefDoubleClick(labels[0])}
                          onBranchDrop={props.onBranchDrop}
                        />
                        {labels.length > 1 && (
                          <button
                            className="ref-more"
                            title={labels.map((l) => l.name).join(', ')}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => props.onMoreRefs(e, labels, commit.sha)}
                          >
                            +{labels.length - 1}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
                <div
                  className="cell graph-cell"
                  data-col="graph"
                  hidden={!show.has('graph')}
                  style={{ height: ROW_H }}
                >
                  <svg width={svgWidth} height={ROW_H} aria-hidden>
                    {row.segments.map((s, k) => (
                      <path key={k} d={segmentPath(s, xOf)} stroke={laneVar(s.color)} />
                    ))}
                    {wip ? (
                      <circle cx={cx} cy={ROW_H / 2} r={6} className="node-wip" stroke={color} />
                    ) : photo ? null : merge ? (
                      <circle cx={cx} cy={ROW_H / 2} r={4} fill={color} />
                    ) : (
                      <circle
                        cx={cx}
                        cy={ROW_H / 2}
                        r={isHead ? 7 : 6}
                        fill={color}
                        className={isHead ? 'node-head' : ''}
                      />
                    )}
                  </svg>
                  {photo && (
                    <span
                      className={isHead ? 'graph-avatar head' : 'graph-avatar'}
                      style={{ left: cx - size / 2, top: (ROW_H - size) / 2 }}
                    >
                      <Avatar name={commit.author} src={avatar} size={size} />
                    </span>
                  )}
                </div>
                <div className="cell msg" data-col="msg">
                  {wip ? (
                    <span className="wip-text">{props.wipText}</span>
                  ) : (
                    <bdi>
                      <CodeText text={commit.subject} />
                    </bdi>
                  )}
                </div>
                {show.has('author') && (
                  <div className="cell author" data-col="author">
                    {!wip && showAvatars && <Avatar name={commit.author} src={avatar} size={16} />}
                    <span className="author-name">{wip ? '' : commit.author}</span>
                  </div>
                )}
                {show.has('date') && (
                  <div
                    className="cell date"
                    data-col="date"
                    title={wip ? '' : fullDate(commit.date)}
                  >
                    {wip ? '' : relativeTime(commit.date)}
                  </div>
                )}
                {show.has('sha') && (
                  <div className="cell sha" data-col="sha">
                    {wip ? '' : shortSha(commit.sha)}
                  </div>
                )}
              </div>
            )
          })}
          {props.hasMore && (
            <div className="load-more" style={{ top: commits.length * ROW_H }}>
              <button className="btn" onClick={props.onLoadMore}>
                Load more commits
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
