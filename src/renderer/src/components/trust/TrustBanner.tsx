import { ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type { TrustFinding } from '../../../../shared/features/trust'
import { errorMessage } from '../../lib/format'
import { useDialogs, useToasts } from '../ui-context'
import { useTrustStatus } from './useTrust'
import './trust.css'

/** Findings shown before "Show all". */
const FIRST = 4

const label = (f: TrustFinding): string => (f.submodule ? `${f.submodule}: ${f.key}` : f.key)

/**
 * Says which of the repository's own settings GitDesk ignores (or why it did not open
 * it) and offers to trust it. Nothing when the repository is clean or trusted.
 */
export function TrustBanner({
  repo,
  onChanged
}: {
  repo: string
  onChanged(): void
}): React.JSX.Element | null {
  const dialogs = useDialogs()
  const toasts = useToasts()
  const [status, setStatus] = useTrustStatus(repo)
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!status || (status.level !== 'untrusted' && status.level !== 'blocked')) return null
  const blocked = status.level === 'blocked'
  // One line per setting, even when a file sets it twice.
  const findings = status.findings.filter(
    (f, i, list) => list.findIndex((o) => label(o) === label(f) && o.value === f.value) === i
  )
  const shown = all ? findings : findings.slice(0, FIRST)

  const trust = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: 'Trust this repository?',
      message: blocked ? (
        <>
          Git will then read files from the other computer its settings name, which signs in to it
          with your account, and use all of this repository&apos;s own settings, which can run
          programs on your computer as you. Only trust a repository whose source you know.
        </>
      ) : (
        <>
          Git will then use all of this repository&apos;s own settings, including the ones listed,
          and they can run programs on your computer as you. Only trust a repository whose source
          you know.
        </>
      ),
      okLabel: 'Trust',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    try {
      setStatus(await window.api.trustRepo(repo))
      toasts.info("GitDesk now uses this repository's settings")
      onChanged()
    } catch (e) {
      toasts.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={blocked ? 'banner warning trust-banner blocked' : 'banner warning trust-banner'}
      role="status"
    >
      <ShieldAlert size={16} />
      <div className="trust-banner-body">
        <strong>
          {blocked
            ? 'GitDesk did not open this repository'
            : "GitDesk is ignoring some of this repository's settings"}
        </strong>
        <div>
          {blocked
            ? 'Its settings point to files on another computer: reading them would connect ' +
              'to that computer and sign in with your account.'
            : 'GitDesk did not clone or create this repository, and these settings could run ' +
              'programs on your computer. Until you trust it, git runs without them.'}
          {status.networkPaused &&
            !blocked &&
            ' Fetch, pull and push are paused, and Git LFS files are not downloaded.'}
        </div>
        <ul className="trust-findings">
          {shown.map((f) => (
            <li key={`${label(f)}=${f.value}`}>
              {f.text} <code title={f.file}>{label(f)}</code>
            </li>
          ))}
        </ul>
        <div className="banner-actions">
          {findings.length > FIRST && (
            <button className="btn small" onClick={() => setAll((v) => !v)}>
              {all ? 'Show fewer' : `Show all ${findings.length}`}
            </button>
          )}
          <button className="btn small" disabled={busy} onClick={trust}>
            Trust this repository…
          </button>
        </div>
      </div>
    </div>
  )
}
