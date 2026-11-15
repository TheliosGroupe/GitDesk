// Settings › Agents: terminal shell, worktree folder and the command of each coding agent.

import { FolderOpen } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { type AgentInfo } from '../../../../shared/features/terminal'
import type { AgentKind, AppState, Settings } from '../../../../shared/types'
import { errorMessage } from '../../lib/format'
import { useToasts } from '../ui-context'
import '../../assets/terminal.css'

const WINDOWS = window.api.platform === 'win32'

export function AgentSettings({
  settings,
  onChange
}: {
  settings: Settings
  onChange(state: AppState): void
}): React.JSX.Element {
  const toasts = useToasts()
  // Edits in progress (null = show the saved value).
  const [shellDraft, setShell] = useState<string | null>(null)
  const [rootDraft, setRoot] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<AgentKind, string>>>({})
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const shell = shellDraft ?? settings.terminalShell
  const root = rootDraft ?? settings.worktreeRoot
  const commandOf = (kind: AgentKind): string => drafts[kind] ?? settings.agentCommands[kind] ?? ''

  const detect = useCallback(() => {
    window.api.detectAgents().then(setAgents, () => {})
  }, [])
  useEffect(detect, [detect, settings.agentCommands])

  const save = async (patch: Partial<Settings>): Promise<void> => {
    try {
      onChange(await window.api.setSettings(patch))
    } catch (e) {
      toasts.error(errorMessage(e))
    }
  }

  const saveCommand = (kind: AgentKind): void => {
    const value = commandOf(kind).trim()
    setDrafts((d) => {
      const next = { ...d }
      delete next[kind]
      return next
    })
    if (value === (settings.agentCommands[kind] ?? '')) return
    const next = { ...settings.agentCommands }
    if (value) next[kind] = value
    else delete next[kind]
    void save({ agentCommands: next })
  }

  return (
    <>
      <div className="field">
        <label htmlFor="settings-shell">Terminal shell</label>
        <input
          id="settings-shell"
          className="input mono"
          value={shell}
          placeholder={
            WINDOWS
              ? 'PowerShell (pwsh when installed, else powershell.exe)'
              : '$SHELL (login shell)'
          }
          onChange={(e) => setShell(e.target.value)}
          onBlur={() => {
            setShell(null)
            if (shell.trim() !== settings.terminalShell) void save({ terminalShell: shell })
          }}
        />
        <span className="help">
          A program on PATH or a full path, with its arguments, e.g.{' '}
          <span className="mono">
            {WINDOWS ? '"C:\\Program Files\\Git\\bin\\bash.exe" --login' : 'zsh -l'}
          </span>
          . Applies to new terminals.
        </span>
      </div>

      <div className="field">
        <label htmlFor="settings-worktree-root">Worktree folder</label>
        <div className="field-row">
          <input
            id="settings-worktree-root"
            className="input mono"
            value={root}
            placeholder="Next to each repository: <repository>.worktrees"
            onChange={(e) => setRoot(e.target.value)}
            onBlur={() => {
              setRoot(null)
              if (root.trim() !== settings.worktreeRoot) void save({ worktreeRoot: root })
            }}
          />
          <button
            className="btn"
            onClick={async () => {
              try {
                onChange(await window.api.pickWorktreeRoot())
              } catch (e) {
                toasts.error(errorMessage(e))
              }
            }}
          >
            <FolderOpen size={14} /> Change…
          </button>
        </div>
        <span className="help">
          New worktrees and agent sessions go to {'<folder>/<repository>/<branch>'} (absolute
          folder), or next to the repository when empty.
        </span>
      </div>

      <div className="field">
        <span className="field-label">Coding agents</span>
        {agents.map((a) => (
          <div className="agent-settings-row" key={a.kind}>
            <label htmlFor={`settings-agent-${a.kind}`}>{a.label}</label>
            <input
              id={`settings-agent-${a.kind}`}
              className="input mono"
              value={commandOf(a.kind)}
              placeholder={a.defaultCommand || 'my-agent --flag {task}'}
              onChange={(e) => setDrafts({ ...drafts, [a.kind]: e.target.value })}
              onBlur={() => saveCommand(a.kind)}
            />
            {a.command && (
              <span
                className={a.resolved ? 'agent-found' : 'agent-found missing'}
                title={a.resolved ?? a.installHint}
              >
                {a.resolved ? `Found: ${a.resolved}` : `Not found on PATH — ${a.installHint}`}
              </span>
            )}
          </div>
        ))}
        <span className="help">
          The task is passed to the program as one argument (after the agent’s prompt flag), or
          where you write <span className="mono">{'{task}'}</span>. It is never run through a shell;
          it is also in the environment variable <span className="mono">GITDESK_AGENT_TASK</span>.
          Resume adds <span className="mono">--continue</span> for Claude Code and opencode,{' '}
          <span className="mono">resume --last</span> for Codex.
        </span>
      </div>
    </>
  )
}
