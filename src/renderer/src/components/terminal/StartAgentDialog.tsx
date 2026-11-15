// "New agent session": a task for a coding agent, in its own branch and worktree.

import { useEffect, useMemo, useState } from 'react'
import { AGENT_LABELS, taskSlug, type AgentInfo } from '../../../../shared/features/terminal'
import type { AgentKind, AppState, RefsInfo } from '../../../../shared/types'
import { errorMessage, repoName } from '../../lib/format'
import { Modal } from '../ui'
import { useToasts } from '../ui-context'
import '../../assets/terminal.css'

const LAST_AGENT_KEY = 'gitdesk.agent.last'

function lastAgent(): AgentKind | null {
  try {
    const v = localStorage.getItem(LAST_AGENT_KEY)
    return v && v in AGENT_LABELS ? (v as AgentKind) : null
  } catch {
    return null
  }
}

export function StartAgentDialog({
  repo: initialRepo,
  baseRef,
  state,
  onClose,
  onStarted
}: {
  repo: string | null
  baseRef: string | null
  state: AppState
  onClose(): void
  onStarted(worktreePath: string, state: AppState): void
}): React.JSX.Element {
  const toasts = useToasts()
  // Worktrees opened as tabs belong to their main repository: start from that one.
  const repos = useMemo(
    () => state.repos.filter((r) => !(r in state.worktreeParents)),
    [state.repos, state.worktreeParents]
  )
  const [repo, setRepo] = useState(initialRepo ?? repos[0] ?? '')
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [task, setTask] = useState('')
  const [refs, setRefs] = useState<RefsInfo | null>(null)
  const [base, setBase] = useState(baseRef ?? '')
  const [branch, setBranch] = useState('')
  const [checked, setChecked] = useState<{ task: string; name: string } | null>(null)
  const preview = checked?.task === task ? checked.name : `agent/${taskSlug(task)}`
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.api.detectAgents().then(
      (list) => {
        setAgents(list)
        const usable = list.filter((a) => a.command)
        const remembered = lastAgent()
        const pick =
          usable.find((a) => a.kind === remembered && a.resolved) ??
          usable.find((a) => a.resolved) ??
          usable[0]
        if (pick) setAgent(pick.kind)
      },
      (e) => toasts.error(errorMessage(e))
    )
  }, [toasts])

  useEffect(() => {
    if (!repo) return
    let cancelled = false
    window.api.refs(repo).then(
      (r) => {
        if (cancelled) return
        setRefs(r)
        setBase((b) =>
          b && (r.branches.some((x) => x.name === b) || b === r.headSha)
            ? b
            : (r.headBranch ?? r.headSha ?? '')
        )
      },
      (e) => !cancelled && toasts.error(errorMessage(e))
    )
    return () => {
      cancelled = true
    }
  }, [repo, toasts])

  // Branch name preview, unique in the repository (main process checks existing branches).
  useEffect(() => {
    if (!repo) return
    const timer = setTimeout(() => {
      window.api.agentBranchName(repo, task).then(
        (name) => setChecked({ task, name }),
        () => {}
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [repo, task])

  const info = agents?.find((a) => a.kind === agent)
  const shown = agents?.filter((a) => a.command) ?? []

  const start = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!repo || !task.trim() || busy) return
    setBusy(true)
    try {
      const result = await window.api.startAgentSession({
        repo,
        task,
        agent,
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        ...(base ? { baseRef: base } : {})
      })
      try {
        localStorage.setItem(LAST_AGENT_KEY, agent)
      } catch {
        // Not critical.
      }
      onStarted(result.session.worktree, result.state)
    } catch (err) {
      toasts.error(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="New agent session" onClose={onClose} wide>
      <form className="wt-form" onSubmit={start}>
        <span className="hint">
          The agent works on a new branch in its own worktree and terminal, so your working copy is
          left alone. Review its commits, then merge the branch.
        </span>
        {!initialRepo && (
          <div>
            <label className="modal-label" htmlFor="agent-repo">
              Repository
            </label>
            <select
              id="agent-repo"
              className="input"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            >
              {repos.map((r) => (
                <option key={r} value={r}>
                  {repoName(r)} — {r}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="agent-select">
          <label className="modal-label" htmlFor="agent-kind">
            Agent
          </label>
          <select
            id="agent-kind"
            className="input"
            value={agent}
            onChange={(e) => setAgent(e.target.value as AgentKind)}
          >
            {shown.map((a) => (
              <option key={a.kind} value={a.kind}>
                {a.label}
                {a.resolved ? '' : ' (not found)'}
              </option>
            ))}
          </select>
          {info && (
            <span className="agent-select-status">
              {info.resolved ? (
                <>
                  Runs <span className="mono">{info.command}</span> ({info.resolved})
                </>
              ) : (
                <>
                  <span className="mono">{info.command}</span> was not found on PATH. Install it (
                  <span className="mono">{info.installHint}</span>) or set its command in Settings ›
                  Agents. You can still start: the terminal will say what is missing.
                </>
              )}
            </span>
          )}
        </div>
        <div>
          <label className="modal-label" htmlFor="agent-task">
            Task
          </label>
          <textarea
            id="agent-task"
            className="input"
            autoFocus
            value={task}
            placeholder="What should the agent do? e.g. Add input validation to the signup form and tests for it."
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void start(e)
            }}
          />
        </div>
        <div className="field-row">
          <div style={{ flex: 1 }}>
            <label className="modal-label" htmlFor="agent-base">
              Base branch
            </label>
            <select
              id="agent-base"
              className="input"
              value={base}
              onChange={(e) => setBase(e.target.value)}
            >
              {refs?.headBranch === null && refs.headSha && (
                <option value={refs.headSha}>HEAD ({refs.headSha.slice(0, 7)})</option>
              )}
              {refs?.branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
              {base &&
                refs &&
                !refs.branches.some((b) => b.name === base) &&
                base !== refs.headSha && <option value={base}>{base}</option>}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label className="modal-label" htmlFor="agent-branch">
              New branch
            </label>
            <input
              id="agent-branch"
              className="input mono"
              value={branch}
              placeholder={preview}
              onChange={(e) => setBranch(e.target.value)}
            />
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={!repo || !task.trim() || busy || !info?.command}
            title="Ctrl+Enter"
          >
            {busy ? 'Starting…' : 'Start agent'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
