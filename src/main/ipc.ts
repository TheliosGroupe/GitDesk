import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, statSync } from 'fs'
import { basename, join, resolve } from 'path'
import {
  API_METHODS,
  CLONE_PROGRESS_CHANNEL,
  type AppInfo,
  type CoreApi,
  type GitDeskApi,
  type HandlersOf,
  type KnownSnapshot
} from '../shared/api'
import { aiHandlers } from './ai/handlers'
import { emit } from './events'
import { gitExtrasHandlers } from './gitextras/handlers'
import { hostingHandlers } from './hosting/handlers'
import { isTrustedSender } from './ipcGuard'
import { trustHandlers } from './trust/handlers'
import { findRepoRoot } from './trust/inspect'
import { markCreatedByGitDesk, trustStatusOf } from './trust/policy'
import { terminalHandlers } from './terminal/handlers'
import { killTerminalsIn } from './terminal/pty'
import type { GitHubRepo } from '../shared/types'
import {
  cancelSignIn,
  finishSignIn,
  listAccounts,
  removeAccount,
  startSignIn,
  tokensInOrder
} from './accounts'
import { compactActivity, loadActivity } from './activity'
import { forgetMisses, resolveAvatars } from './avatars'
import { assertSha, cancelNetworkCommands, git, gitVersion, refreshIndexOnce } from './git'
import { listRepos } from './github'
import { cancelClones, cloneInto } from './hosting/clone'
import { forgetRemoteIndex } from './hosting/context'
import { forgetLaunchpad } from './hosting/launchpad'
import { checkoutPullRequestOf, pullRequestsOf } from './hosting/pulls'
import { findStoredPath, systemOpenAction } from './paths'
import { exclusive as queued } from './queue'
import * as repo from './repo'
import {
  accountFor,
  addRepos,
  loadState,
  removeRepo,
  requireRepo,
  saveState,
  updateSettings
} from './store'
import { fetchError, fetchRepo, scheduleSync, syncAll } from './sync'
import { actions, forget, track, trackContinue, undo, undoInfo, type UndoableAction } from './undo'
import { applyUpdateSetting, checkForUpdates, getUpdateStatus, installUpdate } from './updater'
import { unwatchRepo, watchRepo } from './watcher'

type Handlers = HandlersOf<CoreApi>

/** Write operation on a registered repository, queued behind other writes to it. */
function exclusive<T>(path: string, fn: (path: string) => Promise<T>): Promise<T> {
  const r = requireRepo(path)
  return queued(r, () => fn(r))
}

/** A queued write that "Undo" can take back (see undo.ts). */
function undoable<T>(
  path: string,
  action: UndoableAction,
  fn: (path: string) => Promise<T>
): Promise<T> {
  return exclusive(path, (r) => track(r, action, () => fn(r)))
}

/** A queued write that publishes to a remote: earlier local actions are no longer undoable. */
function pushing<T>(path: string, fn: (path: string) => Promise<T>): Promise<T> {
  return exclusive(path, async (r) => {
    try {
      return await fn(r)
    } finally {
      forget(r)
    }
  })
}

/**
 * Opens a path with the system's default application, unless that could run something
 * (programs, scripts, executables, app bundles, see openAction): those are shown in the
 * file manager instead. Returns false when the path was only shown.
 */
async function openWithSystem(target: string): Promise<boolean> {
  if (!existsSync(target)) throw new Error(`${target} does not exist`)
  if (systemOpenAction(target) === 'reveal') {
    shell.showItemInFolder(target)
    return false
  }
  const error = await shell.openPath(target)
  if (error) throw new Error(error)
  return true
}

/**
 * Opens one repository file in the chosen editor. With "system", only documents open;
 * anything that could run is shown in its folder instead, and the returned message says so.
 */
async function openRepoFile(target: string): Promise<string | null> {
  if (loadState().settings.editor === 'system') {
    if (await openWithSystem(target)) return null
    return statSync(target).isDirectory()
      ? null
      : `${basename(target)} is not a document GitDesk opens with the default app: shown in its folder instead.`
  }
  await openInEditor(target)
  return null
}

/** Opens a folder or a file in the editor chosen in Settings. */
async function openInEditor(target: string): Promise<void> {
  const editor = loadState().settings.editor
  if (editor === 'system') {
    await openWithSystem(target)
    return
  }
  await shell.openExternal(editorUrl(editor === 'cursor' ? 'cursor' : 'vscode', target))
}

