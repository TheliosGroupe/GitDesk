// Cloning from any provider, one repository or a whole organization, and workspaces.

import { existsSync, readdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import type {
  HostedRepo,
  HostedReposResult,
  HostingOrg,
  OrgCloneResult
} from '../../shared/features/hosting'
import type { AppState, Workspace } from '../../shared/types'
import { accountForSlug, allAuth, gitAuthFor } from '../accounts'
import { emit } from '../events'
import * as repoOps from '../repo'
import { findStoredPath } from '../paths'
import { addRepos, loadState, saveState } from '../store'
import { markCreatedByGitDesk } from '../trust/policy'
import {
  accountLabel,
  accountMatches,
  clientOf,
  forgetRemoteIndex,
  knownHosts,
  originRef,
  requireAuth
} from './context'
import { cloneFolders, normalizeCloneInput, sameRepo, type RemoteRef } from './remote'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The account to clone with: the one asked for (if it belongs to that host), else the first that fits. */
async function cloneAccount(
  ref: RemoteRef | null,
  requested: string | null
): Promise<string | null> {
  if (requested) {
    const auth = requireAuth(requested)
    if (!ref || !accountMatches(auth, ref))
      throw new Error(
        `${accountLabel(auth)} is not an account for ${ref ? ref.host : 'this link'}.`
      )
    return requested
  }
  if (!ref?.provider) return null
  if (ref.provider === 'github' && ref.host === 'github.com') return accountForSlug(ref.slug)
  return allAuth().find((a) => accountMatches(a, ref))?.account.id ?? null
}

export type ProgressFn = (phase: string, percent: number | null) => void

/** Clones running now, so Cancel can stop them. */
const clones = new Set<AbortController>()

/** Stops every clone running now; returns how many were stopped. */
export function cancelClones(): number {
  const running = [...clones]
  for (const c of running) c.abort()
  return running.length
}

/** Removes a cancelled clone: the folder, or its contents when it existed (empty) before. */
function removeClone(target: string, existed: boolean): void {
  const rm = (p: string): void => rmSync(p, { recursive: true, force: true, maxRetries: 5 })
  try {
    if (!existed) rm(target)
    else for (const name of readdirSync(target)) rm(join(target, name))
  } catch (e) {
    console.error(`GitDesk: could not remove the cancelled clone in ${target}:`, e)
  }
}

/**
 * Clones into <clone folder>/<slug segments> and follows the repository with its
 * account (only when the account belongs to the repository's host).
 */
export async function cloneInto(
  input: string,
  requested: string | null,
  onProgress: ProgressFn
): Promise<{ state: AppState; path: string }> {
  if (typeof input !== 'string') throw new Error('Paste a repository link.')
  const { url, ref } = normalizeCloneInput(input, knownHosts())
  const accountId = await cloneAccount(
    ref,
    typeof requested === 'string' && requested ? requested : null
  )
  const target = resolve(loadState().settings.cloneRoot, ...cloneFolders(ref, url))

  if (existsSync(resolve(target, '.git'))) {
    // Already cloned (for example by an earlier attempt): follow it if it is the same repository.
    const existing = await originRef(target).catch(() => null)
    if (ref && existing && sameRepo(existing, ref)) return follow(target, accountId)
    throw new Error(`${target} already contains another repository.`)
  }
  const existed = existsSync(target)
  if (existed && readdirSync(target).length) throw new Error(`${target} is not empty.`)

  const controller = new AbortController()
  clones.add(controller)
  try {
    await repoOps.clone(url, target, gitAuthFor(accountId), onProgress, controller.signal)
  } catch (e) {
    // A stopped git cannot remove what it had written (on Windows it is killed): clean up,
    // so the next attempt does not find a half-cloned folder.
    if (controller.signal.aborted) removeClone(target, existed)
    throw e
  } finally {
    clones.delete(controller)
  }
  // GitDesk made this repository: its own settings are GitDesk's (git clone writes them).
  // Not for an existing folder followed above: that one is inspected like any other.
  markCreatedByGitDesk(target)
  forgetRemoteIndex()
  return follow(target, accountId)
}

/**
 * Follows a cloned folder and returns the path as stored: addRepos keeps the canonical form
 * (a clone folder reached through a link or an 8.3 name), which the UI then finds in state.repos.
 */
function follow(target: string, accountId: string | null): { state: AppState; path: string } {
  const state = addRepos([target], accountId ?? undefined)
  return { state, path: findStoredPath(state.repos, target) ?? target }
}

// ---------------------------------------------------------------------------
// Repository lists
// ---------------------------------------------------------------------------

export async function hostedRepos(accountId: string | null): Promise<HostedReposResult> {
  const accounts = allAuth().filter((a) => !accountId || a.account.id === accountId)
  if (accountId && !accounts.length)
    throw new Error(`Not signed in to this account (${accountId}).`)
  const errors: HostedReposResult['errors'] = []
  let truncated = false
  const lists = await Promise.all(
    accounts.map(async (a) => {
      try {
        const r = await clientOf(a).repos(a.account.id)
        truncated ||= r.truncated
        return r.repos
      } catch (e) {
        errors.push({ account: a.account.id, error: message(e) })
        return []
      }
    })
  )
  const seen = new Set<string>()
  const repos = lists
    .flat()
    .filter((r) => {
      const k = `${r.host}|${String(r.fullName).toLowerCase()}`
      return !seen.has(k) && !!seen.add(k)
    })
    .sort((a, b) => String(b.pushedAt ?? '').localeCompare(String(a.pushedAt ?? '')))
  return { repos, errors, truncated }
}

export async function organizations(accountId: string): Promise<HostingOrg[]> {
  return clientOf(requireAuth(accountId)).orgs()
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/** Validates workspaces from the UI: ids unique, names set, only registered repositories. */
export function cleanWorkspaces(input: unknown, repos: string[]): Workspace[] {
  if (!Array.isArray(input)) throw new Error('Invalid workspaces')
  const ids = new Set<string>()
  return input.slice(0, 200).flatMap((w): Workspace[] => {
    if (!w || typeof w !== 'object') return []
    const { id, name } = w as Record<string, unknown>
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || ids.has(id)) return []
    const label = typeof name === 'string' ? name.trim().slice(0, 100) : ''
    if (!label) return []
    ids.add(id)
    const list = Array.isArray((w as Workspace).repos) ? (w as Workspace).repos : []
    const members = list.flatMap((p) => {
      const match = typeof p === 'string' && findStoredPath(repos, p)
      return match ? [match] : []
    })
    return [{ id, name: label, repos: [...new Set(members)] }]
  })
}

export function setWorkspaces(input: unknown): AppState {
  const state = loadState()
  return saveState({ ...state, workspaces: cleanWorkspaces(input, state.repos) })
}

function addToWorkspace(workspaceId: string | null, paths: string[]): AppState {
  const state = loadState()
  if (!workspaceId) return state
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId
      ? { ...w, repos: [...w.repos, ...paths.filter((p) => !findStoredPath(w.repos, p))] }
      : w
  )
  return saveState({ ...state, workspaces })
}

