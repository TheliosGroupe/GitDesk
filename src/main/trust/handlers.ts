import type { HandlersOf } from '../../shared/api'
import type { TrustApi } from '../../shared/features/trust'
import { emit } from '../events'
import { requireRepo } from '../store'
import { installTrustPolicy, trustRepo, trustStatusOf, untrustRepo } from './policy'

// Loaded with the IPC handlers, before any repository command runs: from here on every
// git command follows the repository's trust.
installTrustPolicy()

/** IPC handlers for repository trust. */
export const trustHandlers: HandlersOf<TrustApi> = {
  trustStatus: (repo) => trustStatusOf(requireRepo(repo)),
  trustRepo: (repo) => {
    const path = requireRepo(repo)
    const status = trustRepo(path)
    emit('trust:changed', { repo: path })
    return status
  },
  untrustRepo: (repo) => {
    const path = requireRepo(repo)
    const status = untrustRepo(path)
    emit('trust:changed', { repo: path })
    return status
  }
}