/**
 * The link that opens an absolute path in VS Code or Cursor: vscode://file/C:/path on
 * Windows, vscode://file/Users/… elsewhere (one slash after "file"). Every name is
 * percent-encoded, so "#", "?", "%" or spaces stay part of the path; on Windows "\"
 * separates folders, elsewhere it is a character of the name. Exported for tests.
 */
export function editorUrl(
  editor: 'vscode' | 'cursor',
  target: string,
  windows = process.platform === 'win32'
): string {
  const names = (windows ? target.replace(/\\/g, '/') : target).split('/')
  const path = names
    .map((name, i) =>
      windows && i === 0 && /^[a-z]:$/i.test(name) ? name : encodeURIComponent(name)
    )
    .join('/')
  return `${editor}://file${path.startsWith('/') ? '' : '/'}${path}`
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux'
}

/** Versions for Settings → Updates and "Copy diagnostics": no path or name of yours. */
async function appInfo(): Promise<AppInfo> {
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chromium: process.versions.chrome ?? '',
    node: process.versions.node,
    os: OS_NAMES[process.platform] ?? process.platform,
    osVersion: process.getSystemVersion(),
    arch: process.arch,
    git: await gitVersion()
  }
}

/**
 * The licenses of the open-source code GitDesk ships (written by `npm run build`): next to
 * the app's resources once installed, in build/ while developing.
 */
async function openThirdPartyNotices(): Promise<boolean> {
  const file = app.isPackaged
    ? join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt')
    : join(app.getAppPath(), 'build', 'THIRD_PARTY_NOTICES.txt')
  if (!existsSync(file)) return false
  const error = await shell.openPath(file)
  if (error) throw new Error(error)
  return true
}

function parentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

async function pickFolder(title: string): Promise<string | null> {
  const win = parentWindow()
  const options = { title, properties: ['openDirectory' as const, 'createDirectory' as const] }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
}

async function addRepoInteractive(): Promise<ReturnType<GitDeskApi['addRepo']>> {
  const folder = await pickFolder('Open a repository')
  if (!folder) return loadState()
  try {
    return addRepos([await repo.toplevel(folder)])
  } catch {
    // git does not run at all in a repository whose settings point to another computer,
    // so it cannot say where it starts: follow it anyway, so its banner (with the reason
    // and the Trust button) shows.
    if (trustStatusOf(folder, true).level === 'blocked')
      return addRepos([findRepoRoot(folder) ?? resolve(folder)])
    const win = parentWindow()
    const options = {
      type: 'question' as const,
      message: 'This folder is not a git repository.',
      detail: folder,
      buttons: ['Initialize a repository here', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    }
    const answer = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    if (answer.response !== 0) return loadState()
    // `git init` on an existing .git re-initializes it and keeps its settings: GitDesk
    // would then trust a repository it did not create.
    if (existsSync(join(folder, '.git')))
      throw new Error(
        `${folder} already has a .git entry that git cannot use as a repository: GitDesk did not initialize over it.`
      )
    await git(folder, ['init'])
    const created = await repo.toplevel(folder)
    markCreatedByGitDesk(created)
    return addRepos([created])
  }
}

async function scanFolderInteractive(): Promise<ReturnType<GitDeskApi['scanFolder']>> {
  const folder = await pickFolder('Find repositories in a folder')
  if (!folder) return loadState()
  const found = await repo.findRepos(folder)
  if (!found.length) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'No git repositories found in this folder.',
      detail: folder
    })
    return loadState()
  }
  return addRepos(found)
}

async function cloneInteractive(
  input: string,
  account: string | null
): Promise<ReturnType<GitDeskApi['cloneRepo']>> {
  // Any provider: see hosting/clone.ts. The account's token is only offered to its own host.
  return cloneInto(input, account, (phase, percent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CLONE_PROGRESS_CHANNEL, { url: input, phase, percent })
    }
  })
}

/** GitHub (github.com) repositories of one or every account; other providers: hostingRepos. */
async function githubReposFor(login: string | null): Promise<GitHubRepo[]> {
  const accounts = tokensInOrder(null).filter((a) => !login || a.login === login)
  const lists = await Promise.all(accounts.map((a) => listRepos(a.token, a.login)))
  const seen = new Set<string>()
  return lists
    .flat()
    .filter((r) => !seen.has(r.fullName.toLowerCase()) && seen.add(r.fullName.toLowerCase()))
    .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))
}

