// Issue trackers: Jira Cloud (site + email + API token) and Linear (personal API key).
// Credentials are encrypted with the OS key store like account tokens.

import { app, safeStorage } from 'electron'
import { join } from 'path'
import type {
  Issue,
  IssueTracker,
  IssueTrackerConfig,
  IssueTrackers
} from '../../shared/features/hosting'
import { requireSecureStorage } from '../secureStorage'
import { readJsonStore, writeJsonAtomic } from '../store'
import { Api, apiOverride, basic, unix } from './http'
import { normalizeHost } from './identity'
import { link, list, nonEmpty, obj, str, TITLE_MAX, userName } from './validate'

interface Stored {
  jira?: { site: string; email: string; user: string | null; token: string }
  linear?: { user: string | null; token: string }
}

let stored: Stored | null = null

function file(): string {
  return join(app.getPath('userData'), 'integrations.json')
}

function load(): Stored {
  if (stored) return stored
  try {
    const raw = readJsonStore(file(), {})
    stored = {}
    // Checked again here, so a file written with an odd value heals on the next start.
    const j = obj(obj(raw).jira)
    const site = typeof j.site === 'string' ? jiraSiteOrNull(j.site) : null
    const email = nonEmpty(j.email, 320)
    if (site && email && nonEmpty(j.token, 100_000))
      stored.jira = { site, email, user: userName(j.user), token: j.token as string }
    const l = obj(obj(raw).linear)
    if (nonEmpty(l.token, 100_000))
      stored.linear = { user: userName(l.user), token: l.token as string }
  } catch {
    stored = {}
  }
  return stored
}

function save(): void {
  writeJsonAtomic(file(), load())
}

const encrypt = (secret: string): string => {
  requireSecureStorage()
  return safeStorage.encryptString(secret).toString('base64')
}
const decrypt = (value: string): string | null => {
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return null
  }
}

export function trackers(): IssueTrackers {
  const s = load()
  return {
    jira: s.jira ? { site: s.jira.site, email: s.jira.email, user: s.jira.user } : null,
    linear: s.linear ? { user: s.linear.user } : null
  }
}

// ---------------------------------------------------------------------------
// Jira Cloud
// ---------------------------------------------------------------------------

