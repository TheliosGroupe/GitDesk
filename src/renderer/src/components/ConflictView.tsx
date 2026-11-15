import { Check, ExternalLink, LoaderCircle, Sparkles } from 'lucide-react'
import { memo, useEffect, useMemo, useState } from 'react'
import type { AiConflictSuggestion } from '../../../shared/features/ai'
import type { ConflictFile } from '../../../shared/types'
import {
  classifyResolution,
  conflictCount,
  hasConflictMarkers,
  mergeConflicts,
  parseConflicts,
  stripEol,
  textToBlockLines,
  type Choice,
  type ConflictBlock,
  type Provenance
} from '../lib/conflict'
import { chunkRanges } from '../lib/diff'
import { errorMessage } from '../lib/format'
import {
  conflictHasHiddenChars,
  highlightLines,
  languageFor,
  MAX_HIGHLIGHT_LINES,
  type Language
} from '../lib/highlight'
import { CodeText, HiddenCharsBanner, Isolated, LazyRows, LazyScope } from './DiffView'
import { newRequestId, useAiAvailable } from './ai/useAi'
import { useDialogs, useOpenFile, useToasts } from './ui-context'

interface Props {
  repo: string
  /** A conflicted file of the working copy. */
  path: string
  /** Changes whenever the repository changed, so the file is re-read. */
  version: number
  /** Called once the file is resolved (it leaves the conflicted list). */
  onClose(): void
}

/** Unchanged regions longer than this are collapsed to their first and last lines. */
const KEEP = 3

/** Lines per chunk: long blocks draw only the chunks near the visible part. */
const CHUNK_LINES = 100

const LinesChunk = memo(function LinesChunk({
  lines,
  html,
  from,
  to,
  fileStart
}: {
  lines: string[]
  html: string[] | null
  from: number
  to: number
  /** lines[0] is the file's first line (its leading U+FEFF is the BOM). */
  fileStart: boolean
}): React.JSX.Element {
  const out: React.JSX.Element[] = []
  for (let i = from; i < to; i++) {
    out.push(
      html ? (
        // highlight.js escapes the source text (hidden characters are markers), so its HTML is
        // safe to inject.
        <div key={i} className="code" dangerouslySetInnerHTML={{ __html: html[i] || ' ' }} />
      ) : (
        <div key={i} className="code">
          <CodeText text={stripEol(lines[i]) || ' '} fileStart={fileStart && i === 0} />
        </div>
      )
    )
  }
  return <>{out}</>
})

/** Plain or highlighted lines of a block of code. */
function Lines({
  lines,
  language,
  className,
  fileStart = false
}: {
  lines: string[]
  language: Language | null
  className: string
  /** The block starts at the file's first line. */
  fileStart?: boolean
}): React.JSX.Element {
  const html = useMemo(() => {
    const text = lines.map(stripEol)
    return language && text.length <= MAX_HIGHLIGHT_LINES
      ? highlightLines(text, language, fileStart)
      : null
  }, [lines, language, fileStart])
  return (
    <div className={`conflict-lines ${className}`}>
      {chunkRanges(lines.length, CHUNK_LINES).map(([from, to]) => (
        <LazyRows key={from} rows={to - from} eager={from === 0} className="conflict-chunk">
          <LinesChunk lines={lines} html={html} from={from} to={to} fileStart={fileStart} />
        </LazyRows>
      ))}
    </div>
  )
}

