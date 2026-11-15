import { ArrowLeftRight, GitCompareArrows, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CompareResult } from '../../../../shared/features/gitextras'
import type { Commit, DiffTarget, FileChange } from '../../../../shared/types'
import '../../assets/gitextras.css'
import { errorMessage, relativeTime, shortSha, fullDate } from '../../lib/format'
import { CodeText, DiffView } from '../DiffView'
import { KindBadge } from '../ui'
import { useEscape } from '../ui-context'

interface Props {
  repo: string
  from: string
  to: string
  onClose(): void
  onSelectSha(sha: string): void
}

const noop = (): void => {}

function loadThreeDot(): boolean {
  try {
    return localStorage.getItem('gitdesk.compareThreeDot') !== 'false'
  } catch {
    return true
  }
}

function saveThreeDot(value: boolean): void {
  try {
    localStorage.setItem('gitdesk.compareThreeDot', String(value))
  } catch {
    /* preference only */
  }
}

function fileKey(f: FileChange): string {
  return `${f.origPath ?? ''}\0${f.path}`
}

function CommitList({
  title,
  hint,
  commits,
  total,
  onSelectSha
}: {
  title: string
  hint: string
  commits: Commit[]
  total: number
  onSelectSha(sha: string): void
}): React.JSX.Element {
  return (
    <section className="cmp-section">
      <h3 className="cmp-section-title" title={hint}>
        {title} <span className="badge">{total}</span>
      </h3>
      {commits.length === 0 ? (
        <div className="cmp-empty muted">None</div>
      ) : (
        <ul className="cmp-list">
          {commits.map((c) => (
            <li key={c.sha}>
              <button
                className="cmp-commit"
                onClick={() => onSelectSha(c.sha)}
                title={`${c.subject}\n${c.author}, ${fullDate(c.date)}\nShow in the graph`}
              >
                <span className="cmp-subject">{c.subject}</span>
                <span className="cmp-meta">
                  {c.author} · {relativeTime(c.date)}
                </span>
                <span className="cmp-sha mono">{shortSha(c.sha)}</span>
              </button>
            </li>
          ))}
          {total > commits.length && (
            <li className="cmp-empty muted">and {total - commits.length} more…</li>
          )}
        </ul>
      )}
    </section>
  )
}