function validAuthors(authors: unknown): { email: string; sha: string }[] {
  if (!Array.isArray(authors)) return []
  return authors
    .slice(0, 500)
    .filter((a) => a && typeof a.email === 'string' && typeof a.sha === 'string')
    .filter((a) => {
      try {
        assertSha(a.sha)
        return true
      } catch {
        return false
      }
    })
}

/** The keys the repository view sends back: only strings count, anything else means none. */
function validKnown(known: unknown): KnownSnapshot | null {
  if (!known || typeof known !== 'object') return null
  const k = known as Record<string, unknown>
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  return { refsKey: text(k.refsKey), logKey: text(k.logKey), stashKey: text(k.stashKey) }
}

const coreHandlers: Handlers = {
  getState: () => loadState(),
  setTabs: (openTabs, activeTab) => {
    saveState({ ...loadState(), openTabs, activeTab })
  },
  addRepo: () => addRepoInteractive(),
  scanFolder: () => scanFolderInteractive(),
  removeRepo: (path) => {
    const registered =
      typeof path === 'string' ? findStoredPath(loadState().repos, path) : undefined
    if (registered) {
      // Its terminals (and agents) would otherwise keep running in a folder GitDesk forgot.
      killTerminalsIn(registered)
      unwatchRepo(registered)
      forget(registered)
      repo.forgetRepo(registered)
    }
    return removeRepo(path)
  },
  summary: async (path) => {
    const r = requireRepo(path)
    return { ...(await repo.summary(r)), account: accountFor(r), fetchError: fetchError(r) }
  },
  setSettings: (patch) => {
    const allowed = [
      'githubClientId',
      'cloneRoot',
      'fetchIntervalMinutes',
      'showAvatars',
      'useGravatar',
      'theme',
      'editor',
      'autoUpdate',
      'aiProvider',
      'aiModel',
      'aiBaseUrl',
      'agentCommands',
      'worktreeRoot',
      'terminalShell',
      'branchColors'
    ]
    const clean = Object.fromEntries(
      Object.entries(patch ?? {}).filter(([k]) => allowed.includes(k))
    )
    const provider = (clean.aiProvider ?? loadState().settings.aiProvider) as string
    if (provider === 'anthropic' && ('aiProvider' in clean || 'aiBaseUrl' in clean))
      clean.aiBaseUrl = ''
    const state = updateSettings(clean)
    if ('fetchIntervalMinutes' in clean) scheduleSync()
    // Turned on: checks now, then every few hours (off already stops at the next check).
    if ('autoUpdate' in clean) applyUpdateSetting(state.settings.autoUpdate)
    // Other windows show whether the saved key still fits the provider and address.
    if (Object.keys(clean).some((k) => k.startsWith('ai')))
      void Promise.resolve(aiHandlers.aiStatus()).then(
        (s) => emit('ai:status', s),
        () => undefined
      )
    return state
  },
  pickCloneRoot: async () => {
    const folder = await pickFolder('Folder for cloned repositories')
    return folder ? updateSettings({ cloneRoot: folder }) : loadState()
  },

  accounts: () => listAccounts(),
  githubStartSignIn: () => startSignIn(loadState().settings.githubClientId),
  githubFinishSignIn: async () => {
    const account = await finishSignIn()
    forgetMisses() // pictures of private repositories are now reachable
    return account
  },
  githubCancelSignIn: () => cancelSignIn(),
  githubSignOut: (accountId) => {
    // Any provider's account. Its repositories fall back to your usual git credentials.
    const state = loadState()
    const repoAccounts = Object.fromEntries(
      Object.entries(state.repoAccounts).filter(([, id]) => id !== accountId)
    )
    saveState({ ...state, repoAccounts })
    forgetLaunchpad()
    forgetRemoteIndex()
    return removeAccount(accountId)
  },
  githubRepos: (login) => githubReposFor(login),
  cloneRepo: (url, account) => cloneInteractive(url, account),
  cancelClone: () => cancelClones(),
  syncNow: (repos) => syncAll(true, Array.isArray(repos) ? repos : undefined),
  avatars: async (path, authors) => {
    const r = requireRepo(path)
    const settings = loadState().settings
    const slug = await repo.originSlug(r)
    return resolveAvatars(validAuthors(authors), {
      slug,
      tokens: tokensInOrder(accountFor(r)).map((a) => a.token),
      useGravatar: settings.useGravatar
    })
  },
  activity: async (days) => compactActivity(await loadActivity(Number(days) || 30)),
  pushCommits: (path, before, after) => repo.pushCommits(requireRepo(path), before, after),
  openGitHub: async (path) => {
    if (typeof path !== 'string' || !/^[\w./?=&%-]*$/.test(path))
      throw new Error('Invalid GitHub path')
    await shell.openExternal(`https://github.com/${path}`)
  },

  log: (path, limit) => repo.log(requireRepo(path), limit),
  snapshot: (path, limit, known) => repo.snapshot(requireRepo(path), limit, validKnown(known)),
  logPage: (path, skip, count, refsKey) =>
    repo.logPage(requireRepo(path), skip, count, typeof refsKey === 'string' ? refsKey : ''),
  refs: (path) => repo.refs(requireRepo(path)),
  status: (path) => repo.status(requireRepo(path)),
  stashes: (path) => repo.stashes(requireRepo(path)),
  commitDetails: (path, sha) => repo.commitDetails(requireRepo(path), sha),
  diff: (path, target) => repo.diff(requireRepo(path), target),
  lastCommitMessage: (path) => repo.lastCommitMessage(requireRepo(path)),

  stage: (path, paths) => exclusive(path, (r) => repo.stage(r, paths)),
  unstage: (path, paths) => exclusive(path, (r) => repo.unstage(r, paths)),
  discard: (path, files) => exclusive(path, (r) => repo.discard(r, files)),
  applyPatch: (path, patch, opts) => exclusive(path, (r) => repo.applyPatch(r, patch, opts)),
  commit: (path, message, amend) =>
    undoable(path, actions.commit(!!amend), (r) => repo.commit(r, message, amend)),

  checkout: (path, ref) =>
    undoable(path, actions.checkout(String(ref)), (r) => repo.checkout(r, ref)),
  checkoutRemote: (path, rb) =>
    undoable(path, actions.checkout(String(rb)), (r) => repo.checkoutRemote(r, rb)),
  createBranch: (path, name, start, co) =>
    undoable(path, actions.refs(`Undo create branch ${name}`), (r) =>
      repo.createBranch(r, name, start, co)
    ),
  deleteBranch: (path, name, force) =>
    undoable(path, actions.refs(`Undo delete branch ${name}`), (r) =>
      repo.deleteBranch(r, name, force)
    ),
  renameBranch: (path, from, to) =>
    undoable(path, actions.rename(from, to), (r) => repo.renameBranch(r, from, to)),
  merge: (path, ref) =>
    undoable(path, actions.history(`Undo merge of ${actions.short(String(ref))}`), (r) =>
      repo.merge(r, ref)
    ),
  abortOperation: (path) =>
    exclusive(path, async (r) => {
      forget(r)
      await repo.abortOperation(r)
    }),
  continueOperation: (path) =>
    exclusive(path, (r) => trackContinue(r, () => repo.continueOperation(r))),
  cherryPick: (path, sha) =>
    undoable(path, actions.history(`Undo cherry-pick of ${actions.short(String(sha))}`), (r) =>
      repo.cherryPick(r, sha)
    ),
  revert: (path, sha) =>
    undoable(path, actions.history(`Undo revert of ${actions.short(String(sha))}`), (r) =>
      repo.revert(r, sha)
    ),
  reset: (path, sha, mode) =>
    undoable(path, actions.reset(String(sha), mode), (r) => repo.reset(r, sha, mode)),
  createTag: (path, name, sha) =>
    undoable(path, actions.refs(`Undo create tag ${name}`), (r) => repo.createTag(r, name, sha)),
  deleteTag: (path, name) =>
    undoable(path, actions.refs(`Undo delete tag ${name}`), (r) => repo.deleteTag(r, name)),

  fetch: (path) => fetchRepo(requireRepo(path)),
  pull: (path, mode) => undoable(path, actions.history('Undo pull'), (r) => repo.pull(r, mode)),
  // What was pushed can no longer be undone locally without diverging from the remote.
  push: (path, force, seen) => pushing(path, (r) => repo.push(r, force, seen)),
  // Not queued: it stops the command the queue is waiting for.
  cancelNetwork: (path) => cancelNetworkCommands(requireRepo(path)),

  stash: (path, message) => exclusive(path, (r) => repo.stash(r, message)),
  stashApply: (path, index, drop, sha) =>
    exclusive(path, (r) => repo.stashApply(r, index, drop, sha)),
  stashDrop: (path, index, sha) => exclusive(path, (r) => repo.stashDrop(r, index, sha)),

  pushTag: (path, name) => pushing(path, (r) => repo.pushTag(r, name)),
  deleteRemoteTag: (path, name) => pushing(path, (r) => repo.deleteRemoteTag(r, name)),
  deleteRemoteBranch: (path, fullName, expected) =>
    pushing(path, (r) => repo.deleteRemoteBranch(r, fullName, expected)),

  searchCommits: (path, query, field, limit) =>
    repo.searchCommits(requireRepo(path), query, field, limit),
  fileHistory: (path, file, limit) => repo.fileHistory(requireRepo(path), file, limit),
  blame: (path, file, sha) => repo.blame(requireRepo(path), file, sha ?? null),

  readConflict: (path, file) => repo.readConflict(requireRepo(path), file),
  resolveConflict: (path, file, content) =>
    exclusive(path, (r) => repo.resolveConflict(r, file, content)),
  markResolved: (path, file) => exclusive(path, (r) => repo.markResolved(r, file)),
  resolveConflictSide: (path, file, side) =>
    exclusive(path, (r) => repo.resolveConflictSide(r, file, side)),

  rebase: (path, onto) =>
    undoable(path, actions.history(`Undo rebase onto ${actions.short(String(onto))}`), (r) =>
      repo.rebase(r, onto)
    ),
  rebaseCommits: (path, base) => repo.rebaseCommits(requireRepo(path), base),
  rebaseInteractive: (path, base, steps) =>
    undoable(path, actions.history('Undo interactive rebase'), (r) =>
      repo.rebaseInteractive(r, base, steps)
    ),
  undoInfo: (path) => undoInfo(requireRepo(path)),
  undo: (path) => exclusive(path, (r) => undo(r)),

  pullRequests: (path) => pullRequestsOf(requireRepo(path)),
  checkoutPullRequest: (path, number) =>
    undoable(path, actions.checkout(`pull request #${Number(number)}`), (r) =>
      checkoutPullRequestOf(r, number)
    ),

  updateStatus: () => getUpdateStatus(),
  checkForUpdates: () => checkForUpdates(),
  installUpdate: () => installUpdate(),
  appInfo: () => appInfo(),
  openThirdPartyNotices: () => openThirdPartyNotices(),

  // On macOS a folder is shown in Finder rather than opened: an app bundle would launch.
  openFolder: async (path) => {
    await openWithSystem(requireRepo(path))
  },
  openInEditor: (path) => openInEditor(requireRepo(path)),
  openFile: (path, file) => openRepoFile(repo.repoFile(requireRepo(path), file)),

  showFile: (path, file) => {
    const full = repo.repoFile(requireRepo(path), file)
    if (!existsSync(full)) throw new Error(`${file} does not exist`)
    shell.showItemInFolder(full)
  },
  ignorePath: (path, pattern) => exclusive(path, (r) => repo.ignorePath(r, pattern)),
  watch: (path) => {
    const r = requireRepo(path)
    watchRepo(r)
    // Once per repository and session, in its write queue (it takes the index lock):
    // GitDesk's own status never refreshes stale stat data, so it would hash every
    // touched file again on each refresh.
    void queued(r, () => refreshIndexOnce(r)).catch(() => undefined)
  },
  unwatch: (path) => unwatchRepo(requireRepo(path))
}

const handlers: HandlersOf<GitDeskApi> = {
  ...coreHandlers,
  ...terminalHandlers,
  ...gitExtrasHandlers,
  ...aiHandlers,
  ...hostingHandlers,
  ...trustHandlers
}

export function registerIpc(): void {
  for (const name of API_METHODS) {
    const handler = handlers[name] as (...args: unknown[]) => unknown
    ipcMain.handle(`api:${name}`, (event, ...args: unknown[]) => {
      if (!isTrustedSender(event))
        throw new Error('Refused: this request does not come from GitDesk')
      return handler(...args)
    })
  }
}
