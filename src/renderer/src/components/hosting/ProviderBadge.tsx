import {
  PROVIDER_LABELS,
  type HostingProvider,
  type IssueTracker
} from '../../../../shared/features/hosting'
import '../../assets/hosting.css'

const ABBREVIATIONS: Record<HostingProvider | IssueTracker, string> = {
  github: 'GH',
  gitlab: 'GL',
  bitbucket: 'BB',
  azure: 'AZ',
  jira: 'JI',
  linear: 'LI'
}

/** Small colored mark for a hosting provider or issue tracker. */
export function ProviderBadge({
  source,
  size = 16
}: {
  source: HostingProvider | IssueTracker
  size?: number
}): React.JSX.Element {
  return (
    <span
      className={`provider-badge provider-${source}`}
      title={PROVIDER_LABELS[source]}
      aria-label={PROVIDER_LABELS[source]}
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.5) }}
    >
      {ABBREVIATIONS[source]}
    </span>
  )
}
