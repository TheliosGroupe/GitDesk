// Agent sessions: a task given to a coding-agent CLI working in its own branch + worktree.

import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  AGENT_LABELS,
  DEFAULT_AGENT_COMMANDS,
  taskSlug,
  type AgentInfo,
  type AgentSessionInfo,
  type EndAgentSessionOptions,
  type EndAgentSessionResult,
  type StartAgentOptions
} from '../../shared/features/terminal'
import type { AgentKind, AgentSession, AppState } from '../../shared/types'
import { emit } from '../events'
import { assertBranchName, assertSafeRef, git, runGit } from '../git'
import { findSamePath, findStoredPath } from '../paths'
import { exclusive } from '../queue'
import { addRepos, loadState, removeRepo, requireRepo, saveState } from '../store'
import { buildAgentArgv, tokenizeCommand, uniqueName } from './argv'
import { killSessionTerminals, sessionTerminal, spawnTerminal } from './pty'
import { findExecutable, launchPlan, userPath } from './resolve'
import {
  branchExists,
  changeCount,
  currentBranch,
  defaultWorktreePath,
  gitAddWorktree,
  listWorktrees,
  registerWorktree,
  removeWorktree
} from './worktrees'

const WINDOWS = process.platform === 'win32'
const KINDS: AgentKind[] = ['claude', 'codex', 'gemini', 'copilot', 'opencode', 'custom']
const MAX_TASK = 20_000
/** git config key remembering where an agent branch started: branch.<name>.gitdeskBase. */
const BASE_KEY = 'gitdeskBase'

const INSTALL_HINTS: Record<AgentKind, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  gemini: 'npm install -g @google/gemini-cli',
  copilot: 'npm install -g @github/copilot',
  opencode: 'npm install -g opencode-ai',
  custom: 'Set its command line in Settings › Agents.'
}

function commandFor(kind: AgentKind): string {
  return loadState().settings.agentCommands[kind] ?? DEFAULT_AGENT_COMMANDS[kind]
}

function requireKind(kind: unknown): AgentKind {
  if (typeof kind !== 'string' || !KINDS.includes(kind as AgentKind))
    throw new Error('Unknown agent')
  return kind as AgentKind
}

export async function detectAgents(): Promise<AgentInfo[]> {
  const path = await userPath()
  return KINDS.map((kind) => {
    const command = commandFor(kind)
    let program: string | undefined
    try {
      program = tokenizeCommand(command, WINDOWS)[0]
    } catch {
      program = undefined
    }
    const resolved = program ? findExecutable(program, path) : null
    return {
      kind,
      label: AGENT_LABELS[kind],
      command,
      defaultCommand: DEFAULT_AGENT_COMMANDS[kind],
      resolved,
      installHint: INSTALL_HINTS[kind]
    }
  })
}

