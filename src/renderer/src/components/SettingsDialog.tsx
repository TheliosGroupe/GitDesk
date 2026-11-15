import {
  Bot,
  Check,
  CircleArrowUp,
  ClipboardCopy,
  FileText,
  FolderOpen,
  LoaderCircle,
  Monitor,
  Moon,
  Palette,
  Plug,
  Settings2,
  Sparkles,
  Sun
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { diagnosticsText, type AppInfo } from '../../../shared/api'
import type {
  Account,
  AppState,
  EditorChoice,
  Settings,
  Theme,
  UpdateStatus
} from '../../../shared/types'
import { errorMessage } from '../lib/format'
import { editorName, isWindows } from '../lib/platform'
import { AiSettings } from './ai/AiSettings'
import { BranchColorsSettings } from './BranchColorsSettings'
import { OAuthAppSteps } from './GitHub'
import { IntegrationsSettings } from './hosting/IntegrationsSettings'
import { AgentSettings } from './terminal/AgentSettings'
import { Modal } from './ui'

const INTERVALS = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'Every minute' },
  { value: 5, label: 'Every 5 minutes' },
  { value: 15, label: 'Every 15 minutes' },
  { value: 30, label: 'Every 30 minutes' },
  { value: 60, label: 'Every hour' }
]

const THEMES: { value: Theme; label: string; icon: React.JSX.Element }[] = [
  { value: 'dark', label: 'Dark', icon: <Moon size={14} /> },
  { value: 'light', label: 'Light', icon: <Sun size={14} /> },
  { value: 'system', label: 'System', icon: <Monitor size={14} /> }
]

const EDITORS: EditorChoice[] = ['vscode', 'cursor', 'system']

