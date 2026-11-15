// Drag a branch label onto the checked-out branch to merge or rebase (HTML5 drag and drop).

import type { DragEvent } from 'react'

export const BRANCH_MIME = 'application/x-gitdesk-branch'

export interface DraggedBranch {
  kind: 'local' | 'remote'
  name: string
}

// dataTransfer can only be read on drop, so the drag in progress is also kept here for dragover.
let dragging: DraggedBranch | null = null

/** Props that make a local or remote branch label draggable. */
export function branchDragSource(branch: DraggedBranch): {
  draggable: true
  onDragStart(e: DragEvent): void
  onDragEnd(): void
} {
  return {
    draggable: true,
    onDragStart: (e) => {
      e.stopPropagation()
      dragging = branch
      e.dataTransfer.setData(BRANCH_MIME, JSON.stringify(branch))
      e.dataTransfer.setData('text/plain', branch.name)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragEnd: () => {
      dragging = null
    }
  }
}

/**
 * Props for a drop target (the checked-out branch). `onHover` drives the highlight;
 * other targets don't call preventDefault, so the browser shows a not-allowed cursor there.
 */
export function branchDropTarget(
  target: string,
  onHover: (over: boolean) => void,
  onDrop: (e: DragEvent, branch: DraggedBranch) => void
): {
  onDragOver(e: DragEvent): void
  onDragLeave(e: DragEvent): void
  onDrop(e: DragEvent): void
} {
  const accepts = (e: DragEvent): boolean =>
    !!dragging && dragging.name !== target && e.dataTransfer.types.includes(BRANCH_MIME)
  return {
    onDragOver: (e) => {
      if (!accepts(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      onHover(true)
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHover(false)
    },
    onDrop: (e) => {
      onHover(false)
      const branch = dragging
      dragging = null
      if (!branch || branch.name === target) return
      e.preventDefault()
      e.stopPropagation()
      onDrop(e, branch)
    }
  }
}
