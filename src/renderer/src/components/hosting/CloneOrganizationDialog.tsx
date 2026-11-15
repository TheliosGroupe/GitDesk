import { CloudDownload, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Account, AppState } from '../../../../shared/types'
import type {
  HostingOrg,
  OrgCloneProgress,
  OrgCloneResult
} from '../../../../shared/features/hosting'
import { errorMessage } from '../../lib/format'
import { Modal } from '../ui'
import { useToasts } from '../ui-context'
import { accountLabel } from './labels'
import '../../assets/hosting.css'

const NEW = '\0new'
const NONE = ''

const KIND_LABEL: Record<HostingOrg['kind'], string> = {
  org: 'Organization',
  user: 'Your account',
  group: 'Group',
  workspace: 'Workspace',
  project: 'Project'
}

/** Clones every repository of a GitHub organization, GitLab group, Bitbucket workspace or Azure DevOps project. */
export function CloneOrganizationDialog({
  state,
  accounts,
  workspaceId,
  onClose,
  onDone
}: {
  state: AppState
  accounts: Account[]
  /** Workspace preselected (the one shown on the dashboard). */
  workspaceId: string | null
  onClose(): void
  onDone(state: AppState, workspaceId: string | null): void
}): React.JSX.Element {
  const toasts = useToasts()
  const [account, setAccount] = useState(accounts[0]?.id ?? '')
  const [orgs, setOrgs] = useState<{ account: string; list: HostingOrg[] } | null>(null)
  const [orgError, setOrgError] = useState<string | null>(null)
  const [org, setOrg] = useState('')
  const [target, setTarget] = useState(workspaceId ?? NEW)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<OrgCloneProgress | null>(null)
  const [result, setResult] = useState<OrgCloneResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!account) return
    let cancelled = false
    window.api.hostingOrganizations(account).then(
      (list) => {
        if (cancelled) return
        setOrgError(null)
        setOrgs({ account, list })
        setOrg((current) =>
          list.some((o) => o.name === current) ? current : (list[0]?.name ?? '')
        )
      },
      (e) => {
        if (cancelled) return
        setOrgs({ account, list: [] })
        setOrgError(errorMessage(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [account])

  useEffect(() => window.api.on('hosting:org-clone-progress', setProgress), [])

  const loading = orgs?.account !== account
  const orgLabel = orgs?.list.find((o) => o.name === org)?.label ?? org

  const start = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    setResult(null)
    setProgress(null)
    try {
      let workspace: string | null = target === NONE ? null : target
      if (target === NEW) {
        workspace = `ws-${crypto.randomUUID()}`
        await window.api.setWorkspaces([
          ...state.workspaces,
          {
            id: workspace,
            name: orgLabel.replace(/ \(your (repositories|projects)\)$/, ''),
            repos: []
          }
        ])
      }
      const r = await window.api.cloneOrganization(account, org, workspace)
      setResult(r)
      onDone(r.state, workspace)
      const failed = r.failed.length ? `, ${r.failed.length} failed` : ''
      toasts.info(`Cloned ${r.cloned.length}, already there ${r.skipped.length}${failed}`)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRunning(false)
    }
  }

  const percent =
    progress && progress.total
      ? Math.round(((progress.done + (progress.percent ?? 0) / 100) / progress.total) * 100)
      : null

  return (
    <Modal title="Clone an organization" onClose={() => !running && onClose()}>
      <p className="help">
        Clones every repository you can access into your clone folder (
        <code>{state.settings.cloneRoot}</code>
        ), skipping those already there, and follows them.
      </p>
      <div className="field">
        <label htmlFor="org-account">Account</label>
        <select
          id="org-account"
          className="input"
          value={account}
          disabled={running}
          onChange={(e) => setAccount(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {accountLabel(a)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="org-name">Organization, group, workspace or project</label>
        <select
          id="org-name"
          className="input"
          value={org}
          disabled={running || loading || !orgs?.list.length}
          onChange={(e) => setOrg(e.target.value)}
        >
          {loading && <option value="">Loading…</option>}
          {orgs?.list.map((o) => (
            <option key={o.name} value={o.name}>
              {o.label} · {KIND_LABEL[o.kind]}
            </option>
          ))}
        </select>
        {orgError && <span className="error-text">{orgError}</span>}
      </div>
      <div className="field">
        <label htmlFor="org-workspace">Add to workspace</label>
        <select
          id="org-workspace"
          className="input"
          value={target}
          disabled={running}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value={NEW}>New workspace “{orgLabel || '…'}”</option>
          {state.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
          <option value={NONE}>No workspace</option>
        </select>
      </div>

      {running && (
        <div className="field">
          <div className="progress" role="progressbar" aria-valuenow={percent ?? undefined}>
            <div style={{ width: `${percent ?? 2}%` }} />
          </div>
          <div className="progress-label">
            <span>
              {progress?.current
                ? `${progress.current}${progress.phase ? ` · ${progress.phase}` : ''}`
                : 'Listing repositories…'}
            </span>
            <span>{progress ? `${progress.done} / ${progress.total}` : ''}</span>
          </div>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      {result && (
        <div className="org-clone-result">
          <p className="help">
            {result.cloned.length} cloned, {result.skipped.length} already there
            {result.failed.length ? `, ${result.failed.length} failed:` : '.'}
          </p>
          {result.failed.length > 0 && (
            <ul className="org-clone-failed">
              {result.failed.map((f) => (
                <li key={f.repo}>
                  <strong>{f.repo}</strong>: {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={running}>
          {result ? 'Close' : 'Cancel'}
        </button>
        {!result && (
          <button
            className="btn primary"
            disabled={running || !account || !org}
            onClick={() => void start()}
          >
            {running ? <LoaderCircle size={14} className="spin" /> : <CloudDownload size={14} />}{' '}
            Clone all
          </button>
        )}
      </div>
    </Modal>
  )
}