const SECTIONS = [
  { id: 'general', label: 'General', icon: <Settings2 size={15} /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={15} /> },
  { id: 'integrations', label: 'Accounts & integrations', icon: <Plug size={15} /> },
  { id: 'ai', label: 'AI', icon: <Sparkles size={15} /> },
  { id: 'agents', label: 'Terminal & agents', icon: <Bot size={15} /> },
  { id: 'updates', label: 'Updates', icon: <CircleArrowUp size={15} /> }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

function updateText(status: UpdateStatus | null): string {
  if (!status) return ''
  switch (status.state) {
    case 'idle':
      return ''
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Version ${status.version ?? ''} is available.`.replace('  ', ' ')
    case 'downloading':
      return `Downloading${status.version ? ` v${status.version}` : ''}… ${Math.round(status.percent ?? 0)}%`
    case 'ready':
      return `Version ${status.version ?? ''} is downloaded and ready to install.`
    case 'none':
      return 'GitDesk is up to date.'
    case 'disabled':
      return 'Updates are disabled in development builds.'
    case 'error':
      return `Could not check for updates${status.error ? `: ${status.error}` : '.'}`
  }
}

export function SettingsDialog({
  state,
  accounts,
  onAccounts,
  onChange,
  onClose
}: {
  state: AppState
  accounts: Account[]
  onAccounts(accounts: Account[]): void
  onChange(state: AppState): void
  onClose(): void
}): React.JSX.Element {
  const settings = state.settings
  const [clientId, setClientId] = useState(settings.githubClientId)
  const [showSteps, setShowSteps] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [aboutNote, setAboutNote] = useState<{ text: string; error?: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const [current, setCurrent] = useState<SectionId>('general')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api.updateStatus().then(setUpdate, () => {})
    window.api.appInfo().then(setInfo, () => {})
    return window.api.onUpdateStatus(setUpdate)
  }, [])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  // The navigation follows the section at the top of the scrolled content.
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onScroll = (): void => {
      const top = root.getBoundingClientRect().top
      let visible: SectionId = SECTIONS[0].id
      for (const { id } of SECTIONS) {
        const el = root.querySelector(`[data-section="${id}"]`)
        if (el && el.getBoundingClientRect().top - top <= 48) visible = id
      }
      // Scrolled to the end: the last section is the one being read.
      if (root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2)
        visible = SECTIONS[SECTIONS.length - 1].id
      setCurrent(visible)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [])

  const jump = (id: SectionId): void => {
    scrollRef.current
      ?.querySelector(`[data-section="${id}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setCurrent(id)
  }

  const save = async (patch: Partial<Settings>): Promise<void> => {
    onChange(await window.api.setSettings(patch))
  }

  const checkNow = async (): Promise<void> => {
    setUpdate({ state: 'checking' })
    try {
      setUpdate(await window.api.checkForUpdates())
    } catch (e) {
      setUpdate({ state: 'error', error: errorMessage(e) })
    }
  }

  // Versions only (diagnosticsText): nothing that names a folder, a repository or an account.
  const copyDiagnostics = async (): Promise<void> => {
    try {
      const facts = info ?? (await window.api.appInfo())
      setInfo(facts)
      await navigator.clipboard.writeText(diagnosticsText(facts))
      setAboutNote(null)
      setCopied(true)
    } catch (e) {
      setAboutNote({ text: `Could not copy the diagnostics: ${errorMessage(e)}`, error: true })
    }
  }

  const openNotices = async (): Promise<void> => {
    try {
      const opened = await window.api.openThirdPartyNotices()
      setAboutNote(
        opened
          ? null
          : { text: 'The license notices are generated by npm run build: none in this build yet.' }
      )
    } catch (e) {
      setAboutNote({ text: `Could not open the license notices: ${errorMessage(e)}`, error: true })
    }
  }

  const busy = update?.state === 'checking' || update?.state === 'downloading'
  const sep = isWindows ? '\\' : '/'
  const heading = (id: SectionId): React.JSX.Element => (
    <h2 className="settings-heading">{SECTIONS.find((s) => s.id === id)?.label}</h2>
  )

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              className={current === section.id ? 'settings-nav-item active' : 'settings-nav-item'}
              aria-current={current === section.id ? 'true' : undefined}
              onClick={() => jump(section.id)}
            >
              {section.icon}
              <span>{section.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-content" ref={scrollRef}>
          <section className="settings-section" data-section="general">
            {heading('general')}
            <div className="field">
              <label htmlFor="settings-editor">Open in editor</label>
              <select
                id="settings-editor"
                className="input"
                value={settings.editor}
                onChange={(e) => save({ editor: e.target.value as EditorChoice })}
              >
                {EDITORS.map((editor) => (
                  <option key={editor} value={editor}>
                    {editor === 'system' ? 'System default app' : editorName(editor)}
                  </option>
                ))}
              </select>
              <span className="help">
                Used by “Open in {editorName(settings.editor)}” on projects and files.
              </span>
            </div>

            <div className="field">
              <label htmlFor="settings-clone-root">Clone folder</label>
              <div className="field-row">
                <input
                  id="settings-clone-root"
                  className="input"
                  value={settings.cloneRoot}
                  readOnly
                />
                <button
                  className="btn"
                  onClick={async () => onChange(await window.api.pickCloneRoot())}
                >
                  <FolderOpen size={14} /> Change…
                </button>
              </div>
              <span className="help">
                Repositories cloned from GitHub go to {`<folder>${sep}<owner>${sep}<repository>`}.
              </span>
            </div>

            <div className="field">
              <label htmlFor="settings-interval">Fetch followed repositories</label>
              <select
                id="settings-interval"
                className="input"
                value={settings.fetchIntervalMinutes}
                onChange={(e) => save({ fetchIntervalMinutes: Number(e.target.value) })}
              >
                {INTERVALS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </select>
              <span className="help">
                Repositories cloned through GitDesk are fetched in the background, so the dashboard
                shows new commits from GitHub. Your files are never changed by this.
              </span>
            </div>
          </section>

          <section className="settings-section" data-section="appearance">
            {heading('appearance')}
            <div className="field">
              <span className="field-label" id="settings-theme">
                Theme
              </span>
              <div
                className="segmented text theme-choice"
                role="radiogroup"
                aria-labelledby="settings-theme"
              >
                {THEMES.map((t) => (
                  <button
                    key={t.value}
                    role="radio"
                    aria-checked={settings.theme === t.value}
                    className={settings.theme === t.value ? 'active' : ''}
                    onClick={() => save({ theme: t.value })}
                  >
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>
              {settings.theme === 'system' && (
                <span className="help">
                  Follows the light or dark mode of your operating system.
                </span>
              )}
            </div>
            <span className="field-label">Profile pictures</span>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.showAvatars}
                onChange={(e) => save({ showAvatars: e.target.checked })}
              />
              Show authors’ pictures in the commit graph
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.useGravatar}
                onChange={(e) => save({ useGravatar: e.target.checked })}
              />
              <span>
                Look up authors without a GitHub picture on Gravatar
                <span className="help"> (sends a hash of their email address to gravatar.com)</span>
              </span>
            </label>
            <h3 className="settings-subheading">Branch colors</h3>
            <BranchColorsSettings settings={settings} onChange={onChange} />
          </section>

          <section className="settings-section" data-section="integrations">
            {heading('integrations')}
            <div className="field">
              <label htmlFor="settings-client-id">GitHub OAuth App Client ID</label>
              <div className="field-row">
                <input
                  id="settings-client-id"
                  className="input mono"
                  value={clientId}
                  placeholder="Needed for “Sign in with GitHub”"
                  onChange={(e) => setClientId(e.target.value)}
                  onBlur={() =>
                    clientId.trim() !== settings.githubClientId &&
                    save({ githubClientId: clientId })
                  }
                />
                <button className="btn" onClick={() => setShowSteps(!showSteps)}>
                  {showSteps ? 'Hide steps' : 'How to get one'}
                </button>
              </div>
              {showSteps && <OAuthAppSteps />}
            </div>
            <IntegrationsSettings
              state={state}
              accounts={accounts}
              onAccounts={onAccounts}
              onChange={onChange}
            />
          </section>

          <section className="settings-section" data-section="ai">
            {heading('ai')}
            <AiSettings settings={settings} onChange={onChange} />
          </section>

          <section className="settings-section" data-section="agents">
            {heading('agents')}
            <AgentSettings settings={settings} onChange={onChange} />
          </section>

          <section className="settings-section" data-section="updates">
            {heading('updates')}
            <div className="about-row">
              <span className="about-version">{info ? `GitDesk v${info.version}` : 'GitDesk'}</span>
              <button className="btn" onClick={copyDiagnostics}>
                {copied ? <Check size={14} /> : <ClipboardCopy size={14} />}
                {copied ? 'Copied' : 'Copy diagnostics'}
              </button>
              <button className="btn" onClick={openNotices}>
                <FileText size={14} /> Third-party licenses
              </button>
            </div>
            <span
              className={aboutNote?.error ? 'help about-note error-text' : 'help about-note'}
              role="status"
              aria-live="polite"
            >
              {aboutNote?.text ??
                'Copy diagnostics copies the versions of GitDesk, your system and git for a bug report: no folder, repository or account name.'}
            </span>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.autoUpdate}
                onChange={(e) => save({ autoUpdate: e.target.checked })}
              />
              Check for updates automatically
            </label>
            <div className="update-row">
              <button
                className="btn"
                onClick={checkNow}
                disabled={busy || update?.state === 'disabled'}
              >
                {busy && <LoaderCircle size={14} className="spin" />} Check now
              </button>
              {update?.state === 'available' && (
                // Downloads it where this build installs itself, else opens the release page.
                <button className="btn primary" onClick={() => window.api.installUpdate()}>
                  Get{update.version ? ` v${update.version}` : ' the update'}
                </button>
              )}
              {update?.state === 'ready' && (
                <button className="btn primary" onClick={() => window.api.installUpdate()}>
                  Restart to install{update.version ? ` v${update.version}` : ''}
                </button>
              )}
              <span
                className={update?.state === 'error' ? 'help error-text' : 'help'}
                role="status"
                aria-live="polite"
              >
                {updateText(update)}
              </span>
            </div>
          </section>
        </div>
      </div>

      <div className="modal-actions">
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}
