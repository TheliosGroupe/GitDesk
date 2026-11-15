import { GitPullRequest, LoaderCircle, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  PROVIDER_LABELS,
  type LinkedIssue,
  type PullRequestDefaults
} from '../../../../shared/features/hosting'
import { errorMessage } from '../../lib/format'
import { newRequestId, useAiAvailable } from '../ai/useAi'
import { withheldText } from '../ai/withheld'
import { Modal } from '../ui'
import { useToasts } from '../ui-context'
import '../../assets/hosting.css'

/** "feature/add-dark-mode" -> "Add dark mode". */
function titleFromBranch(branch: string): string {
  const last = branch.split('/').pop() ?? branch
  const words = last.replace(/[-_]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : branch
}

/** Title and body prefilled from the issue the branch was created from. */
function issuePrefill(issue: LinkedIssue): { title: string; body: string } {
  if (issue.source === 'github' || issue.source === 'gitlab') {
    return { title: issue.title, body: issue.number !== null ? `Closes #${issue.number}` : '' }
  }
  return { title: `${issue.key}: ${issue.title}`, body: issue.url }
}

export function CreatePullRequestDialog({
  repo,
  branch,
  onClose,
  onCreated
}: {
  repo: string
  branch: string
  onClose(): void
  onCreated(url: string): void
}): React.JSX.Element {
  const toasts = useToasts()
  const [defaults, setDefaults] = useState<PullRequestDefaults | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [base, setBase] = useState('')
  const [title, setTitle] = useState(titleFromBranch(branch))
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState<'push' | 'create' | 'ai' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The AI contract is part of window.api (src/shared/features/ai.ts): typed, no cast.
  const ai = useAiAvailable()
  const aiRequest = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (aiRequest.current) void window.api.aiCancel(aiRequest.current)
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    window.api.pullRequestDefaults(repo, branch).then(
      (d) => {
        if (cancelled) return
        setDefaults(d)
        setBase(d.defaultBase ?? d.bases.find((b) => b !== branch) ?? '')
        if (d.linkedIssue) {
          const pre = issuePrefill(d.linkedIssue)
          setTitle(pre.title)
          setBody(pre.body)
        }
      },
      (e) => !cancelled && setLoadError(errorMessage(e))
    )
    return () => {
      cancelled = true
    }
  }, [repo, branch])

  const generate = async (): Promise<void> => {
    if (!ai || !base) return
    setBusy('ai')
    setError(null)
    try {
      const requestId = newRequestId()
      aiRequest.current = requestId
      const text = await window.api.aiPullRequestText(repo, base, branch, requestId)
      setTitle(text.title)
      // Files that look like secrets: only their names were sent.
      if (text.withheld?.length) toasts.info(withheldText(text.withheld))
      const closes = defaults?.linkedIssue ? issuePrefill(defaults.linkedIssue).body : ''
      setBody(closes && !text.body.includes(closes) ? `${text.body}\n\n${closes}` : text.body)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      aiRequest.current = null
      setBusy(null)
    }
  }

  const create = async (): Promise<void> => {
    if (!defaults) return
    setError(null)
    try {
      if (!defaults.hasUpstream) {
        setBusy('push')
        await window.api.push(repo, false)
      }
      setBusy('create')
      const { url } = await window.api.createPullRequest(repo, {
        head: branch,
        base,
        title: title.trim(),
        body,
        draft: defaults.supportsDraft && draft
      })
      toasts.info(`Pull request created: ${url}`)
      onCreated(url)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const providerName = defaults ? PROVIDER_LABELS[defaults.provider] : 'the provider'
  const term = defaults?.provider === 'gitlab' ? 'merge request' : 'pull request'
  const bases = defaults
    ? [
        ...new Set([...(defaults.defaultBase ? [defaults.defaultBase] : []), ...defaults.bases])
      ].filter((b) => b !== branch)
    : []

  return (
    <Modal title={`Create ${term}`} onClose={() => !busy && onClose()} wide>
      {loadError ? (
        <>
          <p className="error-text">{loadError}</p>
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : !defaults ? (
        <div className="waiting">
          <LoaderCircle size={16} className="spin" /> Reading the repository…
        </div>
      ) : (
        <>
          <p className="help">
            {providerName} · {defaults.host}/{defaults.slug}
            {!defaults.hasUpstream && ` · ${branch} is pushed to origin first`}
          </p>
          {!defaults.canCreate && (
            <p className="status warn pr-create-warning">
              Sign in to {providerName} ({defaults.host}) with an account that can write to this
              repository, in Settings → Integrations.
            </p>
          )}
          <div className="field-row pr-create-branches">
            <div className="field">
              <label htmlFor="pr-base">Into</label>
              <select
                id="pr-base"
                className="input"
                value={base}
                onChange={(e) => setBase(e.target.value)}
              >
                {!bases.length && <option value="">No branch on origin</option>}
                {bases.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <span className="pr-create-arrow">←</span>
            <div className="field">
              <span className="field-label">From</span>
              <span className="input mono pr-create-head" title={branch}>
                {branch}
              </span>
            </div>
          </div>
          <div className="field">
            <div className="pr-create-title-row">
              <label htmlFor="pr-title">Title</label>
              {ai && (
                <button
                  className="btn small"
                  disabled={!!busy || !base}
                  onClick={() => void generate()}
                  title="Write the title and description from the commits"
                >
                  {busy === 'ai' ? (
                    <LoaderCircle size={13} className="spin" />
                  ) : (
                    <Sparkles size={13} />
                  )}
                  Generate with AI
                </button>
              )}
            </div>
            <input
              id="pr-title"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="pr-body">Description</label>
            <textarea
              id="pr-body"
              className="input pr-create-body"
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          {defaults.linkedIssue && (
            <p className="help">
              Linked issue: <strong>{defaults.linkedIssue.key}</strong> {defaults.linkedIssue.title}
            </p>
          )}
          {defaults.supportsDraft && (
            <label className="check-row">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              Create as draft
            </label>
          )}
          {error && <p className="error-text">{error}</p>}
          <div className="modal-actions">
            <button className="btn" onClick={onClose} disabled={!!busy}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={!!busy || !defaults.canCreate || !base || !title.trim()}
              onClick={() => void create()}
            >
              {busy === 'push' || busy === 'create' ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <GitPullRequest size={14} />
              )}
              {busy === 'push' ? 'Pushing…' : busy === 'create' ? 'Creating…' : `Create ${term}`}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
