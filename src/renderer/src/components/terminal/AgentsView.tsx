// "Agents" home tab: coding-agent sessions, each in its own worktree and terminal.

import { Bot, ExternalLink, Plus, RotateCw, SquareTerminal, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AGENT_LABELS, type AgentSessionInfo } from '../../../../shared/features/terminal'
import type { AppState } from '../../../../shared/types'
import { errorMessage, relativeTime, repoName } from '../../lib/format'
import { Modal } from '../ui'
import { useToasts } from '../ui-context'
import { StartAgentDialog } from './StartAgentDialog'
import { samePath } from './util'
import { XtermView } from './XtermView'
import '../../assets/terminal.css'

function status(s: AgentSessionInfo): { label: string; tone: string } {
  if (!s.worktreeExists) return { label: 'worktree missing', tone: 'bad' }
  if (s.running) return { label: 'running', tone: 'ok' }
  if (s.terminalId) return { label: 'exited', tone: 'muted' }
  return { label: 'stopped', tone: 'muted' }
}

export function AgentsView({
  state,
  onOpenRepo,
  onStateChange
}: {
  state: AppState
  onOpenRepo(path: string): void
  onStateChange(state: AppState): void
}): React.JSX.Element {
  const toasts = useToasts()
  const [sessions, setSessions] = useState<AgentSessionInfo[] | null>(null)
  const [starting, setStarting] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  const [ending, setEnding] = useState<AgentSessionInfo | null>(null)

  const refresh = useCallback(() => {
    window.api.agentSessions().then(setSessions, (e) => toasts.error(errorMessage(e)))
  }, [toasts])

  useEffect(() => {
    refresh()
    const off = window.api.on('agents:changed', refresh)
    // Change counts and commits move while agents work.
    const timer = setInterval(refresh, 5000)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [refresh])

  const shownSession = sessions?.find((s) => s.id === shown) ?? null

  const open = async (s: AgentSessionInfo): Promise<void> => {
    try {
      let path = state.repos.find((r) => samePath(r, s.worktree))
      if (!path) {
        const next = await window.api.openWorktree(s.repo, s.worktree)
        onStateChange(next)
        path = next.repos.find((r) => samePath(r, s.worktree)) ?? s.worktree
      }
      onOpenRepo(path)
    } catch (e) {
      toasts.error(errorMessage(e))
    }
  }

  const resume = async (s: AgentSessionInfo): Promise<void> => {
    try {
      await window.api.resumeAgentSession(s.id)
      onStateChange(await window.api.getState())
      setShown(s.id)
      refresh()
    } catch (e) {
      toasts.error(errorMessage(e))
    }
  }

  return (
    <div className="agents-view">
      <div className="dashboard">
        <div className="dash-header">
          <div>
            <h1>Agents</h1>
          </div>
          <span className="spacer" />
          <button className="btn primary" onClick={() => setStarting(true)}>
            <Plus size={14} /> New agent session
          </button>
        </div>
        <p className="agents-intro">
          Give a task to a coding agent (Claude Code, Codex, Gemini CLI…). Each session works on its
          own branch in its own worktree, so several agents and you can work at the same time.
        </p>

        {sessions && sessions.length === 0 && (
          <div className="dash-empty">
            <h2>No agent sessions</h2>
            <p>Start one to have an agent work on a branch of one of your repositories.</p>
            <div className="dash-empty-actions">
              <button className="btn primary" onClick={() => setStarting(true)}>
                <Plus size={14} /> New agent session
              </button>
            </div>
          </div>
        )}

        <div className="cards">
          {sessions?.map((s) => {
            const st = status(s)
            return (
              <div
                key={s.id}
                className={s.id === shown ? 'card agent-card selected' : 'card agent-card'}
                data-session={s.id}
              >
                <div className="card-top">
                  <span className="agent-name">
                    <Bot size={15} /> {AGENT_LABELS[s.agent]}
                  </span>
                  <span className={`badge ${st.tone}`}>{st.label}</span>
                </div>
                <div className="agent-task" title={s.task}>
                  {s.task}
                </div>
                <div className="agent-meta">
                  <span title={s.repo}>{repoName(s.repo)}</span>
                  <span className="mono" title={s.worktree}>
                    {s.branch}
                  </span>
                  {s.base && <span className="badge muted">from {s.base}</span>}
                  {s.ahead > 0 && (
                    <span className="badge info" title={`${s.ahead} commit(s) not in ${s.base}`}>
                      {s.ahead} ahead
                    </span>
                  )}
                  {s.behind > 0 && (
                    <span className="badge muted" title={`${s.base} has ${s.behind} new commit(s)`}>
                      {s.behind} behind
                    </span>
                  )}
                  {!!s.changes && (
                    <span className="badge warn" title="Uncommitted changes in the worktree">
                      {s.changes} changed
                    </span>
                  )}
                  <span title={new Date(s.createdAt * 1000).toLocaleString()}>
                    {relativeTime(s.createdAt)}
                  </span>
                </div>
                {s.lastCommit && <div className="agent-last">Last commit: {s.lastCommit}</div>}
                <div className="agent-actions">
                  <button
                    className="btn small"
                    disabled={!s.worktreeExists}
                    onClick={() => void open(s)}
                    title="Open the worktree in a repository tab"
                  >
                    <ExternalLink size={13} /> Open
                  </button>
                  {s.terminalId && (
                    <button
                      className="btn small"
                      onClick={() => setShown(shown === s.id ? null : s.id)}
                    >
                      <SquareTerminal size={13} /> {shown === s.id ? 'Hide terminal' : 'Terminal'}
                    </button>
                  )}
                  {!s.running && (
                    <button
                      className="btn small"
                      disabled={!s.worktreeExists}
                      onClick={() => void resume(s)}
                      title="Start the agent again in this worktree"
                    >
                      <RotateCw size={13} /> Resume
                    </button>
                  )}
                  <span className="spacer" />
                  <button className="btn small" onClick={() => setEnding(s)}>
                    End session…
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {shownSession?.terminalId && (
        <div className="agent-terminal">
          <div className="agent-terminal-header">
            <Bot size={14} />
            <span className="grow" title={shownSession.task}>
              {AGENT_LABELS[shownSession.agent]} — {shownSession.branch}
            </span>
            <button
              className="icon-btn"
              aria-label="Hide the terminal"
              onClick={() => setShown(null)}
            >
              <X size={14} />
            </button>
          </div>
          <div className="terminal-body">
            <XtermView
              key={shownSession.terminalId}
              id={shownSession.terminalId}
              visible
              onExit={refresh}
            />
          </div>
        </div>
      )}

      {starting && (
        <StartAgentDialog
          repo={null}
          baseRef={null}
          state={state}
          onClose={() => setStarting(false)}
          onStarted={(_path, next) => {
            setStarting(false)
            onStateChange(next)
            refresh()
            window.api.agentSessions().then(
              (list) => {
                setSessions(list)
                const latest = list[list.length - 1]
                if (latest) setShown(latest.id)
              },
              () => {}
            )
          }}
        />
      )}
      {ending && (
        <EndSessionDialog
          session={ending}
          onClose={() => setEnding(null)}
          onEnded={(next) => {
            setEnding(null)
            if (shown === ending.id) setShown(null)
            onStateChange(next)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function EndSessionDialog({
  session,
  onClose,
  onEnded
}: {
  session: AgentSessionInfo
  onClose(): void
  onEnded(state: AppState): void
}): React.JSX.Element {
  const toasts = useToasts()
  // Off by default when the worktree has (or may have) uncommitted work.
  const [removeWorktree, setRemoveWorktree] = useState(
    session.worktreeExists && session.changes === 0
  )
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)
  /** What the main process refused to discard without a second confirmation. */
  const [blocked, setBlocked] = useState<{
    changes: number | null
    unmergedCommits: number | null
  } | null>(null)

  const end = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.endAgentSession(session.id, {
        removeWorktree,
        deleteBranch: removeWorktree && deleteBranch,
        discardChanges: !!blocked && blocked.changes !== 0,
        discardUnmerged: !!blocked && blocked.unmergedCommits !== 0
      })
      if (result.ended) return onEnded(result.state)
      setBlocked({ changes: result.changes, unmergedCommits: result.unmergedCommits })
      setBusy(false)
    } catch (e) {
      toasts.error(errorMessage(e))
      setBusy(false)
    }
  }

  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  const loses = (n: number | null, word: string): string =>
    n === null ? `may lose ${word}s` : `loses ${plural(n, word)}`
  const confirmLabel = !blocked
    ? 'End session'
    : blocked.changes !== 0 && blocked.unmergedCommits !== 0
      ? 'Discard changes and commits'
      : blocked.unmergedCommits !== 0
        ? `Delete anyway (${loses(blocked.unmergedCommits, 'commit')})`
        : `Remove anyway (${loses(blocked.changes, 'change')})`
  const unknownBase = !session.base

  return (
    <Modal title="End the agent session?" onClose={onClose}>
      <div className="wt-form">
        <span className="hint">
          Stops the agent ({session.running ? 'it is still running' : 'not running'}) and removes
          the session from the list.
        </span>
        <label className="check-row">
          <input
            type="checkbox"
            checked={removeWorktree}
            disabled={!session.worktreeExists}
            onChange={(e) => {
              setRemoveWorktree(e.target.checked)
              setBlocked(null)
            }}
          />
          Remove the worktree folder
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={removeWorktree && deleteBranch}
            disabled={!removeWorktree || !session.branchExists}
            onChange={(e) => {
              setDeleteBranch(e.target.checked)
              setBlocked(null)
            }}
          />
          Delete the branch <span className="mono">{session.branch}</span>
        </label>
        {removeWorktree && session.changes !== 0 && !blocked && (
          <div className="warning">
            {session.changes === null
              ? `${session.worktree} may have uncommitted changes.`
              : `${plural(session.changes, 'uncommitted change')} in ${session.worktree} will be lost.`}
          </div>
        )}
        {removeWorktree && deleteBranch && session.branchExists && !blocked && (
          <>
            {session.ahead > 0 && (
              <div className="warning">
                {plural(session.ahead, 'commit')} of {session.branch} are not in{' '}
                {session.base ?? 'its base'}.
              </div>
            )}
            {unknownBase && (
              <div className="warning">
                The base of {session.branch} is unknown: its commits may exist nowhere else.
              </div>
            )}
          </>
        )}
        {blocked && blocked.changes !== 0 && (
          <div className="warning">
            {blocked.changes === null
              ? `GitDesk could not check ${session.worktree} for uncommitted changes.`
              : `${session.worktree} has ${plural(blocked.changes, 'uncommitted change')}.`}{' '}
            Removing the worktree discards {blocked.changes === 1 ? 'it' : 'them'}.
          </div>
        )}
        {blocked && blocked.unmergedCommits !== 0 && (
          <div className="warning">
            {blocked.unmergedCommits === null
              ? `${session.branch} may have commits that are in no other branch (its base is unknown).`
              : `${session.branch} has ${plural(blocked.unmergedCommits, 'commit')} that ${
                  blocked.unmergedCommits === 1 ? 'is' : 'are'
                } in no other branch.`}{' '}
            Deleting it loses them.
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={removeWorktree ? 'btn danger' : 'btn primary'}
            disabled={busy}
            onClick={() => void end()}
          >
            {busy ? 'Ending…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
