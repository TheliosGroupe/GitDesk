import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bot,
  ChevronDown,
  CloudDownload,
  Code,
  Ellipsis,
  FolderOpen,
  GitBranchPlus,
  GitFork,
  Keyboard,
  LoaderCircle,
  Maximize,
  Minimize,
  PanelLeft,
  PanelRight,
  RefreshCw,
  SquareTerminal,
  Undo2
} from 'lucide-react'
import { memo, type ReactNode } from 'react'
import type { EditorChoice, UndoInfo, WorkingStatus } from '../../../shared/types'
import { repoName, shortSha } from '../lib/format'
import { toggleFocus, togglePanel, type PanelLayout } from '../lib/layout'
import { editorName, openFolderLabel } from '../lib/platform'
import { keysOf, titled } from '../lib/shortcuts'
import { ConflictWarnings } from './gitextras/ConflictWarnings'
import { GitflowButton } from './gitextras/GitflowButton'

interface Props {
  repo: string
  status: WorkingStatus
  busy: string | null
  hasChanges: boolean
  hasStashes: boolean
  undo: UndoInfo | null
  editor: EditorChoice
  search: ReactNode
  onFetch(): void
  /** Stops the fetch, pull or push shown as busy. */
  onCancelNetwork(): void
  onPull(): void
  onPullMenu(e: React.MouseEvent): void
  onPush(): void
  onBranch(): void
  onStash(): void
  onPop(): void
  onUndo(): void
  onSync(): void
  onHelp(): void
  /** Bumped on every refresh (conflict warnings re-check). */
  version: number
  /** Main repository when this tab is one of its worktrees. */
  worktreeOf: string | null
  onOpenRepo(path: string): void
  /** Something changed the repository (Gitflow). */
  onChanged(): void
  terminalOpen: boolean
  onToggleTerminal(): void
  onStartAgent(): void
  /** The "…" menu (patches, agents, AI). */
  onMoreMenu(e: React.MouseEvent): void
  /** Collapsed panels and focus mode (the layout buttons). */
  layout: PanelLayout
}

/** Busy labels of commands that talk to a remote, which Cancel can stop. */
const NETWORK_BUSY = /^(Syncing|Fetching|Pulling|Pushing|Force pushing)\b/

