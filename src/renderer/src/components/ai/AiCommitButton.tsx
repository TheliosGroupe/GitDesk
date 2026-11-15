import { LoaderCircle, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '../../lib/format'
import { useToasts } from '../ui-context'
import { newRequestId } from './useAi'
import { withheldText } from './withheld'
import '../../assets/ai.css'

/** Sparkle button of the commit box: writes the commit message from the staged diff. */
export function AiCommitButton({
  repo,
  disabled,
  onMessage
}: {
  repo: string
  disabled: boolean
  onMessage(summary: string, description: string): void
}): React.JSX.Element {
  const toasts = useToasts()
  const [requestId, setRequestId] = useState<string | null>(null)
  const active = useRef<string | null>(null)

  // Leaving the repository (or unmounting) stops the request.
  useEffect(
    () => () => {
      if (active.current) void window.api.aiCancel(active.current)
    },
    [repo]
  )

  const run = async (): Promise<void> => {
    if (requestId) {
      void window.api.aiCancel(requestId)
      return
    }
    const id = newRequestId()
    active.current = id
    setRequestId(id)
    try {
      const result = await window.api.aiCommitMessage(repo, id)
      if (active.current !== id) return
      onMessage(result.summary, result.description)
      const notes = [
        result.source === 'unstaged' ? 'Nothing is staged: this describes all your changes.' : '',
        result.truncated ? 'The diff was too large to send in full.' : '',
        withheldText(result.withheld ?? [])
      ].filter(Boolean)
      if (notes.length) toasts.info(notes.join(' '))
    } catch (e) {
      const message = errorMessage(e)
      if (active.current === id && !/Cancelled\.?$/.test(message)) toasts.error(message)
    } finally {
      if (active.current === id) {
        active.current = null
        setRequestId(null)
      }
    }
  }

  const busy = requestId !== null
  return (
    <button
      type="button"
      className={`icon-btn ai-commit-btn${busy ? ' busy' : ''}`}
      disabled={disabled && !busy}
      onClick={run}
      title={busy ? 'Stop generating' : 'Generate commit message with AI'}
      aria-label={busy ? 'Stop generating the commit message' : 'Generate commit message'}
    >
      {busy ? (
        <span className="ai-spin-wrap">
          <LoaderCircle size={14} className="spin" />
          <X size={9} className="ai-stop" />
        </span>
      ) : (
        <Sparkles size={14} />
      )}
    </button>
  )
}
