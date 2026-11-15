import { noteChanged } from './repo'
import { requireRepo } from './store'

// Write operations on the same repository run one at a time, so two git
// commands (yours, or a background fetch) never race for .git/index.lock.
const queues = new Map<string, Promise<unknown>>()

export function exclusive<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(repo) ?? Promise.resolve()
  // Once it ends, a refresh that started before it is out of date (repo.recentSnapshot).
  const next = previous
    .catch(() => undefined)
    .then(fn)
    .finally(() => noteChanged(repo))
  queues.set(repo, next)
  return next
}

/** Write operation on a registered repository, queued behind other writes to it. */
export function writeRepo<T>(path: unknown, fn: (repo: string) => Promise<T>): Promise<T> {
  const repo = requireRepo(path)
  return exclusive(repo, () => fn(repo))
}