/** Unchanged text between conflicts, collapsed when long. */
function Context({
  lines,
  first,
  last,
  language,
  fileStart
}: {
  lines: string[]
  first: boolean
  last: boolean
  language: Language | null
  /** The first segment of the file. */
  fileStart: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  // Show a few lines next to each conflict; nothing before the first or after the last one.
  const head = first ? 0 : KEEP
  const tail = last ? 0 : KEEP
  if (open || lines.length <= head + tail + 1) {
    return <Lines lines={lines} language={language} className="context" fileStart={fileStart} />
  }
  const hidden = lines.length - head - tail
  return (
    <>
      {head > 0 && (
        <Lines
          lines={lines.slice(0, head)}
          language={language}
          className="context"
          fileStart={fileStart}
        />
      )}
      <button className="conflict-expand" onClick={() => setOpen(true)}>
        {hidden} unchanged line{hidden > 1 ? 's' : ''} — show
      </button>
      {tail > 0 && <Lines lines={lines.slice(-tail)} language={language} className="context" />}
    </>
  )
}

/** Rows of the suggestion box at most (it scrolls past that, and says so). */
const AI_MAX_ROWS = 200
/** Lines found on neither side listed under a suggestion at most. */
const AI_MAX_NEW_LINES = 50

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The AI suggestion of a block: model output, never applied until the user picks it. It
 * shows what it adds (lines on neither side) and drops from each side; its text can be edited.
 */
function AiSuggestion({
  suggestion,
  text,
  provenance,
  choice,
  onEdit
}: {
  suggestion: AiConflictSuggestion
  text: string
  provenance: Provenance
  choice: Choice | undefined
  onEdit(text: string): void
}): React.JSX.Element {
  const markers = hasConflictMarkers(text)
  const lineCount = text.split('\n').length
  const added = provenance.lines.filter((l) => l.origin === 'new')
  const { dropped, total } = provenance
  const state = choice === 'ai' ? ' used' : choice ? ' dropped' : ' pending'
  return (
    <div className={`conflict-side ai${state}`}>
      <div className="conflict-label">
        <Sparkles size={12} /> AI suggestion{text !== suggestion.resolution ? ' (edited)' : ''}
        {choice !== 'ai' && <span className="conflict-ai-badge">not used: review it first</span>}
      </div>
      {suggestion.explanation && (
        <div className="conflict-ai-why">
          <span className="conflict-ai-source">Model’s explanation (unverified):</span>{' '}
          <CodeText text={suggestion.explanation} />
        </div>
      )}
      <div className="conflict-ai-provenance" aria-live="polite">
        <span className={provenance.added ? 'warn' : undefined}>
          {plural(provenance.added, 'line')} on neither side
        </span>
        <span className={dropped.current ? 'warn' : undefined}>
          current: {dropped.current} of {plural(total.current, 'line')} dropped
        </span>
        <span className={dropped.incoming ? 'warn' : undefined}>
          incoming: {dropped.incoming} of {plural(total.incoming, 'line')} dropped
        </span>
      </div>
      <textarea
        className="input mono conflict-ai-text"
        aria-label="AI suggestion (editable)"
        spellCheck={false}
        rows={Math.min(AI_MAX_ROWS, Math.max(2, lineCount))}
        value={text}
        onChange={(e) => onEdit(e.target.value)}
      />
      {lineCount > AI_MAX_ROWS && (
        <div className="conflict-ai-warn">
          {lineCount - AI_MAX_ROWS} more lines below: scroll the box to see them all.
        </div>
      )}
      {added.length > 0 && (
        <div className="conflict-ai-new" aria-label="Lines on neither side">
          <div className="conflict-ai-source">Not on either side:</div>
          {added.slice(0, AI_MAX_NEW_LINES).map((l, i) => (
            <div key={i} className="code">
              <CodeText text={l.text} />
            </div>
          ))}
          {added.length > AI_MAX_NEW_LINES && (
            <div className="conflict-ai-source">and {added.length - AI_MAX_NEW_LINES} more</div>
          )}
        </div>
      )}
      {markers && <div className="conflict-ai-warn">The text still has conflict markers.</div>}
      {!text && <div className="conflict-ai-why">Empty: the block is removed.</div>}
    </div>
  )
}

function Block({
  block,
  choice,
  language,
  suggestion,
  aiText,
  onChoose,
  onEditAi,
  fileStart
}: {
  /** The conflict starts the file: each side's first line is the file's first line. */
  fileStart: boolean
  block: ConflictBlock
  choice: Choice | undefined
  language: Language | null
  suggestion: AiConflictSuggestion | undefined
  aiText: string
  onChoose(choice: Choice | undefined): void
  onEditAi(text: string): void
}): React.JSX.Element {
  const current = `Current${block.currentLabel ? ` (${block.currentLabel})` : ' (HEAD)'}`
  const incoming = `Incoming${block.incomingLabel ? ` (${block.incomingLabel})` : ''}`
  const option = (value: Choice, label: string, title: string): React.JSX.Element => (
    <button
      className={`btn small${choice === value ? ' primary' : ''}`}
      aria-pressed={choice === value}
      title={title}
      // Clicking the chosen option again undoes the choice.
      onClick={() => onChoose(choice === value ? undefined : value)}
    >
      {label}
    </button>
  )
  const provenance = useMemo(
    () => (suggestion ? classifyResolution(aiText, block) : null),
    [suggestion, aiText, block]
  )
  // With the AI text, what each side keeps is read from the text itself, not the choice.
  const used = (side: 'current' | 'incoming'): string => {
    if (!choice) return ''
    if (choice !== 'ai' || !provenance)
      return choice === 'both' || choice === side ? ' used' : ' dropped'
    const lost = provenance.dropped[side]
    return lost === 0 ? ' used' : lost >= provenance.total[side] ? ' dropped' : ' partial'
  }
  const aiMarkers = choice === 'ai' && hasConflictMarkers(aiText)
  return (
    <div className={`conflict-block${choice ? ' resolved' : ''}`}>
      <div className="conflict-bar">
        <span className="conflict-title">Conflict {block.index + 1}</span>
        {choice && !aiMarkers && (
          <Check size={14} className="conflict-done" aria-label="Resolved" />
        )}
        <span className="spacer" />
        {option('current', 'Use current', `Keep ${current}`)}
        {option('incoming', 'Use incoming', `Keep ${incoming}`)}
        {option('both', 'Use both', 'Keep current, then incoming')}
        {suggestion &&
          option(
            'ai',
            'Use AI suggestion',
            'Use the resolution proposed by the AI (check it first: it is model output)'
          )}
      </div>
      <div className={`conflict-side current${used('current')}`}>
        <div className="conflict-label">
          <CodeText text={current} />
        </div>
        <Lines
          lines={block.current}
          language={language}
          className="current"
          fileStart={fileStart}
        />
      </div>
      {block.base && (
        <div className="conflict-side base">
          <div className="conflict-label">
            <CodeText text={`Common ancestor${block.baseLabel ? ` (${block.baseLabel})` : ''}`} />
          </div>
          <Lines lines={block.base} language={language} className="base" fileStart={fileStart} />
        </div>
      )}
      <div className={`conflict-side incoming${used('incoming')}`}>
        <div className="conflict-label">
          <CodeText text={incoming} />
        </div>
        <Lines
          lines={block.incoming}
          language={language}
          className="incoming"
          fileStart={fileStart}
        />
      </div>
      {suggestion && provenance && (
        <AiSuggestion
          suggestion={suggestion}
          text={aiText}
          provenance={provenance}
          choice={choice}
          onEdit={onEditAi}
        />
      )}
    </div>
  )
}

export function ConflictView({ repo, path, version, onClose }: Props): React.JSX.Element {
  const toasts = useToasts()
  const dialogs = useDialogs()
  const openFile = useOpenFile()
  const [loaded, setLoaded] = useState<{
    key: string
    file: ConflictFile | null
    error: string | null
  }>()
  // Choices belong to one exact content: an edit outside GitDesk starts over.
  const [picked, setPicked] = useState<{ content: string; choices: (Choice | undefined)[] }>()
  const [busy, setBusy] = useState(false)
  const aiAvailable = useAiAvailable()
  // AI suggestions and their edited text, for one exact content like the choices.
  const [ai, setAi] = useState<{
    content: string
    suggestions: Map<number, AiConflictSuggestion>
    texts: Map<number, string>
    note: string
  }>()
  const [aiRequest, setAiRequest] = useState<string | null>(null)
  const key = `${repo}\n${path}`

  useEffect(() => {
    let cancelled = false
    window.api.readConflict(repo, path).then(
      (file) => !cancelled && setLoaded({ key, file, error: null }),
      (e) => !cancelled && setLoaded({ key, file: null, error: errorMessage(e) })
    )
    return () => {
      cancelled = true
    }
  }, [repo, path, key, version])

  const current = loaded?.key === key ? loaded : undefined
  const content = current?.file?.content ?? null
  // Binary, not UTF-8 or too large: no text to show or rewrite, only whole sides (or an editor).
  const binary = !!current?.file?.binary
  const tooLarge = !binary && !!current?.file?.tooLarge
  const undecodable = binary || tooLarge || !!current?.file?.encodingProblem
  const segments = useMemo(() => (content === null ? [] : parseConflicts(content)), [content])
  const hidden = useMemo(() => conflictHasHiddenChars(segments), [segments])
  const total = conflictCount(segments)
  const choices = picked && picked.content === content ? picked.choices : []
  const aiNow = ai && ai.content === content ? ai : undefined
  const aiText = (index: number): string =>
    aiNow?.texts.get(index) ?? aiNow?.suggestions.get(index)?.resolution ?? ''
  const blocks = segments.filter((s): s is ConflictBlock => s.kind === 'conflict')
  // The AI choice only stands while a suggestion for that conflict is shown.
  const usesAi = (index: number): boolean =>
    choices[index] === 'ai' && !!aiNow?.suggestions.has(index)
  const customLines = blocks.map((b) =>
    usesAi(b.index) ? textToBlockLines(aiText(b.index), b) : undefined
  )
  // An AI choice still holding conflict markers (or without a suggestion) is not resolved.
  const done = blocks.filter((b) =>
    choices[b.index] === 'ai'
      ? usesAi(b.index) && !hasConflictMarkers(aiText(b.index))
      : !!choices[b.index]
  ).length
  const language = languageFor(path)

  const choose = (index: number, choice: Choice | undefined): void => {
    if (content === null) return
    const next = [...choices]
    next[index] = choice
    setPicked({ content, choices: next })
  }

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      onClose() // resolved: the file leaves the conflicted list
    } catch (e) {
      toasts.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const takeAll = async (side: 'ours' | 'theirs'): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Take the whole file from the ${side === 'ours' ? 'current' : 'incoming'} side?`,
      message: (
        <>
          The other side&apos;s changes to <Isolated text={path} />, including the ones that merged
          cleanly, are dropped.
        </>
      ),
      okLabel: 'Take it',
      danger: true
    })
    if (ok) await run(() => window.api.resolveConflictSide(repo, path, side))
  }

  // No markers left: the file is staged as it is, never rewritten.
  const markResolved = (): Promise<void> =>
    run(() =>
      total === 0
        ? window.api.markResolved(repo, path)
        : window.api.resolveConflict(repo, path, mergeConflicts(segments, choices, customLines))
    )

  const suggest = async (): Promise<void> => {
    if (content === null) return
    if (aiRequest) {
      void window.api.aiCancel(aiRequest)
      return
    }
    const id = newRequestId()
    setAiRequest(id)
    try {
      const result = await window.api.aiResolveConflict(repo, path, id)
      const suggestions = new Map(result.blocks.map((b) => [b.index, b]))
      setAi({ content, suggestions, texts: new Map(), note: result.note })
      // New text is reviewed again: no conflict keeps an AI choice made on the old one.
      setPicked((p) =>
        p && p.content === content
          ? { content, choices: p.choices.map((c) => (c === 'ai' ? undefined : c)) }
          : p
      )
      // Suggestions are never picked for the user: each one is reviewed and chosen by hand.
      toasts.info(
        [
          result.blocks.length
            ? `${plural(result.blocks.length, 'AI suggestion')} to review: choose “Use AI suggestion” on a conflict to use it.`
            : 'The AI returned no suggestion for this file.',
          result.note ? `AI note (unverified): ${result.note}` : ''
        ]
          .filter(Boolean)
          .join(' ')
      )
    } catch (e) {
      const message = errorMessage(e)
      if (!/Cancelled\.?$/.test(message)) toasts.error(message)
    } finally {
      setAiRequest(null)
    }
  }

  const editAi = (index: number, text: string): void => {
    if (!aiNow) return
    const texts = new Map(aiNow.texts)
    texts.set(index, text)
    setAi({ ...aiNow, texts })
  }

  const firstConflict = segments.findIndex((s) => s.kind === 'conflict')
  const lastConflict = segments.findLastIndex((s) => s.kind === 'conflict')

  return (
    <div className="conflict-view">
      <div className="conflict-toolbar">
        <span className="conflict-count" aria-live="polite">
          {content === null
            ? undecodable
              ? binary
                ? 'Binary file'
                : tooLarge
                  ? 'File too large'
                  : 'Not UTF-8 text'
              : ''
            : total === 0
              ? 'No conflict markers left'
              : `${done} of ${total} conflict${total > 1 ? 's' : ''} resolved`}
        </span>
        <span className="spacer" />
        {aiAvailable && content !== null && total > 0 && (
          <button
            className="btn small"
            disabled={busy}
            onClick={suggest}
            title={
              aiRequest
                ? 'Stop'
                : 'Ask your AI provider for a resolution of each conflict (the conflicting code is sent to it)'
            }
          >
            {aiRequest ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}{' '}
            {aiRequest ? 'Suggesting… (stop)' : aiNow ? 'Suggest again' : 'Suggest with AI'}
          </button>
        )}
        <button
          className="btn small"
          disabled={busy}
          onClick={() => takeAll('ours')}
          title="Take the whole file from the current side (git checkout --ours)"
        >
          Take all current
        </button>
        <button
          className="btn small"
          disabled={busy}
          onClick={() => takeAll('theirs')}
          title="Take the whole file from the incoming side (git checkout --theirs)"
        >
          Take all incoming
        </button>
        {!binary && (
          <button
            className="btn small"
            onClick={() => openFile(repo, path)}
            title="Edit the file in your editor"
          >
            <ExternalLink size={13} /> Open in editor
          </button>
        )}
        {!undecodable && (
          <button
            className="btn small primary"
            disabled={busy || content === null || done < total}
            onClick={markResolved}
            title={
              done < total
                ? 'Choose a side for every conflict first (an AI suggestion must have no markers left)'
                : total === 0
                  ? 'Stage the file as it is'
                  : 'Save the result and stage the file'
            }
          >
            <Check size={14} /> {total === 0 ? 'Mark resolved as is' : 'Mark resolved'}
          </button>
        )}
      </div>
      <div className="conflict-hint">
        Current is the checked-out side, incoming the side being merged in. During a rebase they are
        swapped: current is the branch you rebase onto, incoming your own commit.
      </div>

      {hidden && <HiddenCharsBanner />}
      <div className="diff-body conflict-body">
        <LazyScope>
          {current?.error && <div className="empty-state error">{current.error}</div>}
          {!current && <div className="empty-state">Loading…</div>}
          {undecodable && (
            <div className="empty-state">
              <Isolated text={path} />
              {binary
                ? ' is a binary file: GitDesk cannot merge it line by line. Take the whole file from the current or the incoming side.'
                : tooLarge
                  ? ' is too large to resolve here: take a whole side or edit it in your editor, then use “Mark resolved (stage)” in the Conflicts list.'
                  : ' is not UTF-8 text, so GitDesk cannot edit it without changing its bytes. Take the whole file from one side, or fix it in your editor, then use “Mark resolved (stage)” in the Conflicts list.'}
            </div>
          )}

          {content !== null && total === 0 && (
            <Lines
              lines={segments.flatMap((s) => (s.kind === 'text' ? s.lines : []))}
              language={language}
              className="context"
              fileStart={segments[0]?.kind === 'text'}
            />
          )}
          {content !== null &&
            total > 0 &&
            segments.map((s, i) =>
              s.kind === 'text' ? (
                <Context
                  key={i}
                  lines={s.lines}
                  first={i < firstConflict}
                  last={i > lastConflict}
                  language={language}
                  fileStart={i === 0}
                />
              ) : (
                <Block
                  key={i}
                  fileStart={i === 0}
                  block={s}
                  choice={choices[s.index]}
                  language={language}
                  suggestion={aiNow?.suggestions.get(s.index)}
                  aiText={aiText(s.index)}
                  onChoose={(c) => choose(s.index, c)}
                  onEditAi={(text) => editAi(s.index, text)}
                />
              )
            )}
        </LazyScope>
      </div>
    </div>
  )
}