/** Memoized: RepoView passes stable handlers, so a refresh that changed nothing skips it. */
export const RepoToolbar = memo(function RepoToolbar(props: Props): React.JSX.Element {
  const { repo, status, busy, layout } = props
  const sidebarShown = !layout.focus && !layout.sidebarCollapsed
  const detailsShown = !layout.focus && !layout.rightCollapsed
  return (
    <header className="toolbar">
      <div className="toolbar-repo">
        <span className="toolbar-name">{repoName(repo)}</span>
        <span
          className="toolbar-branch"
          title={status.upstream ? `tracking ${status.upstream}` : 'no upstream'}
        >
          {status.branch ?? `detached at ${shortSha(status.headSha ?? '')}`}
        </span>
        {props.worktreeOf && (
          <button
            className="toolbar-worktree link-btn"
            title={`Open ${props.worktreeOf}`}
            onClick={() => props.onOpenRepo(props.worktreeOf!)}
          >
            <GitFork size={11} /> worktree of {repoName(props.worktreeOf)}
          </button>
        )}
      </div>
      <div className="toolbar-actions">
        <button className="tool" onClick={props.onFetch} title="Fetch all remotes">
          <CloudDownload size={18} />
          <span>Fetch</span>
        </button>
        <div className="tool-split">
          <button
            className="tool"
            onClick={props.onPull}
            title={titled('Pull (fast-forward only)', 'pull')}
          >
            <ArrowDownToLine size={18} />
            <span>Pull{status.behind ? ` ↓${status.behind}` : ''}</span>
          </button>
          <button
            className="tool caret"
            onClick={props.onPullMenu}
            aria-label="More pull and push options"
          >
            <ChevronDown size={14} />
          </button>
        </div>
        <button
          className="tool"
          onClick={props.onPush}
          title={titled('Push current branch', 'push')}
        >
          <ArrowUpFromLine size={18} />
          <span>Push{status.ahead ? ` ↑${status.ahead}` : ''}</span>
        </button>
        <span className="tool-sep" />
        <button
          className="tool"
          onClick={props.onBranch}
          title={titled('Create a branch from HEAD', 'branch')}
        >
          <GitBranchPlus size={18} />
          <span>Branch</span>
        </button>
        <button
          className="tool"
          disabled={!props.hasChanges}
          onClick={props.onStash}
          title={titled('Stash all changes (including new files)', 'stash')}
        >
          <Archive size={18} />
          <span>Stash</span>
        </button>
        <button
          className="tool"
          disabled={!props.hasStashes}
          onClick={props.onPop}
          title="Apply and delete the latest stash"
        >
          <ArchiveRestore size={18} />
          <span>Pop</span>
        </button>
        <span className="tool-sep" />
        <button
          className="tool"
          disabled={!props.undo || !!busy}
          onClick={props.onUndo}
          title={props.undo ? titled(props.undo.label, 'undo') : 'Nothing to undo'}
        >
          <Undo2 size={18} />
          <span>Undo</span>
        </button>
        <span className="tool-sep" />
        <GitflowButton repo={repo} currentBranch={status.branch} onChanged={props.onChanged} />
        <button
          className={props.terminalOpen ? 'tool active' : 'tool'}
          aria-pressed={props.terminalOpen}
          onClick={props.onToggleTerminal}
          title={`Terminal (${keysOf('terminal')})`}
        >
          <SquareTerminal size={18} />
          <span>Terminal</span>
        </button>
        <button
          className="tool"
          onClick={props.onStartAgent}
          title="Start agent session… (a coding agent in its own worktree)"
        >
          <Bot size={18} />
          <span>Agent</span>
        </button>
      </div>
      <div className="toolbar-right">
        {busy && (
          <span className="busy">
            <LoaderCircle size={16} className="spin" /> {busy}…
            {NETWORK_BUSY.test(busy) && (
              <button
                className="link-btn busy-cancel"
                onClick={props.onCancelNetwork}
                title="Stop this network command"
              >
                Cancel
              </button>
            )}
          </span>
        )}
        <ConflictWarnings repo={repo} version={props.version} />
        {props.search}
        <div className="layout-btns" role="group" aria-label="Layout">
          <button
            className={sidebarShown ? 'icon-btn active' : 'icon-btn'}
            aria-pressed={sidebarShown}
            aria-label="Show the sidebar"
            title={titled(
              sidebarShown ? 'Collapse the sidebar' : 'Expand the sidebar',
              'toggleSidebar'
            )}
            onClick={() => togglePanel('sidebar')}
          >
            <PanelLeft size={17} />
          </button>
          <button
            className={detailsShown ? 'icon-btn active' : 'icon-btn'}
            aria-pressed={detailsShown}
            aria-label="Show the details panel"
            title={titled(
              detailsShown ? 'Collapse the details panel' : 'Expand the details panel',
              'toggleDetails'
            )}
            onClick={() => togglePanel('right')}
          >
            <PanelRight size={17} />
          </button>
          <button
            className={layout.focus ? 'icon-btn active' : 'icon-btn'}
            aria-pressed={layout.focus}
            aria-label="Focus mode"
            title={titled(
              layout.focus
                ? 'Leave focus mode (bring the side panels back)'
                : 'Focus mode: hide both side panels',
              'focusMode'
            )}
            onClick={toggleFocus}
          >
            {layout.focus ? <Minimize size={17} /> : <Maximize size={17} />}
          </button>
        </div>
        <button
          className="icon-btn"
          onClick={props.onHelp}
          title={`Keyboard shortcuts (${keysOf('help')})`}
          aria-label="Keyboard shortcuts"
        >
          <Keyboard size={17} />
        </button>
        <button
          className="icon-btn"
          onClick={() => window.api.openFolder(repo)}
          title={openFolderLabel}
        >
          <FolderOpen size={17} />
        </button>
        <button
          className="icon-btn"
          onClick={() => window.api.openInEditor(repo)}
          title={`Open in ${editorName(props.editor)}`}
        >
          <Code size={17} />
        </button>
        <button
          className="icon-btn"
          disabled={busy === 'Syncing'}
          onClick={props.onSync}
          title={titled('Sync: fetch all remotes and refresh', 'sync')}
          aria-label="Sync with remotes"
        >
          <RefreshCw size={17} className={busy === 'Syncing' ? 'spin' : undefined} />
        </button>
        <button
          className="icon-btn"
          onClick={props.onMoreMenu}
          title="More actions: patches, agents, AI"
          aria-label="More actions"
        >
          <Ellipsis size={17} />
        </button>
      </div>
    </header>
  )
})
