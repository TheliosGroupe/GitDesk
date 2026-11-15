import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import type { HandlersOf } from '../../shared/api'
import type { GitExtrasApi, GitflowKind } from '../../shared/features/gitextras'
import { exclusive } from '../queue'
import { requireRepo } from '../store'
import { actions, track, type UndoableAction } from '../undo'
import * as core from './core'

function parentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

/** A queued write that Undo can take back (same as ipc.ts's undoable). */
function undoable<T>(
  path: unknown,
  action: UndoableAction,
  fn: (r: string) => Promise<T>
): Promise<T> {
  const r = requireRepo(path)
  return exclusive(r, () => track(r, action, () => fn(r)))
}

function write<T>(path: unknown, fn: (r: string) => Promise<T>): Promise<T> {
  const r = requireRepo(path)
  return exclusive(r, () => fn(r))
}

function downloadsDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return app.getPath('home')
  }
}

const KIND_LABEL: Record<GitflowKind, string> = {
  feature: 'feature',
  bugfix: 'bugfix',
  release: 'release',
  hotfix: 'hotfix'
}

/** IPC handlers for compare, line history, Gitflow, conflict prevention and patches. */
export const gitExtrasHandlers: HandlersOf<GitExtrasApi> = {
  compare: (path, from, to, threeDot) =>
    core.compare(requireRepo(path), from, to, threeDot !== false),
  lineHistory: (path, file, start, end, limit) =>
    core.lineHistory(requireRepo(path), file, start, end, limit),

  gitflowConfig: (path) => core.gitflowConfig(requireRepo(path)),
  gitflowDefaults: (path) => core.gitflowDefaults(requireRepo(path)),
  gitflowInit: (path, config) =>
    undoable(path, actions.refs('Undo Gitflow initialization'), (r) => core.gitflowInit(r, config)),
  gitflowStart: (path, kind, name, base) =>
    undoable(
      path,
      actions.refs(`Undo start ${KIND_LABEL[kind] ?? 'branch'} ${String(name)}`),
      (r) => core.gitflowStart(r, kind, name, base ?? null)
    ),
  gitflowFinish: (path, kind, name, opts) =>
    // Planned and switched to the final branch first; the merges, tag and deletion are
    // then tracked as one action that moves that branch back (other refs are restored).
    write(path, (r) =>
      core.gitflowFinish(r, kind, name, opts ?? { deleteBranch: false }, (fn) =>
        track(r, actions.history(`Undo finish ${KIND_LABEL[kind] ?? ''} ${String(name)}`), fn)
      )
    ),

  conflictWarnings: (path) => core.conflictWarnings(requireRepo(path)),

  exportPatch: async (path, target) => {
    const r = requireRepo(path)
    const name = await core.patchFileName(r, target)
    const win = parentWindow()
    const options = {
      title:
        target.kind === 'commit' ? 'Save the commit as a patch' : 'Save the changes as a patch',
      defaultPath: join(downloadsDir(), name),
      filters: [
        { name: 'Patch', extensions: ['patch', 'diff'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await core.writePatch(r, target, result.filePath)
    return result.filePath
  },
  applyPatchFile: async (path) => {
    const r = requireRepo(path)
    const win = parentWindow()
    const options = {
      title: 'Apply a patch',
      properties: ['openFile' as const],
      filters: [
        { name: 'Patches', extensions: ['patch', 'diff', 'mbox', 'eml', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const file = result.canceled ? null : result.filePaths[0]
    if (!file) return { applied: false, message: '', cancelled: true }
    // `git am` makes commits (undoable, like a cherry-pick); `git apply` only changes files.
    return exclusive(r, async () => {
      const head = await core.patchKind(file)
      if (head === 'mbox')
        return track(r, actions.history('Undo apply patch'), () => core.applyPatchFile(r, file))
      return core.applyPatchFile(r, file)
    })
  }
}
