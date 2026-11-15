import { ExternalLink, LoaderCircle, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Account, AppState } from '../../../../shared/types'
import {
  DEFAULT_HOSTS,
  PROVIDER_LABELS,
  type IssueTracker,
  type IssueTrackers
} from '../../../../shared/features/hosting'
import { errorMessage } from '../../lib/format'
import { Avatar } from '../ui'
import { useDialogs, useToasts } from '../ui-context'
import { AddAccountDialog } from './AddAccountDialog'
import { ProviderBadge } from './ProviderBadge'
import '../../assets/hosting.css'

const JIRA_TOKENS = 'https://id.atlassian.com/manage-profile/security/api-tokens'
const LINEAR_KEYS = 'https://linear.app/settings/account/security'

function where(a: Account): string {
  const parts = [PROVIDER_LABELS[a.provider]]
  if (a.host !== DEFAULT_HOSTS[a.provider]) parts.push(a.host)
  if (a.organization) parts.push(a.organization)
  return parts.join(' · ')
}

function TrackerStatus({
  kind,
  trackers,
  onTrackers
}: {
  kind: IssueTracker
  trackers: IssueTrackers
  onTrackers(t: IssueTrackers): void
}): React.JSX.Element | null {
  const toasts = useToasts()
  const dialogs = useDialogs()
  const [busy, setBusy] = useState(false)
  const configured = kind === 'jira' ? trackers.jira : trackers.linear
  if (!configured) return null
  const label =
    kind === 'jira' && trackers.jira
      ? `${trackers.jira.site} · ${trackers.jira.user ?? trackers.jira.email}`
      : (trackers.linear?.user ?? 'Connected')

  const test = async (): Promise<void> => {
    setBusy(true)
    try {
      toasts.info(await window.api.testIssueTracker(kind))
    } catch (e) {
      toasts.error(`${PROVIDER_LABELS[kind]}: ${errorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Disconnect ${PROVIDER_LABELS[kind]}?`,
      message: 'The saved credentials are deleted from this computer.',
      okLabel: 'Disconnect',
      danger: true
    })
    if (ok) onTrackers(await window.api.removeIssueTracker(kind))
  }

  return (
    <div className="integration-row">
      <ProviderBadge source={kind} size={20} />
      <span className="integration-name">{label}</span>
      <span className="status ok">Connected</span>
      <span className="spacer" />
      <button className="btn small" onClick={() => void test()} disabled={busy}>
        {busy && <LoaderCircle size={13} className="spin" />} Test
      </button>
      <button className="btn small danger" onClick={() => void remove()}>
        Remove
      </button>
    </div>
  )
}

