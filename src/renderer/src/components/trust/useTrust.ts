import { useCallback, useEffect, useState } from 'react'
import type { TrustStatus } from '../../../../shared/features/trust'

// Kept apart from the components so their files only export components (React fast refresh).

/** The trust state of one repository, kept current (trust changes, files changed, focus). */
export function useTrustStatus(repo: string): [TrustStatus | null, (s: TrustStatus) => void] {
  const [status, setStatus] = useState<TrustStatus | null>(null)
  const load = useCallback(() => {
    window.api.trustStatus(repo).then(setStatus, () => setStatus(null))
  }, [repo])
  useEffect(() => {
    load()
    const offTrust = window.api.on('trust:changed', (e) => e.repo === repo && load())
    const offRepo = window.api.onRepoChanged((changed) => changed === repo && load())
    window.addEventListener('focus', load)
    return () => {
      offTrust()
      offRepo()
      window.removeEventListener('focus', load)
    }
  }, [repo, load])
  return [status, setStatus]
}
