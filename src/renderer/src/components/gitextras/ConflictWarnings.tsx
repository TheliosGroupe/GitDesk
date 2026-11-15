import { Check, Cloud, Copy, GitBranch, TriangleAlert, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  CONFLICT_RETRY_MS,
  type ConflictReport,
  type ConflictWarning
} from '../../../../shared/features/gitextras'
import '../../assets/gitextras.css'
import { fullDate, relativeTime } from '../../lib/format'

interface Props {
  repo: string
  /** Changes whenever the repository changed: the check runs again (debounced). */
  version: number
}

const DEBOUNCE_MS = 1500

const STATUS: Record<ConflictWarning['status'], { label: string; title: string }> = {
  conflict: {
    label: 'Will conflict',
    title: 'Merging this branch into yours would stop on conflicts (tested with git merge-tree).'
  },
  overlap: {
    label: 'Same files',
    title:
      'Changes the same files as you; it merges cleanly with your commits, but your uncommitted changes may still clash.'
  },
  unknown: {
    label: 'May conflict',
    title: 'Changes the same files as you (git 2.38 or later is needed to test the merge).'
  }
}

function asText(w: ConflictWarning): string {
  return `${w.branch} (${STATUS[w.status].label.toLowerCase()}): ${w.files.join(', ')}`
}

function WarningRow({ w }: { w: ConflictWarning }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    navigator.clipboard.writeText(asText(w)).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => undefined
    )
  }
  const conflicted = new Set(w.conflictFiles)
  return (
    <li className="cw-item">
      <div className="cw-line">
        {w.remote ? (
          <Cloud size={13} className="muted" aria-label="Remote branch" />
        ) : (
          <GitBranch size={13} className="muted" aria-label="Local branch" />
        )}
        <span className="cw-branch" title={w.branch}>
          {w.branch}
        </span>
        <span className={`cw-status ${w.status}`} title={STATUS[w.status].title}>
          {STATUS[w.status].label}
        </span>
        <button
          className="icon-btn small"
          onClick={copy}
          title="Copy the branch and its files"
          aria-label={`Copy ${w.branch} and its files`}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <div className="cw-meta muted" title={`${w.subject}\n${fullDate(w.date)}`}>
        {w.author} · {relativeTime(w.date)} · {w.subject}
      </div>
      <ul className="cw-files">
        {w.files.map((f) => (
          <li key={f} className={conflicted.has(f) ? 'conflicted' : ''} title={f}>
            {f}
          </li>
        ))}
        {w.conflictFiles
          .filter((f) => !w.files.includes(f))
          .map((f) => (
            <li key={`c:${f}`} className="conflicted" title={f}>
              {f}
            </li>
          ))}
      </ul>
    </li>
  )
}

/**
 * Toolbar indicator: other branches that change the files you are working on.
 * Hidden while there are none.
 */
export function ConflictWarnings({ repo, version }: Props): React.JSX.Element | null {
  const [report, setReport] = useState<{ repo: string; data: ConflictReport } | null>(null)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | null = null
    const check = (): void => {
      // A minimized or hidden window checks when it is shown again.
      if (document.visibilityState === 'hidden') {
        document.addEventListener('visibilitychange', check, { once: true })
        return
      }
      window.api.conflictWarnings(repo).then(
        (data) => {
          if (cancelled) return
          // A merge-tree check failed: ask again later, even if nothing changes meanwhile.
          if (data.incomplete) retry = setTimeout(check, CONFLICT_RETRY_MS + 1000)
          // The same report again (the usual case) keeps the toolbar as it is.
          setReport((prev) =>
            prev?.repo === repo && JSON.stringify(prev.data) === JSON.stringify(data)
              ? prev
              : { repo, data }
          )
        },
        () => undefined // a failed check shows nothing; the next change tries again
      )
    }
    const timer = setTimeout(check, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      if (retry) clearTimeout(retry)
      document.removeEventListener('visibilitychange', check)
    }
  }, [repo, version])

  // Click outside or Esc closes the popover (before any view takes that Esc).
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])

  const data = report?.repo === repo ? report.data : null
  const warnings = data?.warnings ?? []
  if (!data || !warnings.length) return null

  const conflicts = warnings.filter((w) => w.status === 'conflict').length
  const label = conflicts
    ? `${conflicts} conflict${conflicts > 1 ? 's' : ''}`
    : `${warnings.length} overlap${warnings.length > 1 ? 's' : ''}`
  const copyAll = (): void => {
    void navigator.clipboard.writeText(warnings.map(asText).join('\n')).catch(() => undefined)
  }

  return (
    <div className="cw-root" ref={rootRef}>
      <button
        className={`tool cw-tool${conflicts ? ' bad' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${warnings.length} other branch${warnings.length > 1 ? 'es' : ''} change the files you are working on`}
      >
        <TriangleAlert size={18} />
        <span>{label}</span>
      </button>
      {open && (
        <div className="cw-popover" role="dialog" aria-label="Possible conflicts">
          <div className="cw-head">
            <div>
              <strong>Other branches change your files</strong>
              <div className="muted cw-sub">
                Your work: {data.myFiles} file{data.myFiles === 1 ? '' : 's'}
                {data.base ? ` changed since ${data.base}` : ''}, uncommitted changes included ·{' '}
                {data.checked} branch{data.checked === 1 ? '' : 'es'} updated in the last 30 days
                checked
                {!data.mergeTree && ' · update git to 2.38+ to test real conflicts'}
              </div>
            </div>
            <button
              className="icon-btn small"
              onClick={copyAll}
              title="Copy the list"
              aria-label="Copy the list"
            >
              <Copy size={13} />
            </button>
            <button
              className="icon-btn small"
              onClick={() => setOpen(false)}
              title="Close (Esc)"
              aria-label="Close"
            >
              <X size={13} />
            </button>
          </div>
          <ul className="cw-list">
            {warnings.map((w) => (
              <WarningRow key={w.branch} w={w} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
