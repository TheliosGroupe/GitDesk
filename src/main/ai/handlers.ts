import { netFetchManual } from '../netFetch'
import type { HandlersOf } from '../../shared/api'
import {
  AI_PROVIDERS,
  type AiApi,
  type AiCommitMessage,
  type AiConflictResult,
  type AiPullRequestText,
  type AiComposition,
  type AiExplainTarget,
  type AiExplanation,
  type AiProviderId,
  type AiStatus
} from '../../shared/features/ai'
import { repairPlan } from '../../shared/features/ai-patch'
import type { Settings } from '../../shared/types'
import { parseConflicts } from '../../renderer/src/lib/conflict'
import { emit } from '../events'
import { writeRepo } from '../queue'
import * as repo from '../repo'
import { loadState, requireRepo } from '../store'
import { track } from '../undo'
import { applyComposition, assertComposable, collectChanges } from './compose'
import {
  commitInfo,
  currentBranch,
  defaultBranch,
  diffStat,
  diffText,
  emptyTree,
  logRange,
  mergeBase,
  readUntracked,
  recentSubjects,
  refSubject,
  resolveCommit,
  untrackedDiff,
  untrackedFiles
} from './context'
import { explainKeyRejection, keyElsewhereMessage } from './keyBinding'
import { getKey, hasKey, isProvider, keyEndpoint, setKey } from './keys'
import {
  budgetDiff,
  commitMessagePrompt,
  composePrompt,
  conflictPrompt,
  explainPrompt,
  parseComposeAnswer,
  parseConflictAnswer,
  parseMessage,
  pullRequestPrompt,
  withheldPaths,
  type BudgetedDiff,
  type Prompt
} from './prompts'
import { isSecretPath, secretReason } from './secrets'
import {
  complete,
  DEFAULT_MODELS,
  endpointFor,
  modelFor,
  PROVIDER_NAMES,
  type FetchFn
} from './providers'

/** Requests that can be cancelled, by requestId. */
const running = new Map<string, AbortController>()
/** Ids cancelled before their request reached the provider (it was still reading git). */
const cancelledEarly = new Set<string>()

/** Never follows redirects itself: complete() checks each hop (see safeFetch.ts). */
const fetchFn: FetchFn = netFetchManual

/** The endpoint `provider` uses now: the base URL setting is the chosen provider's. */
function endpointOf(
  s: Settings,
  provider: AiProviderId
): { endpoint: string | null; error: string | null } {
  try {
    const baseUrl = provider === s.aiProvider ? s.aiBaseUrl : ''
    return { endpoint: endpointFor(provider, baseUrl), error: null }
  } catch (e) {
    return { endpoint: null, error: (e as Error).message }
  }
}

function status(): AiStatus {
  const s = loadState().settings
  const keyStored = Object.fromEntries(
    AI_PROVIDERS.map((p) => [p, hasKey(p, endpointOf(s, p).endpoint)])
  ) as Record<AiProviderId, boolean>
  if (s.aiProvider === 'none')
    return {
      provider: 'none',
      model: '',
      defaultModel: '',
      endpoint: '',
      endpointError: null,
      configured: false,
      keyStored,
      keySavedFor: null
    }
  const { endpoint, error } = endpointOf(s, s.aiProvider)
  const savedFor = keyEndpoint(s.aiProvider)
  return {
    provider: s.aiProvider,
    model: modelFor(s.aiProvider, s.aiModel),
    defaultModel: DEFAULT_MODELS[s.aiProvider],
    endpoint: endpoint ?? '',
    endpointError: error,
    configured: !!endpoint && (s.aiProvider === 'ollama' || keyStored[s.aiProvider]),
    keyStored,
    keySavedFor: savedFor && savedFor !== endpoint ? savedFor : null
  }
}

/** Streamed text is sent to the renderer at most this often (ms), in larger pieces. */
const CHUNK_INTERVAL = 50

interface Ask {
  prompt: Prompt
  requestId?: string
  effort?: 'low' | 'medium' | 'high'
  maxTokens?: number
}

async function ask({
  prompt,
  requestId,
  effort = 'medium',
  maxTokens = 16000
}: Ask): Promise<string> {
  const s = loadState().settings
  if (s.aiProvider === 'none') throw new Error('Choose an AI provider in Settings → AI first.')
  const provider = s.aiProvider
  const { endpoint, error } = endpointOf(s, provider)
  if (!endpoint) throw new Error(`${error} Check the base URL in Settings → AI.`)
  // The key goes only to the endpoint it was saved for.
  const apiKey = getKey(provider, endpoint)
  const elsewhere = keyElsewhereMessage(provider, keyEndpoint(provider), endpoint, apiKey)
  // A local server may need no key: try without, and explain if it asks for one.
  if (elsewhere && provider !== 'ollama') throw new Error(elsewhere)
  const id = typeof requestId === 'string' && requestId.length <= 100 ? requestId : null
  const controller = new AbortController()
  if (id) {
    if (cancelledEarly.delete(id)) throw new Error('Cancelled.')
    running.get(id)?.abort()
    running.set(id, controller)
  }
  // Chunks are batched: one IPC message (and one re-render) per interval, not per token.
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (id && pending) emit('ai:chunk', { requestId: id, text: pending })
    pending = ''
  }
  try {
    return await complete(fetchFn, {
      provider,
      model: s.aiModel,
      baseUrl: s.aiBaseUrl,
      apiKey,
      system: prompt.system,
      user: prompt.user,
      maxTokens,
      effort,
      signal: controller.signal,
      onText: id
        ? (text) => {
            pending += text
            timer ??= setTimeout(flush, CHUNK_INTERVAL)
          }
        : undefined
    })
  } catch (e) {
    throw explainKeyRejection(e, elsewhere)
  } finally {
    flush()
    if (id && running.get(id) === controller) running.delete(id)
  }
}

