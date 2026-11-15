import { CloudDownload, ExternalLink, Globe, LoaderCircle, Lock, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Account, AppState, CloneProgress, DeviceCode, Settings } from '../../../shared/types'
import {
  HOSTING_PROVIDERS,
  PROVIDER_LABELS,
  type HostedReposResult,
  type HostingProvider
} from '../../../shared/features/hosting'
import { errorMessage, relativeTime } from '../lib/format'
import { isMac, isWindows } from '../lib/platform'
import { accountLabel, cloneFoldersOf, profileUrl } from './hosting/labels'
import { ProviderBadge } from './hosting/ProviderBadge'
import { Avatar, ContextMenu, Modal, type MenuState } from './ui'
import { useDialogs } from './ui-context'

/** Where Electron safeStorage keeps the key that encrypts tokens. */
const secureStoreName = isWindows ? 'Windows' : isMac ? 'the macOS Keychain' : 'the system keyring'

/** How to register the OAuth App that the sign-in uses (one time, free). */
export function OAuthAppSteps(): React.JSX.Element {
  return (
    <>
      <ol className="steps">
        <li>
          On GitHub, create a new <strong>OAuth App</strong>{' '}
          <button
            className="link-btn"
            onClick={() => window.api.openGitHub('settings/applications/new')}
          >
            (open the page <ExternalLink size={11} />)
          </button>
          . Not a “GitHub App”: if the form asks for a webhook, you are on the wrong one.
        </li>
        <li>
          Application name <code>GitDesk</code>, Homepage URL and Redirect URI{' '}
          <code>http://localhost</code>.
        </li>
        <li>
          Tick <em>Enable Device Flow</em>, <strong>untick</strong>{' '}
          <em>Expire user access tokens</em> (expiring tokens would need a client secret to renew),
          then <em>Register application</em>.
        </li>
        <li>
          Copy its <em>Client ID</em> below. It is not a secret; no client secret is needed.
        </li>
      </ol>
    </>
  )
}

type Step =
  | { kind: 'intro' }
  | { kind: 'starting' }
  | { kind: 'code'; code: DeviceCode }
  | { kind: 'error'; message: string }

