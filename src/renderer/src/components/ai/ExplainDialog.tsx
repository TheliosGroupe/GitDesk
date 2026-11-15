import { Copy, LoaderCircle, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { AiExplainTarget } from '../../../../shared/features/ai'
import { errorMessage } from '../../lib/format'
import { Modal } from '../ui'
import { useToasts } from '../ui-context'
import { Markdown } from './Markdown'
import { useAiRequest, useAiStatus } from './useAi'
import { WithheldNote } from './WithheldNote'
import '../../assets/ai.css'

function titleOf(target: AiExplainTarget): string {
  return target.kind === 'commit'
    ? `Explain commit ${target.sha.slice(0, 7)}`
    : `Explain branch ${target.branch}`
}

/** Modal with the model's explanation of a commit or a branch, streamed as it is written. */
export function ExplainDialog({
  repo,
  target,
  onClose
}: {
  repo: string
  target: AiExplainTarget
  onClose(): void
}): React.JSX.Element {
  const toasts = useToasts()
  const status = useAiStatus()
  const [attempt, setAttempt] = useState(0)
  const targetKey = JSON.stringify(target)
  const request = useAiRequest(
    (id) => window.api.aiExplain(repo, JSON.parse(targetKey) as AiExplainTarget, id),
    `${repo}\n${targetKey}\n${attempt}`
  )
  const busy = !request.done
  const text = request.result?.text || request.streamed
  const withheld = request.result?.withheld ?? []
  const result = request.done ? { error: request.error } : null
  const run = (): void => setAttempt((n) => n + 1)

  const copy = (): void => {
    navigator.clipboard.writeText(text).then(
      () => toasts.info('Explanation copied.'),
      (e) => toasts.error(errorMessage(e))
    )
  }

  return (
    <Modal title={titleOf(target)} onClose={onClose} wide>
      <div className="ai-explain" aria-busy={busy}>
        {text ? <Markdown text={text} /> : null}
        {busy && (
          <div className="ai-working">
            <LoaderCircle size={14} className="spin" />
            {text ? 'Writing…' : `Asking ${status?.model || 'the model'}…`}
          </div>
        )}
        {result?.error && <div className="empty-state error">{result.error}</div>}
      </div>
      <WithheldNote paths={withheld} />
      <div className="ai-privacy-line">
        The diff was sent to {status?.provider === 'ollama' ? status.endpoint : 'your AI provider'}.
        AI explanations can be wrong: check the code.
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={copy} disabled={!text}>
          <Copy size={14} /> Copy
        </button>
        <button className="btn" onClick={run} disabled={busy}>
          <RefreshCw size={14} /> Regenerate
        </button>
        <span className="spacer" />
        {busy && (
          <button className="btn" onClick={request.cancel}>
            Stop
          </button>
        )}
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