/** "acme.atlassian.net", "https://acme.atlassian.net/jira/…" -> "https://acme.atlassian.net". */
export function normalizeJiraSite(input: string): string {
  const text = input.trim()
  if (/^http:\/\//i.test(text)) throw new Error('Use the https:// address of your Jira site.')
  const host = normalizeHost(text)
  if (!host) throw new Error('Enter your Jira site, e.g. your-company.atlassian.net.')
  return `https://${host}`
}

function jiraSiteOrNull(site: string): string | null {
  try {
    return normalizeJiraSite(site)
  } catch {
    return null
  }
}

/** An issue or project key ("PROJ-12", "ENG"): letters, digits, "_" and "-". */
const issueKey = (v: unknown): string | null =>
  typeof v === 'string' && /^[\w-]{1,100}$/.test(v) ? v : null

/** An issue of the search, or null without a key or a summary. */
export function mapJiraIssue(raw: unknown, site: string): Issue | null {
  const i = obj(raw)
  const key = issueKey(i.key)
  const fields = obj(i.fields)
  const title = str(fields.summary, TITLE_MAX)
  if (!key || title === null) return null
  const assignee = obj(fields.assignee)
  return {
    source: 'jira',
    key,
    number: null,
    title,
    state: str(obj(fields.status).name, 100) ?? '',
    url: `${site}/browse/${encodeURIComponent(key)}`,
    assignee: userName(assignee.displayName),
    assigneeAvatar: link(obj(assignee.avatarUrls)['48x48']),
    container: issueKey(obj(fields.project).key),
    updatedAt: unix(fields.updated)
  }
}

function jiraApi(site: string, email: string, token: string): { api: Api; base: string } {
  const host = site.replace(/^https:\/\//, '')
  const base = apiOverride(host) ?? site
  return { api: new Api(`Jira (${host})`, [base], { Authorization: basic(email, token) }), base }
}

const JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'

async function jiraIssuesWith(site: string, email: string, token: string): Promise<Issue[]> {
  const { api, base } = jiraApi(site, email, token)
  const params = new URLSearchParams({
    jql: JQL,
    maxResults: '50',
    fields: 'summary,status,assignee,updated,project'
  })
  const r = obj(await api.json(`${base}/rest/api/3/search/jql?${params}`))
  return list(r.issues).flatMap((i) => mapJiraIssue(i, site) ?? [])
}

/** The display name of the Jira user the token belongs to (null when not a usable name). */
async function jiraUser(api: Api, base: string): Promise<string | null> {
  return userName(obj(await api.json(`${base}/rest/api/3/myself`)).displayName)
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

const linearUrl = (): string => `${apiOverride('linear.app') ?? 'https://api.linear.app'}/graphql`

/** The `data` of a Linear GraphQL answer (unchecked: read it with validate.ts). */
async function linear(apiKey: string, query: string): Promise<Record<string, unknown>> {
  const url = linearUrl()
  // Personal API keys go in Authorization as they are (no "Bearer").
  const api = new Api('Linear', [url], { Authorization: apiKey })
  const r = obj(await api.json(url, { method: 'POST', body: { query } }))
  if (!r.data || typeof r.data !== 'object') {
    const why = list(r.errors, 5)
      .map((e) => str(obj(e).message, 300) ?? '')
      .filter(Boolean)
      .join('; ')
    throw new Error(`Linear: ${why || 'error'}`)
  }
  return obj(r.data)
}

/** The name of the Linear user the key belongs to (null when not a usable name). */
const linearUser = async (apiKey: string): Promise<string | null> =>
  userName(obj((await linear(apiKey, 'query { viewer { id name } }')).viewer).name)

/** An assigned issue, or null without an identifier, a title or an https URL. */
export function mapLinearIssue(raw: unknown): Issue | null {
  const i = obj(raw)
  const key = issueKey(i.identifier)
  const title = str(i.title, TITLE_MAX)
  const url = link(i.url)
  if (!key || title === null || !url) return null
  const assignee = obj(i.assignee)
  return {
    source: 'linear',
    key,
    number: null,
    title,
    state: str(obj(i.state).name, 100) ?? '',
    url,
    assignee: userName(assignee.name),
    assigneeAvatar: link(assignee.avatarUrl),
    container: issueKey(obj(i.team).key),
    updatedAt: unix(i.updatedAt)
  }
}

export const LINEAR_ISSUES_QUERY = `query {
  viewer {
    assignedIssues(first: 50, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { identifier title url updatedAt state { name } assignee { name avatarUrl } team { key } }
    }
  }
}`

// ---------------------------------------------------------------------------

export async function configureTracker(config: IssueTrackerConfig): Promise<IssueTrackers> {
  const s = load()
  if (config?.kind === 'jira') {
    const site = normalizeJiraSite(String(config.site ?? ''))
    const email = String(config.email ?? '').trim()
    const token = String(config.token ?? '').trim()
    if (!/^[^\s@]+@[^\s@]+$/.test(email))
      throw new Error('Enter the email of your Atlassian account.')
    if (!token || /\s/.test(token)) throw new Error('Paste the API token.')
    const { api, base } = jiraApi(site, email, token)
    s.jira = { site, email, user: await jiraUser(api, base), token: encrypt(token) }
  } else if (config?.kind === 'linear') {
    const key = String(config.apiKey ?? '').trim()
    if (!key || /\s/.test(key)) throw new Error('Paste the personal API key.')
    s.linear = { user: await linearUser(key), token: encrypt(key) }
  } else {
    throw new Error('Unknown issue tracker.')
  }
  save()
  return trackers()
}

export async function testTracker(kind: IssueTracker): Promise<string> {
  const s = load()
  if (kind === 'jira' && s.jira) {
    const token = decrypt(s.jira.token)
    if (!token) throw new Error('The saved Jira token could not be read. Connect again.')
    const { api, base } = jiraApi(s.jira.site, s.jira.email, token)
    const who = (await jiraUser(api, base)) ?? s.jira.email
    return `Connected to ${s.jira.site.replace(/^https:\/\//, '')} as ${who}`
  }
  if (kind === 'linear' && s.linear) {
    const token = decrypt(s.linear.token)
    if (!token) throw new Error('The saved Linear key could not be read. Connect again.')
    const who = await linearUser(token)
    return who ? `Connected to Linear as ${who}` : 'Connected to Linear'
  }
  throw new Error(`${kind === 'jira' ? 'Jira' : 'Linear'} is not connected.`)
}

export function removeTracker(kind: IssueTracker): IssueTrackers {
  const s = load()
  if (kind === 'jira') delete s.jira
  else if (kind === 'linear') delete s.linear
  save()
  return trackers()
}

/** Open issues assigned to me in Jira and Linear (those configured). */
export async function trackerIssues(): Promise<{ issues: Issue[]; errors: string[] }> {
  const s = load()
  const jobs: Promise<Issue[]>[] = []
  const names: string[] = []
  if (s.jira) {
    const { site, email } = s.jira
    const token = decrypt(s.jira.token)
    names.push('Jira')
    jobs.push(
      token ? jiraIssuesWith(site, email, token) : Promise.reject(new Error('token unreadable'))
    )
  }
  if (s.linear) {
    const token = decrypt(s.linear.token)
    names.push('Linear')
    jobs.push(
      token
        ? linear(token, LINEAR_ISSUES_QUERY).then((d) =>
            list(obj(obj(d.viewer).assignedIssues).nodes).flatMap((i) => mapLinearIssue(i) ?? [])
          )
        : Promise.reject(new Error('key unreadable'))
    )
  }
  const results = await Promise.allSettled(jobs)
  const issues: Issue[] = []
  const errors: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') issues.push(...r.value)
    else
      errors.push(`${names[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
  })
  return { issues, errors }
}