async function uniqueBranch(repo: string, task: string): Promise<string> {
  const base = `agent/${taskSlug(task)}`
  const names = new Set(
    (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']))
      .split('\n')
      .map((s) => s.trim().toLowerCase())
  )
  return uniqueName(base, (n) => names.has(n.toLowerCase()))
}

export async function agentBranchName(repoArg: unknown, task: unknown): Promise<string> {
  const repo = requireRepo(repoArg)
  return uniqueBranch(repo, typeof task === 'string' ? task : '')
}

/**
 * Starts the agent program in a terminal. Safety: the program and its arguments go to
 * node-pty as an argv array (POSIX) or a command line quoted argument by argument
 * (Windows); no shell ever parses the task. A Windows `.cmd` that is not an npm shim
 * would make cmd.exe parse the arguments, so the task is then not passed: it is saved
 * to a file and the terminal says where.
 */
async function launchAgent(session: AgentSession, resume: boolean): Promise<string> {
  const kind = session.agent
  const label = AGENT_LABELS[kind]
  const command = commandFor(kind)
  const base = {
    cwd: session.worktree,
    cols: 100,
    rows: 30,
    title: label,
    kind: 'agent' as const,
    sessionId: session.id,
    env: { GITDESK_AGENT_TASK: session.task, GITDESK_AGENT_SESSION: session.id }
  }
  const missing = async (messages: string[]): Promise<string> =>
    (await spawnTerminal({ ...base, file: null, args: [], messages })).id

  if (!command.trim()) {
    return missing([
      `No command is configured for ${label}.`,
      'Set its command line in Settings › Agents, then press Resume.'
    ])
  }
  let argv: string[]
  try {
    argv = buildAgentArgv(kind, command, resume ? null : session.task, WINDOWS)
  } catch (e) {
    return missing([`The ${label} command is not valid: ${(e as Error).message}`])
  }
  const path = await userPath()
  const program = findExecutable(argv[0], path)
  if (!program) {
    return missing([
      `"${argv[0]}" was not found${/[\\/]/.test(argv[0]) ? '' : ' on PATH'}.`,
      kind === 'custom'
        ? 'Set the command line of your agent in Settings › Agents (a program on PATH or an absolute path), then press Resume.'
        : `Install ${label} (${INSTALL_HINTS[kind]}), or set its command in Settings › Agents, then press Resume.`,
      'The session, its branch and its worktree are ready.'
    ])
  }

  const messages: string[] = []
  let plan = launchPlan(program, argv.slice(1), path)
  if (!plan && !resume) {
    // The task cannot reach this batch file intact: start without it, keep it in a file.
    const dir = join(app.getPath('userData'), 'agent-tasks')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${session.id}.md`)
    writeFileSync(file, session.task)
    const safe = argv.slice(1).filter((a) => a !== session.task)
    plan = launchPlan(program, safe, path)
    messages.push(
      `${program} is a batch file: the task cannot be passed to it safely, so it was saved to`,
      `  ${file}`,
      'Paste it into the agent (Ctrl+Shift+V), or set the agent command to its .exe in Settings › Agents.'
    )
  }
  if (!plan) return missing([`${program} cannot be started safely with these arguments.`])
  const info = await spawnTerminal({
    ...base,
    file: plan.file,
    args: plan.args,
    env: { ...base.env, PATH: path },
    messages
  })
  return info.id
}

function findSession(id: unknown): AgentSession {
  const s = typeof id === 'string' ? loadState().agentSessions.find((x) => x.id === id) : null
  if (!s) throw new Error('This agent session no longer exists')
  return s
}

export async function startAgentSession(
  options: StartAgentOptions
): Promise<{ session: AgentSession; state: AppState; terminalId: string }> {
  if (!options || typeof options !== 'object') throw new Error('Options missing')
  const repo = requireRepo(options.repo)
  const agent = requireKind(options.agent)
  const task = typeof options.task === 'string' ? options.task.trim() : ''
  if (!task) throw new Error('Describe the task for the agent')
  if (task.length > MAX_TASK) throw new Error(`The task is too long (${MAX_TASK} characters max)`)
  if (agent === 'custom' && !commandFor('custom').trim())
    throw new Error('Set the command of the custom agent in Settings › Agents first')

  let baseRef = typeof options.baseRef === 'string' ? options.baseRef.trim() : ''
  if (baseRef) assertSafeRef(baseRef)
  else baseRef = (await currentBranch(repo)) ?? ''
  if (!baseRef) {
    const head = await runGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      okCodes: [0, 1]
    })
    baseRef = head.stdout.trim()
  }
  if (!baseRef) throw new Error('The repository has no commits yet')
  const resolvedBase = await runGit(
    repo,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`],
    { okCodes: [0, 1] }
  )
  if (resolvedBase.exitCode !== 0) throw new Error(`"${baseRef}" is not a commit or branch`)

  let branch = typeof options.branch === 'string' ? options.branch.trim() : ''
  if (branch) {
    await assertBranchName(repo, branch)
    if (await branchExists(repo, branch)) throw new Error(`Branch ${branch} already exists`)
  }

  const worktree = await exclusive(repo, async () => {
    if (!branch) branch = await uniqueBranch(repo, task)
    const path = await defaultWorktreePath(repo, branch)
    await gitAddWorktree(repo, path, branch, true, baseRef)
    await git(repo, ['config', `branch.${branch}.${BASE_KEY}`, baseRef])
    return path
  })

  let state = await registerWorktree(repo, worktree)
  const stored = findStoredPath(state.repos, worktree) ?? worktree
  const session: AgentSession = {
    id: randomUUID(),
    repo,
    worktree: stored,
    branch,
    agent,
    task,
    createdAt: Math.floor(Date.now() / 1000)
  }
  state = saveState({ ...state, agentSessions: [...state.agentSessions, session] })
  const terminalId = await launchAgent(session, false)
  emit('agents:changed', null)
  return { session, state, terminalId }
}

async function sessionInfo(s: AgentSession): Promise<AgentSessionInfo> {
  const term = sessionTerminal(s.id)
  const info: AgentSessionInfo = {
    ...s,
    base: null,
    terminalId: term?.id ?? null,
    running: !!term?.running,
    worktreeExists: existsSync(s.worktree),
    branchExists: false,
    ahead: 0,
    behind: 0,
    changes: null,
    lastCommit: null
  }
  const cwd = existsSync(s.repo) ? s.repo : info.worktreeExists ? s.worktree : null
  if (!cwd) return info
  try {
    info.branchExists = await branchExists(cwd, s.branch)
    const base = await runGit(cwd, ['config', '--get', `branch.${s.branch}.${BASE_KEY}`], {
      okCodes: [0, 1]
    })
    const baseName = base.stdout.trim()
    info.base = baseName && !baseName.startsWith('-') ? baseName : null
    if (info.branchExists) {
      const last = await git(cwd, ['log', '-1', '--format=%s', `refs/heads/${s.branch}`, '--'])
      info.lastCommit = last.trim() || null
      if (info.base) {
        const counts = await runGit(
          cwd,
          ['rev-list', '--left-right', '--count', `${info.base}...refs/heads/${s.branch}`, '--'],
          { okCodes: [0, 128] }
        )
        const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number)
        info.behind = behind || 0
        info.ahead = ahead || 0
      }
    }
    if (info.worktreeExists) info.changes = await changeCount(s.worktree)
  } catch {
    // Partial information is fine for a status card.
  }
  return info
}

