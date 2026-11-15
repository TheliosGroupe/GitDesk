// Which branch was created from which issue (for the pull request dialog).

import { app } from 'electron'
import { join } from 'path'
import type { IssueSource, LinkedIssue } from '../../shared/features/hosting'
import { readJsonStore, writeJsonAtomic } from '../store'

type Links = Record<string, Record<string, LinkedIssue>>

let links: Links | null = null
const SOURCES: IssueSource[] = ['github', 'gitlab', 'jira', 'linear']

function file(): string {
  return join(app.getPath('userData'), 'issue-links.json')
}

const key = (repo: string): string => (process.platform === 'win32' ? repo.toLowerCase() : repo)

function load(): Links {
  if (links) return links
  const raw = readJsonStore(file(), {})
  links = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Links) : {}
  return links!
}

/** Keeps only the fields of a LinkedIssue, with sane types (it comes from the UI). */
export function cleanIssue(issue: unknown): LinkedIssue {
  const i = (issue ?? {}) as Record<string, unknown>
  const source = SOURCES.includes(i.source as IssueSource) ? (i.source as IssueSource) : null
  const k = typeof i.key === 'string' ? i.key.trim().slice(0, 100) : ''
  const title = typeof i.title === 'string' ? i.title.slice(0, 500) : ''
  const url = typeof i.url === 'string' && /^https:\/\//.test(i.url) ? i.url.slice(0, 2000) : ''
  const number =
    typeof i.number === 'number' && Number.isInteger(i.number) && i.number > 0 ? i.number : null
  if (!source || !k) throw new Error('Invalid issue')
  return { source, key: k, number, title, url }
}

export function linkIssue(repo: string, branch: string, issue: LinkedIssue): void {
  const all = load()
  all[key(repo)] = { ...all[key(repo)], [branch]: issue }
  writeJsonAtomic(file(), all)
}

export function linkedIssue(repo: string, branch: string): LinkedIssue | null {
  const found = load()[key(repo)]?.[branch]
  if (!found) return null
  try {
    return cleanIssue(found)
  } catch {
    return null
  }
}