export function SignInDialog({
  settings,
  onSettings,
  onClose,
  onSignedIn
}: {
  settings: Settings
  onSettings(state: AppState): void
  onClose(): void
  onSignedIn(account: Account): void
}): React.JSX.Element {
  const [step, setStep] = useState<Step>({ kind: 'intro' })
  const [clientId, setClientId] = useState(settings.githubClientId)
  const [editingId, setEditingId] = useState(!settings.githubClientId)

  const cancel = (): void => {
    void window.api.githubCancelSignIn()
    onClose()
  }

  const start = async (): Promise<void> => {
    setStep({ kind: 'starting' })
    try {
      const code = await window.api.githubStartSignIn()
      setStep({ kind: 'code', code })
      onSignedIn(await window.api.githubFinishSignIn())
    } catch (e) {
      const message = errorMessage(e)
      if (!/cancelled/i.test(message)) setStep({ kind: 'error', message })
    }
  }

  const saveClientId = async (): Promise<void> => {
    onSettings(await window.api.setSettings({ githubClientId: clientId.trim() }))
    setEditingId(false)
  }

  const openGitHub = async (code: DeviceCode): Promise<void> => {
    await navigator.clipboard.writeText(code.userCode)
    await window.api.openGitHub('login/device')
  }

  return (
    <Modal title="Sign in with GitHub" onClose={cancel}>
      {editingId ? (
        <>
          <p className="help">
            GitDesk signs in through your own GitHub OAuth App, so no secret ships with the app. Set
            it up once:
          </p>
          <OAuthAppSteps />
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="client-id">Client ID</label>
            <input
              id="client-id"
              className="input mono"
              placeholder="Ov23li…"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && clientId.trim() && saveClientId()}
              autoFocus
            />
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
            <button className="btn primary" disabled={!clientId.trim()} onClick={saveClientId}>
              Save
            </button>
          </div>
        </>
      ) : step.kind === 'intro' ? (
        <>
          <p className="modal-message">
            GitDesk will show a one-time code. Enter it on github.com to let GitDesk see and clone
            your repositories, private ones included. You can sign in to several accounts, one after
            the other.
          </p>
          <p className="help">
            The access token is encrypted with {secureStoreName} and only used for github.com.{' '}
            <button className="link-btn" onClick={() => setEditingId(true)}>
              Change Client ID
            </button>
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
            <button className="btn primary" onClick={start} autoFocus>
              Get a code
            </button>
          </div>
        </>
      ) : step.kind === 'starting' ? (
        <div className="waiting">
          <LoaderCircle size={16} className="spin" /> Contacting GitHub…
        </div>
      ) : step.kind === 'code' ? (
        <>
          <p className="modal-message">Enter this code on GitHub, then approve GitDesk:</p>
          <div className="device-code">{step.code.userCode}</div>
          <button className="btn primary block" onClick={() => openGitHub(step.code)} autoFocus>
            Copy code and open GitHub
          </button>
          <div className="waiting">
            <LoaderCircle size={16} className="spin" /> Waiting for your approval on GitHub…
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="error-text">{step.message}</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setEditingId(true)}>
              Change Client ID
            </button>
            <button className="btn primary" onClick={start}>
              Try again
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

export function AccountBar({
  accounts,
  onAccounts,
  onSignIn,
  onAddAccount
}: {
  accounts: Account[]
  onAccounts(accounts: Account[]): void
  /** GitHub device-flow sign-in. */
  onSignIn(): void
  /** Any provider (token form or device flow); without it "Add account" signs in to GitHub. */
  onAddAccount?(): void
}): React.JSX.Element {
  const dialogs = useDialogs()
  const [menu, setMenu] = useState<MenuState | null>(null)

  const signOut = async (a: Account): Promise<void> => {
    const github = a.provider === 'github' && a.host === 'github.com'
    const ok = await dialogs.confirm({
      title: `Sign out of ${accountLabel(a)}?`,
      message:
        'Repositories cloned with this account stay on disk and keep using your usual git credentials. ' +
        (github
          ? 'To revoke GitDesk completely, remove it under Settings → Applications on github.com.'
          : `To revoke the token, delete it in your ${PROVIDER_LABELS[a.provider]} settings.`),
      okLabel: 'Sign out',
      danger: true
    })
    if (ok) onAccounts(await window.api.githubSignOut(a.id))
  }

  return (
    <div className="accounts">
      {accounts.map((a) => {
        const profile = profileUrl(a)
        const cloud = a.provider === 'github' && a.host === 'github.com'
        return (
          <button
            key={a.id}
            className="account-chip"
            title={
              a.expired
                ? 'Sign-in expired: sign in again'
                : `${a.name ?? a.login}\n${accountLabel(a)}`
            }
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setMenu({
                x: r.left,
                y: r.bottom + 4,
                items: [
                  {
                    label: `Open profile on ${PROVIDER_LABELS[a.provider]}`,
                    disabled: !profile,
                    onClick: () => profile && void window.api.openHostingUrl(profile)
                  },
                  { label: 'Sign out…', danger: true, onClick: () => signOut(a) }
                ]
              })
            }}
          >
            <Avatar name={a.name ?? a.login} src={a.avatar} size={22} />
            {a.login}
            {!cloud && <ProviderBadge source={a.provider} size={16} />}
            {a.expired && <span className="status bad">expired</span>}
          </button>
        )
      })}
      {accounts.length === 0 && (
        <button className="btn" onClick={onSignIn}>
          <Globe size={14} /> Sign in with GitHub
        </button>
      )}
      <button className={accounts.length ? 'btn small' : 'btn'} onClick={onAddAccount ?? onSignIn}>
        <Plus size={13} />
        {accounts.length ? 'Add account' : 'GitLab, Bitbucket, Azure DevOps…'}
      </button>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

type ProviderTab = 'all' | HostingProvider

export function CloneDialog({
  accounts,
  settings,
  followed,
  onClose,
  onCloned,
  onSettings,
  onSignIn
}: {
  accounts: Account[]
  settings: Settings
  /** "host|slug" (slug in lowercase) of repositories already in GitDesk. */
  followed: Set<string>
  onClose(): void
  onCloned(result: { state: AppState; path: string }): void
  onSettings(state: AppState): void
  onSignIn(): void
}): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [account, setAccount] = useState('')
  const [result, setResult] = useState<HostedReposResult | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [tab, setTab] = useState<ProviderTab>('all')
  const [cloning, setCloning] = useState<string | null>(null)
  const [progress, setProgress] = useState<CloneProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!accounts.length) return
    let cancelled = false
    window.api.hostingRepos(null).then(
      (r) => !cancelled && setResult(r),
      (e) => !cancelled && setListError(errorMessage(e))
    )
    return () => {
      cancelled = true
    }
  }, [accounts])

  useEffect(() => window.api.onCloneProgress(setProgress), [])

  const providers = useMemo(
    () => HOSTING_PROVIDERS.filter((p) => accounts.some((a) => a.provider === p)),
    [accounts]
  )
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (result?.repos ?? []).filter(
      (r) =>
        (tab === 'all' || r.provider === tab) &&
        (!q || r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q))
    )
  }, [result, filter, tab])

  const clone = async (input: string, accountId: string | null): Promise<void> => {
    setCloning(input)
    setError(null)
    setProgress(null)
    try {
      onCloned(await window.api.cloneRepo(input, accountId))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setCloning(null)
    }
  }

  const folders = cloneFoldersOf(url)
  const sep = settings.cloneRoot.includes('/') ? '/' : '\\'
  const target = folders ? [settings.cloneRoot, ...folders].join(sep) : null

  return (
    <Modal title="Clone a repository" onClose={() => !cloning && onClose()} wide>
      <div className="field">
        <label htmlFor="clone-url">Repository link</label>
        <div className="clone-url">
          <input
            id="clone-url"
            className="input"
            placeholder="https://gitlab.com/group/repo, git@bitbucket.org:team/repo.git or owner/repo"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) =>
              e.key === 'Enter' && url.trim() && !cloning && clone(url, account || null)
            }
            disabled={!!cloning}
            autoFocus
          />
          {accounts.length > 1 && (
            <select
              className="input"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              title="Account"
              aria-label="Account"
            >
              <option value="">Any account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountLabel(a)}
                </option>
              ))}
            </select>
          )}
          <button
            className="btn primary"
            disabled={!url.trim() || !!cloning}
            onClick={() => clone(url, account || null)}
          >
            <CloudDownload size={14} /> Clone
          </button>
        </div>
        <div className="clone-target">
          Clones into {target ?? settings.cloneRoot}
          {' · '}
          <button
            className="link-btn"
            onClick={async () => onSettings(await window.api.pickCloneRoot())}
          >
            change folder
          </button>
        </div>
      </div>

      {cloning && (
        <div className="field">
          <div
            className="progress"
            role="progressbar"
            aria-valuenow={progress?.percent ?? undefined}
          >
            <div style={{ width: `${progress?.percent ?? 2}%` }} />
          </div>
          <div className="progress-label">
            <span>{progress?.phase ?? 'Connecting'}…</span>
            <span>{progress?.percent != null ? `${progress.percent}%` : ''}</span>
          </div>
          <button
            className="link-btn"
            onClick={() => void window.api.cancelClone().catch(() => undefined)}
          >
            Cancel clone
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}

      <div className="divider" />
      {accounts.length === 0 ? (
        <p className="help">
          <button className="link-btn" onClick={onSignIn}>
            Sign in with GitHub
          </button>{' '}
          (or add a GitLab, Bitbucket or Azure DevOps account in Settings) to pick from your
          repositories, private ones included. Public repositories can be cloned from their link
          without signing in.
        </p>
      ) : (
        <>
          <div className="field-row">
            {providers.length > 1 && (
              <div className="segmented text clone-tabs" role="tablist" aria-label="Provider">
                {(['all', ...providers] as ProviderTab[]).map((p) => (
                  <button
                    key={p}
                    role="tab"
                    aria-selected={tab === p}
                    className={tab === p ? 'active' : ''}
                    onClick={() => setTab(p)}
                  >
                    {p === 'all' ? 'All' : PROVIDER_LABELS[p]}
                  </button>
                ))}
              </div>
            )}
            <div className="sb-filter" style={{ margin: 0, flex: 1 }}>
              <Search size={14} />
              <input
                placeholder="Filter your repositories"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          </div>
          <div className="repo-list">
            {listError && <div className="empty-state error">{listError}</div>}
            {result?.errors.map((e) => {
              const a = byId.get(e.account)
              return (
                <div key={e.account} className="empty-state error">
                  {a ? accountLabel(a) : e.account}: {e.error}
                </div>
              )
            })}
            {!listError && result === null && (
              <div className="empty-state">
                <LoaderCircle size={16} className="spin" /> Loading your repositories…
              </div>
            )}
            {visible.map((r) => {
              const isFollowed = followed.has(`${r.host}|${r.fullName.toLowerCase()}`)
              const via = byId.get(r.account)
              return (
                <div className="repo-row" key={`${r.host}|${r.fullName}`}>
                  <div className="repo-main">
                    <div className="repo-name">
                      {r.private ? (
                        <Lock size={13} aria-label="private" />
                      ) : (
                        <Globe size={13} aria-label="public" />
                      )}
                      {providers.length > 1 && <ProviderBadge source={r.provider} size={15} />}
                      {r.fullName}
                    </div>
                    {r.description && <div className="repo-desc">{r.description}</div>}
                    <div className="repo-meta">
                      {r.pushedAt && `updated ${relativeTime(Date.parse(r.pushedAt) / 1000)}`}
                      {accounts.length > 1 && ` · via ${via ? accountLabel(via) : r.account}`}
                      {r.fork && ' · fork'}
                    </div>
                  </div>
                  {isFollowed ? (
                    <span className="badge">Following</span>
                  ) : (
                    <button
                      className="btn small"
                      disabled={!!cloning}
                      onClick={() => clone(r.cloneUrl, r.account)}
                    >
                      {cloning === r.cloneUrl ? (
                        <LoaderCircle size={13} className="spin" />
                      ) : (
                        <CloudDownload size={13} />
                      )}
                      Clone
                    </button>
                  )}
                </div>
              )
            })}
            {result && !visible.length && <div className="empty-state">No repository matches.</div>}
            {result?.truncated && (
              <div className="empty-state">
                Only your most recently active repositories are listed: paste a link for the others.
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}
