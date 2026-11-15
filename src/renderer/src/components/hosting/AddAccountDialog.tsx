import { ExternalLink, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { Account, AppState, Settings } from '../../../../shared/types'
import {
  DEFAULT_HOSTS,
  HOSTING_PROVIDERS,
  PROVIDER_LABELS,
  type HostingProvider
} from '../../../../shared/features/hosting'
import { errorMessage } from '../../lib/format'
import { SignInDialog } from '../GitHub'
import { Modal } from '../ui'
import '../../assets/hosting.css'

interface TokenHelp {
  scopes: React.ReactNode
  url: string
  linkLabel: string
  extra?: React.ReactNode
}

/** A bare host name ("gitlab.example.com"), whatever was typed ("https://…/"). */
function cleanHost(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
}

function tokenHelp(provider: HostingProvider, host: string, organization: string): TokenHelp {
  switch (provider) {
    case 'github':
      return {
        scopes: (
          <>
            A classic personal access token with the scopes <code>repo</code>, <code>read:org</code>{' '}
            and <code>read:user</code>.
          </>
        ),
        url: `https://${host}/settings/tokens/new?scopes=repo,read:org,read:user&description=GitDesk`,
        linkLabel: 'Create a token on GitHub'
      }
    case 'gitlab':
      return {
        scopes: (
          <>
            A personal access token with the <code>api</code> scope (needed to create merge
            requests; <code>read_api</code> + <code>read_repository</code> +{' '}
            <code>write_repository</code> is enough to clone and fetch).
          </>
        ),
        url: `https://${host}/-/user_settings/personal_access_tokens?name=GitDesk&scopes=api`,
        linkLabel: 'Create a token on GitLab'
      }
    case 'bitbucket':
      return {
        scopes: (
          <>
            An Atlassian API token for Bitbucket with the scopes <code>read:user</code>,{' '}
            <code>read:workspace</code>, <code>read:repository</code>, <code>write:repository</code>
            , <code>read:pullrequest</code>, <code>write:pullrequest</code> (enter your Atlassian
            email above), or an app password with your Bitbucket username.
          </>
        ),
        url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
        linkLabel: 'Create an API token',
        extra: (
          <button
            type="button"
            className="link-btn"
            onClick={() =>
              void window.api.openHostingUrl(
                'https://bitbucket.org/account/settings/app-passwords/'
              )
            }
          >
            app passwords <ExternalLink size={11} />
          </button>
        )
      }
    case 'azure':
      return {
        scopes: (
          <>
            A personal access token with the scopes <em>Code (Read &amp; write)</em>,{' '}
            <em>Work Items (Read)</em> and <em>User Profile (Read)</em>.
          </>
        ),
        url: `https://dev.azure.com/${encodeURIComponent(organization || '_')}/_usersSettings/tokens`,
        linkLabel: 'Create a token in Azure DevOps'
      }
  }
}

/**
 * Adds an account of any provider: GitHub through the device flow (the existing
 * SignInDialog) or a personal access token, the others with a token.
 */
export function AddAccountDialog({
  settings,
  onSettings,
  onClose,
  onAdded
}: {
  settings: Settings
  onSettings(state: AppState): void
  onClose(): void
  onAdded(account: Account): void
}): React.JSX.Element {
  const [provider, setProvider] = useState<HostingProvider>('github')
  const [githubMode, setGithubMode] = useState<'device' | 'token'>('device')
  const [deviceFlow, setDeviceFlow] = useState(false)
  const [host, setHost] = useState('')
  const [username, setUsername] = useState('')
  const [organization, setOrganization] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (deviceFlow) {
    return (
      <SignInDialog
        settings={settings}
        onSettings={onSettings}
        onClose={onClose}
        onSignedIn={onAdded}
      />
    )
  }

  const hasHost = provider === 'github' || provider === 'gitlab'
  const effectiveHost = (hasHost && cleanHost(host)) || DEFAULT_HOSTS[provider]
  const help = tokenHelp(provider, effectiveHost, organization.trim())
  const tokenForm = provider !== 'github' || githubMode === 'token'
  const ready =
    !!token.trim() &&
    (provider !== 'azure' || !!organization.trim()) &&
    (provider !== 'bitbucket' || !!username.trim())

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const account = await window.api.hostingSignIn({
        provider,
        host: hasHost ? cleanHost(host) : undefined,
        token: token.trim(),
        username: provider === 'bitbucket' ? username.trim() : undefined,
        organization: provider === 'azure' ? organization.trim() : undefined
      })
      setToken('')
      onAdded(account)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Add an account" onClose={() => !busy && onClose()} wide>
      <div className="field">
        <span className="field-label" id="add-account-provider">
          Provider
        </span>
        <div
          className="segmented text theme-choice"
          role="radiogroup"
          aria-labelledby="add-account-provider"
        >
          {HOSTING_PROVIDERS.map((p) => (
            <button
              key={p}
              role="radio"
              aria-checked={provider === p}
              className={provider === p ? 'active' : ''}
              onClick={() => {
                setProvider(p)
                setError(null)
              }}
            >
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {provider === 'github' && (
        <div className="field">
          <label className="check-row">
            <input
              type="radio"
              name="github-mode"
              checked={githubMode === 'device'}
              onChange={() => setGithubMode('device')}
            />
            <span>
              Sign in with the browser <span className="muted">(github.com, device flow)</span>
            </span>
          </label>
          <label className="check-row">
            <input
              type="radio"
              name="github-mode"
              checked={githubMode === 'token'}
              onChange={() => setGithubMode('token')}
            />
            <span>
              Personal access token{' '}
              <span className="muted">(github.com or GitHub Enterprise Server)</span>
            </span>
          </label>
        </div>
      )}

      {!tokenForm ? (
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => setDeviceFlow(true)} autoFocus>
            Continue
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {hasHost && (
            <div className="field">
              <label htmlFor="account-host">Host</label>
              <input
                id="account-host"
                className="input"
                placeholder={DEFAULT_HOSTS[provider]}
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
              <span className="help">
                {provider === 'github'
                  ? 'Leave empty for github.com; your GitHub Enterprise Server host otherwise.'
                  : 'Leave empty for gitlab.com; your self-managed GitLab host otherwise.'}
              </span>
            </div>
          )}
          {provider === 'bitbucket' && (
            <div className="field">
              <label htmlFor="account-username">Username or email</label>
              <input
                id="account-username"
                className="input"
                placeholder="you@example.com"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
              <span className="help">
                Your Atlassian email for an API token, or your Bitbucket username for an app
                password.
              </span>
            </div>
          )}
          {provider === 'azure' && (
            <div className="field">
              <label htmlFor="account-organization">Organization</label>
              <input
                id="account-organization"
                className="input"
                placeholder="contoso"
                value={organization}
                onChange={(e) => setOrganization(e.target.value)}
              />
              <span className="help">As in dev.azure.com/&lt;organization&gt;.</span>
            </div>
          )}
          <div className="field">
            <label htmlFor="account-token">Token</label>
            <input
              id="account-token"
              className="input mono"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              autoFocus
            />
            <span className="help">
              {help.scopes}{' '}
              <button
                className="link-btn"
                onClick={() => void window.api.openHostingUrl(help.url)}
                type="button"
              >
                {help.linkLabel} <ExternalLink size={11} />
              </button>
              {help.extra && <> · {help.extra}</>}
            </span>
            <span className="help">
              The token is checked with {PROVIDER_LABELS[provider]}, then encrypted on this
              computer. Git only gets it for {effectiveHost}, for repositories cloned with this
              account.
            </span>
          </div>
          {error && <p className="error-text">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={!ready || busy}>
              {busy && <LoaderCircle size={14} className="spin" />}
              Add account
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}
