import { ShieldAlert } from 'lucide-react'
import { useTrustStatus } from './useTrust'
import './trust.css'

/** A dashboard card's hint that GitDesk ignores (or did not open) the repository's settings. */
export function TrustBadge({ repo }: { repo: string }): React.JSX.Element | null {
  const [status] = useTrustStatus(repo)
  if (!status || (status.level !== 'untrusted' && status.level !== 'blocked')) return null
  const blocked = status.level === 'blocked'
  return (
    <span
      className={blocked ? 'badge trust-badge blocked' : 'badge trust-badge'}
      title={
        blocked
          ? 'GitDesk did not open this repository: its settings point to another computer. Open it to review them.'
          : "GitDesk ignores some of this repository's settings until you trust it. Open it to review them."
      }
    >
      <ShieldAlert size={11} /> {blocked ? 'not opened' : 'settings ignored'}
    </span>
  )
}
