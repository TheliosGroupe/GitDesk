import { History, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LineHistoryEntry } from '../../../../shared/features/gitextras'
import '../../assets/gitextras.css'
import { parseDiff } from '../../lib/diff'
import { errorMessage, fullDate, relativeTime, shortSha } from '../../lib/format'
import {
  highlightHunk,
  hunksHaveHiddenChars,
  languageFor,
  MAX_HIGHLIGHT_LINES
} from '../../lib/highlight'
import { CodeText, HiddenCharsBanner, Isolated, UnifiedHunk } from '../DiffView'
import { useEscape } from '../ui-context'

interface Props {
  repo: string
  path: string
  startLine: number
  endLine: number
  onClose(): void
  onSelectSha(sha: string): void
}

const LIMIT = 200

/** One commit of the line history and its diff of the range, read-only. */
function Entry({
  entry,
  path,
  onSelectSha
}: {
  entry: LineHistoryEntry
  path: string
  onSelectSha(sha: string): void
}): React.JSX.Element {
  const { commit } = entry
  const parsed = useMemo(() => parseDiff(entry.patch), [entry.patch])
  const language = languageFor(path)
  const html = useMemo(() => {
    const total = parsed.hunks.reduce((n, h) => n + h.lines.length, 0)
    if (!language || total > MAX_HIGHLIGHT_LINES) return null
    return parsed.hunks.map((h) => highlightHunk(h, language))
  }, [parsed, language])
  const renamed = parsed.header
    .find((l) => l.startsWith('--- a/'))
    ?.slice(6)
    .replace(/\t$/, '')
  return (
    <section className="lh-entry">
      <button
        className="lh-commit"
        onClick={() => onSelectSha(commit.sha)}
        title={`${commit.subject}\n${commit.author}, ${fullDate(commit.date)}\nShow this commit`}
      >
        <span className="lh-subject">
          <CodeText text={commit.subject} />
        </span>
        <span className="lh-author">{commit.author}</span>
        <span className="lh-date">{relativeTime(commit.date)}</span>
        <span className="lh-sha mono">{shortSha(commit.sha)}</span>
      </button>
      {renamed && renamed !== path && (
        <div className="lh-note muted">
          as <Isolated text={renamed} />
        </div>
      )}
      <div className="lh-diff diff-body">
        {parsed.hunks.length === 0 ? (
          <div className="lh-note muted">No line changes shown for this commit.</div>
        ) : (
          parsed.hunks.map((hunk, i) => (
            <div className="hunk" key={i}>
              <div className="hunk-header">
                <code>
                  <CodeText text={hunk.header} />
                </code>
              </div>
              <UnifiedHunk hunk={hunk} html={html?.[i] ?? null} picker={null} />
            </div>
          ))
        )}
      </div>
    </section>
  )
}

/** `git log -L`: every commit that changed a range of lines, with its diff of that range. */
export function LineHistoryView({
  repo,
  path,
  startLine,
  endLine,
  onClose,
  onSelectSha
}: Props): React.JSX.Element {
  const key = `${repo}\0${path}\0${startLine}\0${endLine}`
  const [result, setResult] = useState<{
    key: string
    entries: LineHistoryEntry[] | null
    error: string | null
  }>()
  const rootRef = useRef<HTMLDivElement>(null)
  useEscape(rootRef, onClose)

  useEffect(() => {
    let cancelled = false
    window.api.lineHistory(repo, path, startLine, endLine, LIMIT).then(
      (entries) => !cancelled && setResult({ key, entries, error: null }),
      (e) => !cancelled && setResult({ key, entries: null, error: errorMessage(e) })
    )
    return () => {
      cancelled = true
    }
  }, [repo, path, startLine, endLine, key])

  const current = result?.key === key ? result : undefined
  const entries = current?.entries ?? null
  const range = startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}–${endLine}`
  // Hidden or bidirectional characters anywhere in the shown diffs (as in the diff view).
  const hidden = useMemo(
    () => !!entries?.some((e) => hunksHaveHiddenChars(parseDiff(e.patch).hunks)),
    [entries]
  )

  return (
    <div className="line-history" ref={rootRef} data-escape>
      <div className="diff-header">
        <History size={15} className="muted" />
        <span className="lh-title">
          {range} of{' '}
          <span className="diff-path">
            <CodeText text={path} />
          </span>
        </span>
        {entries && (
          <span className="diff-context">
            {entries.length >= LIMIT ? `${LIMIT}+` : entries.length} commit
            {entries.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="spacer" />
        <button
          className="icon-btn"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close line history"
        >
          <X size={16} />
        </button>
      </div>
      {hidden && <HiddenCharsBanner />}
      <div className="lh-body">
        {current?.error && <div className="empty-state error">{current.error}</div>}
        {!current && <div className="empty-state">Loading line history…</div>}
        {entries && entries.length === 0 && (
          <div className="empty-state">No commit changed these lines.</div>
        )}
        {entries && entries.length > 0 && (
          <>
            <div className="lh-help muted">
              Newest first. Line numbers are those of the last commit; click a commit to show it in
              the graph.
            </div>
            {entries.map((e) => (
              <Entry key={e.commit.sha} entry={e} path={path} onSelectSha={onSelectSha} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