let orgCloneRunning = false

/** Clones every repository of an organization / group / workspace / project. */
export async function cloneOrganization(
  accountId: string,
  org: string,
  workspaceId: string | null
): Promise<OrgCloneResult> {
  const auth = requireAuth(accountId)
  if (typeof org !== 'string' || !org.trim() || org.length > 200)
    throw new Error('Pick an organization.')
  if (workspaceId !== null && !loadState().workspaces.some((w) => w.id === workspaceId))
    throw new Error('That workspace no longer exists.')
  if (orgCloneRunning) throw new Error('An organization is already being cloned.')
  orgCloneRunning = true
  try {
    const list: HostedRepo[] = await clientOf(auth).orgRepos(org.trim(), accountId)
    const result: Omit<OrgCloneResult, 'state'> = { cloned: [], skipped: [], failed: [] }
    const paths: string[] = []
    const progress = (
      done: number,
      current: string | null,
      phase: string | null,
      percent: number | null
    ): void =>
      emit('hosting:org-clone-progress', {
        accountId,
        org,
        total: list.length,
        done,
        current,
        phase,
        percent
      })
    for (const [i, r] of list.entries()) {
      progress(i, r.fullName, null, null)
      try {
        const before = loadState().repos.length
        const { path } = await cloneInto(r.cloneUrl, accountId, (phase, percent) =>
          progress(i, r.fullName, phase, percent)
        )
        paths.push(path)
        // cloneInto follows an existing clone instead of cloning again.
        if (loadState().repos.length === before) result.skipped.push(r.fullName)
        else result.cloned.push(r.fullName)
      } catch (e) {
        const text = message(e)
        if (/already contains another repository|is not empty/.test(text))
          result.skipped.push(r.fullName)
        else result.failed.push({ repo: r.fullName, error: text })
      }
    }
    progress(list.length, null, null, null)
    return { ...result, state: addToWorkspace(workspaceId, paths) }
  } finally {
    orgCloneRunning = false
  }
}