const COMMIT_BUDGET = { maxChars: 60_000, perFile: 12_000 }
const REVIEW_BUDGET = { maxChars: 90_000, perFile: 15_000 }

async function commitMessage(r: string, requestId?: string): Promise<AiCommitMessage> {
  let read = await diffText(r, ['--cached', '-M'])
  let diff = read.text
  let source: 'staged' | 'unstaged' = 'staged'
  let untracked: string[] = []
  if (!diff.trim() && !read.unread.length) {
    source = 'unstaged'
    read = await diffText(r, ['-M'])
    diff = read.text
    untracked = await untrackedFiles(r)
    // Secret-looking files are not even read: only their path reaches the prompt.
    for (const path of untracked.slice(0, 40))
      diff += untrackedDiff(path, isSecretPath(path) ? null : await readUntracked(r, path))
  }
  if (!diff.trim() && !read.unread.length) throw new Error('There are no changes to describe.')
  const [subjects, branch] = await Promise.all([recentSubjects(r), currentBranch(r)])
  const budgeted = budgetDiff(diff, COMMIT_BUDGET, read.unread)
  const text = await ask({
    prompt: commitMessagePrompt({
      diff: budgeted,
      recentSubjects: subjects,
      branch,
      source,
      untracked
    }),
    requestId,
    effort: 'low'
  })
  const { summary, description } = parseMessage(text)
  if (!summary) throw new Error('The model returned an empty message.')
  return {
    summary,
    description,
    source,
    truncated: budgeted.truncated,
    withheld: withheldPaths(budgeted)
  }
}

async function pullRequestText(
  r: string,
  base: string,
  head: string,
  requestId?: string
): Promise<AiPullRequestText> {
  const baseSha = await resolveCommit(r, base)
  const headSha = await resolveCommit(r, head)
  const from = await mergeBase(r, baseSha, headSha)
  const log = await logRange(r, `${from}..${headSha}`)
  if (!log) throw new Error(`${head} has no commits that are not in ${base}.`)
  const [stat, read] = await Promise.all([
    diffStat(r, from, headSha),
    diffText(r, ['-M', from, headSha])
  ])
  const diff = budgetDiff(read.text, REVIEW_BUDGET, read.unread)
  const text = await ask({
    prompt: pullRequestPrompt({ base, head, log, stat, diff }),
    requestId,
    effort: 'low'
  })
  const { summary, description } = parseMessage(text, 100)
  return { title: summary, body: description, withheld: withheldPaths(diff) }
}

async function explain(
  r: string,
  target: AiExplainTarget,
  requestId?: string
): Promise<AiExplanation> {
  let prompt: Prompt
  let diff: BudgetedDiff
  if (target?.kind === 'commit') {
    const info = await commitInfo(r, String(target.sha))
    // A root commit is diffed against the empty tree: same options and size cap as any diff.
    const from = info.parent ?? (await emptyTree(r))
    const [stat, read] = await Promise.all([
      diffStat(r, from, info.sha),
      diffText(r, ['-M', from, info.sha])
    ])
    diff = budgetDiff(read.text, REVIEW_BUDGET, read.unread)
    prompt = explainPrompt({ what: info.header, log: '', stat, diff })
  } else if (target?.kind === 'branch') {
    const branchSha = await resolveCommit(r, String(target.branch))
    const baseName = target.base ? String(target.base) : await defaultBranch(r)
    const baseSha = await resolveCommit(r, baseName)
    const from = await mergeBase(r, baseSha, branchSha)
    const log = await logRange(r, `${from}..${branchSha}`)
    if (!log) throw new Error(`${target.branch} has no commits that are not in ${baseName}.`)
    const [stat, read] = await Promise.all([
      diffStat(r, from, branchSha),
      diffText(r, ['-M', from, branchSha])
    ])
    diff = budgetDiff(read.text, REVIEW_BUDGET, read.unread)
    prompt = explainPrompt({
      what: `Branch ${target.branch}, compared with ${baseName} (from their merge-base).`,
      log,
      stat,
      diff
    })
  } else throw new Error('Nothing to explain')
  const text = (await ask({ prompt, requestId, effort: 'medium' })).trim()
  return { text, withheld: withheldPaths(diff) }
}