export async function agentSessions(): Promise<AgentSessionInfo[]> {
  return Promise.all(loadState().agentSessions.map(sessionInfo))
}

export async function resumeAgentSession(id: unknown): Promise<{ terminalId: string }> {
  const session = findSession(id)
  const current = sessionTerminal(session.id)
  if (current?.running) return { terminalId: current.id }
  if (!existsSync(session.worktree)) throw new Error(`${session.worktree} no longer exists`)
  // Removed from the repository list meanwhile: register it again (terminals need that).
  const state = loadState()
  if (!findStoredPath(state.repos, session.worktree)) {
    if (findStoredPath(state.repos, session.repo))
      await registerWorktree(session.repo, session.worktree)
    else addRepos([session.worktree])
  }
  const terminalId = await launchAgent(session, true)
  emit('agents:changed', null)
  return { terminalId }
}

/**
 * Commits of the branch that no other place keeps: 0 when its tip is in its base, in the
 * repository's HEAD or in its upstream; null when that cannot be told (base unknown or gone).
 */
async function unmergedCommits(
  repo: string,
  branch: string,
  base: string | null
): Promise<number | null> {
  const tip = `refs/heads/${branch}`
  const resolves = async (ref: string): Promise<boolean> =>
    (
      await runGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        okCodes: [0, 1, 128]
      })
    ).exitCode === 0
  const baseOk = !!base && !base.startsWith('-') && (await resolves(base))
  const targets = [...(baseOk ? [base!] : []), 'HEAD', `${tip}@{upstream}`]
  for (const target of targets) {
    if (!(await resolves(target))) continue
    const r = await runGit(repo, ['merge-base', '--is-ancestor', tip, target], {
      okCodes: [0, 1, 128]
    })
    if (r.exitCode === 0) return 0
  }
  if (!baseOk) return null
  const count = await runGit(repo, ['rev-list', '--count', tip, '--not', base!, '--'], {
    okCodes: [0, 128]
  })
  const n = Number(count.stdout.trim())
  return count.exitCode === 0 && Number.isFinite(n) ? n : null
}

export async function endAgentSession(
  id: unknown,
  options: EndAgentSessionOptions
): Promise<EndAgentSessionResult> {
  const session = findSession(id)
  const removeWt = !!options?.removeWorktree
  const deleteBranch = !!options?.deleteBranch
  const discardChanges = options?.discardChanges === true
  const discardUnmerged = options?.discardUnmerged === true
  if (removeWt || deleteBranch) {
    const repo = requireRepo(session.repo)
    // Nothing is lost without an explicit confirmation: check everything before changing anything.
    const changes =
      removeWt && existsSync(session.worktree) ? await changeCount(session.worktree) : 0
    const hasBranch = deleteBranch && (await branchExists(repo, session.branch))
    if (hasBranch) assertSafeRef(session.branch)
    const base = hasBranch
      ? (
          await runGit(repo, ['config', '--get', `branch.${session.branch}.${BASE_KEY}`], {
            okCodes: [0, 1]
          })
        ).stdout.trim() || null
      : null
    const unmerged = hasBranch ? await unmergedCommits(repo, session.branch, base) : 0
    const blockChanges = !discardChanges && changes !== 0
    const blockBranch = !discardUnmerged && unmerged !== 0
    if (blockChanges || blockBranch)
      return {
        ended: false,
        changes: blockChanges ? changes : 0,
        unmergedCommits: blockBranch ? unmerged : 0,
        base
      }

    killSessionTerminals(session.id)
    if (removeWt) {
      const worktrees = (await listWorktrees(repo)).map((w) => w.path)
      const listed = findSamePath(worktrees, session.worktree) !== undefined
      if (listed) {
        await removeWorktree(repo, session.worktree, discardChanges)
      } else {
        await exclusive(repo, () => git(repo, ['worktree', 'prune']))
        const registered = findStoredPath(loadState().repos, session.worktree)
        if (registered) removeRepo(registered)
      }
    }
    if (hasBranch) {
      await exclusive(repo, async () => {
        // -d lets git check again; its check (HEAD or upstream) does not know the base, so a
        // branch verified above as contained in its base still needs -D.
        if (discardUnmerged || unmerged === 0) {
          const safe = await runGit(repo, ['branch', '-d', '--', session.branch], {
            okCodes: [0, 1]
          })
          if (safe.exitCode !== 0) await git(repo, ['branch', '-D', '--', session.branch])
        } else {
          await git(repo, ['branch', '-d', '--', session.branch])
        }
      })
    }
  } else {
    killSessionTerminals(session.id)
  }
  const state = loadState()
  const next = saveState({
    ...state,
    agentSessions: state.agentSessions.filter((s) => s.id !== session.id)
  })
  emit('agents:changed', null)
  return { ended: true, state: next }
}
