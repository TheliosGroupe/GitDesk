import { Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { Commit, SearchField } from '../../../shared/types'
import { errorMessage, relativeTime, shortSha } from '../lib/format'
import { keysOf } from '../lib/shortcuts'

const LIMIT = 200
const FIELDS: { value: SearchField; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'message', label: 'Message' },
  { value: 'author', label: 'Author' },
  { value: 'sha', label: 'SHA' }
]

interface Props {
  repo: string
  inputRef: React.RefObject<HTMLInputElement | null>
  /** The commit is in the graph (otherwise it is only shown in the details panel). */
  isLoaded(sha: string): boolean
  onPick(commit: Commit): void
  /** Matching commits while a search is active, null when the search is cleared. */
  onMatches(shas: Set<string> | null): void
}

/** Commit search in the toolbar: debounced, with a keyboard-friendly result list. */
export function SearchBar({
  repo,
  inputRef,
  isLoaded,
  onPick,
  onMatches
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [field, setField] = useState<SearchField>('all')
  const [results, setResults] = useState<Commit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const seq = useRef(0)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const id = ++seq.current
    const timer = setTimeout(() => {
      window.api.searchCommits(repo, q, field, LIMIT).then(
        (list) => {
          if (id !== seq.current) return
          setResults(list)
          setError(null)
          setActive(0)
          onMatches(new Set(list.map((c) => c.sha)))
        },
        (e) => {
          if (id !== seq.current) return
          setResults([])
          setError(errorMessage(e))
          onMatches(null)
        }
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [repo, query, field, onMatches])

  // Keep the keyboard-selected result visible.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const clear = (): void => {
    seq.current++
    setQuery('')
    setResults(null)
    setError(null)
    setOpen(false)
    onMatches(null)
  }

  const pick = (c: Commit): void => {
    setOpen(false)
    onPick(c)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const list = results ?? []
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return setOpen(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => Math.min(list.length - 1, Math.max(0, i + step)))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (list[active]) pick(list[active])
    } else if (e.key === 'Escape') {
      // Don't let Esc also close the diff behind the search.
      e.stopPropagation()
      if (open) setOpen(false)
      else if (query) clear()
      else inputRef.current?.blur()
    }
  }

  const searching = !!query.trim()
  const showList = open && searching && (results !== null || error !== null)
  const listId = useId()

  return (
    <div
      className="search-bar"
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}
    >
      <Search size={14} className="search-icon" aria-hidden />
      <select
        className="search-field"
        aria-label="Search in"
        value={field}
        onChange={(e) => {
          setField(e.target.value as SearchField)
          inputRef.current?.focus()
        }}
      >
        {FIELDS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <input
        ref={inputRef}
        className="search-input"
        placeholder={`Search commits (${keysOf('search')})`}
        aria-label="Search commits"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && results?.[active] ? `${listId}-${active}` : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          if (!e.target.value.trim()) clear()
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {query && (
        <button className="icon-btn search-clear" aria-label="Clear search" onClick={clear}>
          <X size={13} />
        </button>
      )}
      {showList && (
        <div className="search-results">
          <div className="search-summary">
            {error
              ? error
              : results!.length === 0
                ? 'No matching commits'
                : `${results!.length >= LIMIT ? `${LIMIT}+` : results!.length} matching commit${results!.length === 1 ? '' : 's'}`}
          </div>
          <ul id={listId} role="listbox" ref={listRef} aria-label="Matching commits">
            {(results ?? []).map((c, i) => (
              <li
                key={c.sha}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'active' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(c)}
              >
                <span className="search-subject">{c.subject}</span>
                <span className="search-meta">
                  {c.author} · {relativeTime(c.date)} ·{' '}
                  <span className="mono">{shortSha(c.sha)}</span>
                  {!isLoaded(c.sha) && <span className="search-older"> · not in graph</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