/** Settings section: hosting accounts of every provider, Jira and Linear. */
export function IntegrationsSettings({
  state,
  accounts,
  onAccounts,
  onChange
}: {
  state: AppState
  accounts: Account[]
  onAccounts(accounts: Account[]): void
  onChange(state: AppState): void
}): React.JSX.Element {
  const dialogs = useDialogs()
  const toasts = useToasts()
  const [adding, setAdding] = useState(false)
  const [trackers, setTrackers] = useState<IssueTrackers | null>(null)
  const [jira, setJira] = useState({ site: '', email: '', token: '' })
  const [linearKey, setLinearKey] = useState('')
  const [busy, setBusy] = useState<IssueTracker | null>(null)
  const [error, setError] = useState<{ kind: IssueTracker; message: string } | null>(null)

  useEffect(() => {
    window.api.issueTrackers().then(setTrackers, (e) => toasts.error(errorMessage(e)))
  }, [toasts])

  const signOut = async (a: Account): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Sign out of ${a.login} (${PROVIDER_LABELS[a.provider]})?`,
      message:
        'The token is deleted from this computer. Repositories cloned with this account stay on disk ' +
        'and keep using your usual git credentials. To revoke the token, delete it on the provider’s site.',
      okLabel: 'Sign out',
      danger: true
    })
    if (!ok) return
    try {
      onAccounts(await window.api.githubSignOut(a.id))
    } catch (e) {
      toasts.error(errorMessage(e))
    }
  }

  const connect = async (kind: IssueTracker): Promise<void> => {
    setBusy(kind)
    setError(null)
    try {
      const next = await window.api.configureIssueTracker(
        kind === 'jira'
          ? { kind, site: jira.site.trim(), email: jira.email.trim(), token: jira.token.trim() }
          : { kind, apiKey: linearKey.trim() }
      )
      setTrackers(next)
      if (kind === 'jira') setJira({ site: '', email: '', token: '' })
      else setLinearKey('')
      toasts.info(`${PROVIDER_LABELS[kind]} connected`)
    } catch (e) {
      setError({ kind, message: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  const link = (url: string, label: string): React.JSX.Element => (
    <button type="button" className="link-btn" onClick={() => void window.api.openHostingUrl(url)}>
      {label} <ExternalLink size={11} />
    </button>
  )

  return (
    <div className="integrations">
      <div className="field">
        <span className="field-label">Accounts</span>
        {accounts.length === 0 && (
          <span className="help">
            No account yet. Add one to clone private repositories, see pull requests and use the
            Launchpad.
          </span>
        )}
        {accounts.map((a) => (
          <div className="integration-row" key={a.id}>
            <ProviderBadge source={a.provider} size={20} />
            <Avatar name={a.name ?? a.login} src={a.avatar} size={22} />
            <span className="integration-name" title={a.name ?? a.login}>
              {a.login}
            </span>
            <span className="muted integration-where">{where(a)}</span>
            {a.expired && <span className="status bad">expired</span>}
            <span className="spacer" />
            <button className="btn small danger" onClick={() => void signOut(a)}>
              Sign out
            </button>
          </div>
        ))}
        <div>
          <button className="btn small" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add account
          </button>
        </div>
      </div>

      <div className="field">
        <span className="field-label">Jira Cloud</span>
        {trackers?.jira ? (
          <TrackerStatus kind="jira" trackers={trackers} onTrackers={setTrackers} />
        ) : (
          <form
            className="integration-form"
            onSubmit={(e) => {
              e.preventDefault()
              void connect('jira')
            }}
          >
            <label htmlFor="jira-site">Site URL</label>
            <input
              id="jira-site"
              className="input"
              placeholder="https://your-company.atlassian.net"
              value={jira.site}
              onChange={(e) => setJira({ ...jira, site: e.target.value })}
            />
            <label htmlFor="jira-email">Email</label>
            <input
              id="jira-email"
              className="input"
              placeholder="you@example.com"
              value={jira.email}
              onChange={(e) => setJira({ ...jira, email: e.target.value })}
            />
            <label htmlFor="jira-token">API token</label>
            <input
              id="jira-token"
              className="input mono"
              type="password"
              autoComplete="off"
              value={jira.token}
              onChange={(e) => setJira({ ...jira, token: e.target.value })}
            />
            <span className="help integration-help">
              Issues assigned to you show in the Launchpad and in each repository.{' '}
              {link(JIRA_TOKENS, 'Create an API token')}
            </span>
            {error?.kind === 'jira' && <p className="error-text">{error.message}</p>}
            <div>
              <button
                type="submit"
                className="btn small primary"
                disabled={busy !== null || !jira.site.trim() || !jira.email.trim() || !jira.token}
              >
                {busy === 'jira' && <LoaderCircle size={13} className="spin" />} Connect Jira
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="field">
        <span className="field-label">Linear</span>
        {trackers?.linear ? (
          <TrackerStatus kind="linear" trackers={trackers} onTrackers={setTrackers} />
        ) : (
          <form
            className="integration-form"
            onSubmit={(e) => {
              e.preventDefault()
              void connect('linear')
            }}
          >
            <label htmlFor="linear-key">Personal API key</label>
            <input
              id="linear-key"
              className="input mono"
              type="password"
              autoComplete="off"
              placeholder="lin_api_…"
              value={linearKey}
              onChange={(e) => setLinearKey(e.target.value)}
            />
            <span className="help integration-help">
              {link(LINEAR_KEYS, 'Create a personal API key')}
            </span>
            {error?.kind === 'linear' && <p className="error-text">{error.message}</p>}
            <div>
              <button
                type="submit"
                className="btn small primary"
                disabled={busy !== null || !linearKey.trim()}
              >
                {busy === 'linear' && <LoaderCircle size={13} className="spin" />} Connect Linear
              </button>
            </div>
          </form>
        )}
      </div>

      {adding && (
        <AddAccountDialog
          settings={state.settings}
          onSettings={onChange}
          onClose={() => setAdding(false)}
          onAdded={(account) => {
            setAdding(false)
            onAccounts([...accounts.filter((a) => a.id !== account.id), account])
            toasts.info(`Signed in to ${PROVIDER_LABELS[account.provider]} as ${account.login}`)
          }}
        />
      )}
    </div>
  )
}