/** Compares two refs: commits on each side and the files changed between them. */
export function CompareView({ repo, from, to, onClose, onSelectSha }: Props): React.JSX.Element {
  // Refs being compared; the inputs can be edited and are applied with Enter / on blur.
  const [shown, setShown] = useState({ repo, from, to })
  const [refs, setRefs] = useState({ from, to })
  const [inputs, setInputs] = useState({ from, to })
  if (shown.repo !== repo || shown.from !== from || shown.to !== to) {
    // Opened again with other refs: start over from them.
    setShown({ repo, from, to })
    setRefs({ from, to })
    setInputs({ from, to })
  }
  const [threeDot, setThreeDot] = useState(loadThreeDot)
  const [names, setNames] = useState<string[]>([])
  const key = `${repo}\0${refs.from}\0${refs.to}\0${threeDot}`
  const [result, setResult] = useState<{
    key: string
    data: CompareResult | null
    error: string | null
  }>()
  const [picked, setPicked] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  useEscape(rootRef, onClose)

  useEffect(() => {
    let cancelled = false
    window.api.refs(repo).then(
      (r) => {
        if (cancelled) return
        setNames([
          ...r.branches.map((b) => b.name),
          ...r.remoteBranches.map((b) => b.fullName),
          ...r.tags.map((t) => t.name)
        ])
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [repo])

  useEffect(() => {
    if (!refs.from.trim() || !refs.to.trim()) return
    let cancelled = false
    window.api.compare(repo, refs.from, refs.to, threeDot).then(
      (data) => !cancelled && setResult({ key, data, error: null }),
      (e) => !cancelled && setResult({ key, data: null, error: errorMessage(e) })
    )
    return () => {
      cancelled = true
    }
  }, [repo, refs, threeDot, key])

  const current = result?.key === key ? result : undefined
  const data = current?.data ?? null
  const file = data?.files.find((f) => fileKey(f) === picked) ?? null

  const target = useMemo<DiffTarget | null>(
    () =>
      data && file
        ? {
            kind: 'compare',
            from: data.fromSha,
            to: data.toSha,
            file,
            threeDot: data.threeDot
          }
        : null,
    [data, file]
  )

  const apply = (): void => {
    const next = { from: inputs.from.trim(), to: inputs.to.trim() }
    if (next.from && next.to && (next.from !== refs.from || next.to !== refs.to)) {
      setRefs(next)
      setPicked(null)
    }
  }
  const swap = (): void => {
    setRefs({ from: refs.to, to: refs.from })
    setInputs({ from: refs.to, to: refs.from })
    setPicked(null)
  }
  const changeDots = (value: boolean): void => {
    setThreeDot(value)
    saveThreeDot(value)
  }
  const closeDiff = useCallback(() => setPicked(null), [])

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      apply()
    }
  }

  return (
    <div className="compare-view" ref={rootRef} data-escape>
      <div className="diff-header cmp-header">
        <GitCompareArrows size={15} className="muted" />
        <input
          className="input cmp-ref"
          aria-label="Base (from)"
          title="Base: a branch, tag or commit"
          list={listId}
          value={inputs.from}
          spellCheck={false}
          onChange={(e) => setInputs({ ...inputs, from: e.target.value })}
          onKeyDown={onKey}
          onBlur={apply}
        />
        <button
          className="icon-btn"
          onClick={swap}
          title="Swap the two sides"
          aria-label="Swap the two sides"
        >
          <ArrowLeftRight size={15} />
        </button>
        <input
          className="input cmp-ref"
          aria-label="Compare (to)"
          title="Compared: a branch, tag or commit"
          list={listId}
          value={inputs.to}
          spellCheck={false}
          onChange={(e) => setInputs({ ...inputs, to: e.target.value })}
          onKeyDown={onKey}
          onBlur={apply}
        />
        <datalist id={listId}>
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <div className="segmented cmp-dots" role="group" aria-label="Changed files">
          <button
            className={threeDot ? 'active' : ''}
            aria-pressed={threeDot}
            onClick={() => changeDots(true)}
            title="Changes made on the compared side since the two diverged (from...to)"
          >
            Since merge base
          </button>
          <button
            className={!threeDot ? 'active' : ''}
            aria-pressed={!threeDot}
            onClick={() => changeDots(false)}
            title="Direct difference between the two (from..to)"
          >
            Direct
          </button>
        </div>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <X size={16} />
        </button>
      </div>

      {current?.error ? (
        <div className="empty-state error">{current.error}</div>
      ) : !data ? (
        <div className="empty-state">Comparing…</div>
      ) : (
        <div className="cmp-body">
          <div className="cmp-side">
            <div className="cmp-summary muted">
              {data.mergeBase ? (
                <>
                  Merge base{' '}
                  <button className="link-btn mono" onClick={() => onSelectSha(data.mergeBase!)}>
                    {shortSha(data.mergeBase)}
                  </button>
                </>
              ) : (
                'No common history'
              )}
              {data.threeDot !== threeDot && ' · direct diff (no merge base)'}
            </div>
            <CommitList
              title={`In ${data.to}, not in ${data.from}`}
              hint="Commits ahead"
              commits={data.ahead}
              total={data.aheadCount}
              onSelectSha={onSelectSha}
            />
            <CommitList
              title={`In ${data.from}, not in ${data.to}`}
              hint="Commits behind"
              commits={data.behind}
              total={data.behindCount}
              onSelectSha={onSelectSha}
            />
            <section className="cmp-section">
              <h3 className="cmp-section-title">
                Changed files <span className="badge">{data.files.length}</span>
              </h3>
              {data.files.length === 0 ? (
                <div className="cmp-empty muted">No differences.</div>
              ) : (
                <ul className="cmp-list" role="listbox" aria-label="Changed files">
                  {data.files.map((f) => {
                    const k = fileKey(f)
                    return (
                      <li key={k}>
                        <button
                          role="option"
                          aria-selected={k === picked}
                          className={k === picked ? 'cmp-file selected' : 'cmp-file'}
                          onClick={() => setPicked(k)}
                          title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                        >
                          <KindBadge kind={f.kind} />
                          <span className="cmp-path">
                            <CodeText text={f.path} />
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </div>
          <div className="cmp-diff">
            {target ? (
              <DiffView
                repo={repo}
                target={target}
                version={0}
                onClose={closeDiff}
                onHunk={noop}
                onFile={noop}
              />
            ) : (
              <div className="empty-state">
                {data.files.length ? 'Select a file to see its changes.' : 'Nothing to show.'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