async function resolveConflictAi(
  r: string,
  path: string,
  requestId?: string
): Promise<AiConflictResult> {
  const file = await repo.readConflict(r, path)
  if (file.content === null) throw new Error(`${path} is not a text file: take one side instead.`)
  if (secretReason(path, file.content))
    throw new Error(
      `${path} looks like it holds secrets (keys, tokens or credentials): GitDesk does not send it to the AI. Resolve it here or in your editor.`
    )
  const segments = parseConflicts(file.content)
  if (!segments.some((s) => s.kind === 'conflict'))
    throw new Error('This file has no conflict markers left.')
  const operation = await repo.currentOperation(r)
  const incomingRef =
    operation === 'rebase'
      ? 'REBASE_HEAD'
      : operation === 'cherry-pick'
        ? 'CHERRY_PICK_HEAD'
        : operation === 'revert'
          ? 'REVERT_HEAD'
          : 'MERGE_HEAD'
  const [current, incoming] = await Promise.all([refSubject(r, 'HEAD'), refSubject(r, incomingRef)])
  const { prompt, sent } = conflictPrompt({ path, segments, operation, current, incoming })
  if (!sent.length) throw new Error('These conflicts are too large to send to the model.')
  const text = await ask({ prompt, requestId, effort: 'medium' })
  const result = parseConflictAnswer(text, sent)
  const total = segments.filter((s) => s.kind === 'conflict').length
  const missing = total - result.blocks.length
  const note = [
    result.note,
    missing > 0
      ? `No suggestion for ${missing} conflict${missing > 1 ? 's' : ''}${sent.length < total ? ' (too large to send)' : ''}.`
      : ''
  ]
    .filter(Boolean)
    .join(' ')
  return { blocks: result.blocks, note }
}

async function compose(r: string, requestId?: string): Promise<AiComposition> {
  await assertComposable(r)
  const changes = await collectChanges(r)
  if (!changes.set.units.length) throw new Error('There are no uncommitted changes.')
  const subjects = await recentSubjects(r)
  const { prompt, truncated, withheld } = composePrompt({
    units: changes.set.units,
    bodies: changes.bodies,
    recentSubjects: subjects
  })
  const text = await ask({ prompt, requestId, effort: 'medium' })
  const commits = repairPlan(parseComposeAnswer(text), changes.set.units)
  return {
    fingerprint: changes.fingerprint,
    units: changes.set.units,
    commits,
    level: changes.set.level === 'hunk' && changes.set.hunkOf.size ? 'hunk' : 'file',
    truncated,
    withheld
  }
}

/** IPC handlers for AI features with your own API key. */
export const aiHandlers: HandlersOf<AiApi> = {
  aiStatus: () => status(),
  aiSetKey: (provider, key) => {
    if (!isProvider(provider)) throw new Error('Unknown AI provider')
    // Bound to the endpoint the provider uses now: it is never sent anywhere else.
    const { endpoint, error } = endpointOf(loadState().settings, provider)
    if (key && !endpoint) throw new Error(`Fix the base URL first. ${error}`)
    setKey(provider, key, endpoint)
    const s = status()
    emit('ai:status', s)
    return s
  },
  aiTest: async () => {
    const s = status()
    if (s.provider === 'none') throw new Error('Choose an AI provider first.')
    const text = await ask({
      prompt: { system: 'You are a connection test. Reply with the single word OK.', user: 'Ping' },
      effort: 'low',
      maxTokens: 1024
    })
    void text
    return `Connected to ${s.provider === 'ollama' ? s.endpoint : PROVIDER_NAMES[s.provider]}: ${s.model} answered.`
  },
  aiCommitMessage: (path, requestId) => commitMessage(requireRepo(path), requestId),
  aiPullRequestText: (path, base, head, requestId) =>
    pullRequestText(requireRepo(path), base, head, requestId),
  aiExplain: (path, target, requestId) => explain(requireRepo(path), target, requestId),
  aiResolveConflict: (path, file, requestId) =>
    resolveConflictAi(requireRepo(path), file, requestId),
  aiComposeCommits: (path, requestId) => compose(requireRepo(path), requestId),
  aiApplyComposition: (path, plan) =>
    writeRepo(path, (r) =>
      track(
        r,
        {
          label: `Undo ${plan?.commits?.length ?? ''} composed commits`.replace('  ', ' '),
          undo: { kind: 'reset', mode: 'mixed' }
        },
        () => applyComposition(r, plan)
      )
    ),
  aiCancel: (requestId) => {
    if (typeof requestId !== 'string' || requestId.length > 100) return
    const controller = running.get(requestId)
    if (controller) {
      controller.abort()
      running.delete(requestId)
    } else {
      cancelledEarly.add(requestId)
      // Forget ids whose request never comes (it failed before reaching the provider).
      setTimeout(() => cancelledEarly.delete(requestId), 120_000)
    }
  }
}
