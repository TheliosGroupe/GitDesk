import { Check, KeyRound, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { AiProviderId } from '../../../../shared/features/ai'
import type { AiProvider, AppState, Settings } from '../../../../shared/types'
import { errorMessage } from '../../lib/format'
import { refreshAiStatus, useAiStatus } from './useAi'
import '../../assets/ai.css'

const PROVIDERS: { value: AiProvider; label: string }[] = [
  { value: 'none', label: 'None (AI features off)' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'ollama', label: 'Local (Ollama or OpenAI-compatible)' }
]

const MODEL_SUGGESTIONS: Record<AiProviderId, string[]> = {
  anthropic: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
  openai: ['gpt-5-mini', 'gpt-5', 'gpt-5-nano'],
  ollama: ['llama3.1', 'qwen2.5-coder', 'mistral', 'gemma3']
}

const KEY_HELP: Record<AiProviderId, string> = {
  anthropic: 'Create one at console.anthropic.com → API keys.',
  openai: 'Create one at platform.openai.com → API keys.',
  ollama: 'Only if your server asks for one (Ollama does not).'
}

/** "AI" section of the Settings dialog. */
export function AiSettings({
  settings,
  onChange
}: {
  settings: Settings
  onChange(state: AppState): void
}): React.JSX.Element {
  const status = useAiStatus()
  const provider = settings.aiProvider
  const [model, setModel] = useState(settings.aiModel)
  const [baseUrl, setBaseUrl] = useState(settings.aiBaseUrl)
  const [key, setKey] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'error'; text: string }>({
    state: 'idle',
    text: ''
  })
  const [keyError, setKeyError] = useState<string | null>(null)

  const save = async (patch: Partial<Settings>): Promise<void> => {
    onChange(await window.api.setSettings(patch))
    setTest({ state: 'idle', text: '' })
    await refreshAiStatus()
  }

  /** Saves a base URL still being edited, so a key is bound to the address shown. */
  const commitBaseUrl = async (): Promise<void> => {
    if (provider !== 'anthropic' && baseUrl.trim() !== settings.aiBaseUrl)
      await save({ aiBaseUrl: baseUrl.trim() })
  }

  const saveKey = async (value: string | null): Promise<void> => {
    if (provider === 'none') return
    setKeyError(null)
    try {
      if (value) await commitBaseUrl()
      await window.api.aiSetKey(provider, value)
      setKey('')
      setReplacing(false)
      setTest({ state: 'idle', text: '' })
      await refreshAiStatus()
    } catch (e) {
      setKeyError(errorMessage(e))
    }
  }

  const runTest = async (): Promise<void> => {
    setTest({ state: 'busy', text: '' })
    try {
      setTest({ state: 'ok', text: await window.api.aiTest() })
    } catch (e) {
      setTest({ state: 'error', text: errorMessage(e) })
    }
  }

  const stored = provider !== 'none' && !!status?.keyStored[provider]
  const needsKey = provider === 'anthropic' || provider === 'openai'
  const defaultModel = provider === 'none' ? '' : (status?.defaultModel ?? '')

  return (
    <div className="ai-settings">
      <div className="field">
        <label htmlFor="settings-ai-provider">Provider</label>
        <select
          id="settings-ai-provider"
          className="input"
          value={provider}
          onChange={(e) => {
            setModel('')
            setBaseUrl('')
            setKey('')
            setReplacing(false)
            void save({ aiProvider: e.target.value as AiProvider, aiModel: '', aiBaseUrl: '' })
          }}
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="help">
          Commit messages, pull request descriptions, explanations, conflict suggestions and commit
          composition, with your own API key or a model running on your computer.
        </span>
      </div>

      {provider !== 'none' && (
        <>
          {provider !== 'anthropic' && (
            <div className="field">
              <label htmlFor="settings-ai-url">
                Base URL{provider === 'openai' ? ' (optional)' : ''}
              </label>
              <input
                id="settings-ai-url"
                className="input mono"
                value={baseUrl}
                spellCheck={false}
                placeholder={
                  provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1'
                }
                onChange={(e) => setBaseUrl(e.target.value)}
                onBlur={() =>
                  baseUrl.trim() !== settings.aiBaseUrl && void save({ aiBaseUrl: baseUrl.trim() })
                }
              />
              {status?.provider === provider && status.endpointError && (
                <span className="help error">{status.endpointError}</span>
              )}
              <span className="help">
                {provider === 'ollama'
                  ? 'Ollama, LM Studio, llama.cpp, vLLM… any server with an OpenAI-compatible /chat/completions endpoint.'
                  : 'For a proxy or another OpenAI-compatible service (https://). Changing it asks for the key again.'}
              </span>
            </div>
          )}

          <div className="field">
            <label htmlFor="settings-ai-key">API key{needsKey ? '' : ' (optional)'}</label>
            {stored && !replacing ? (
              <div className="field-row">
                <span className="ai-key-saved">
                  <Check size={14} /> Saved, encrypted on this computer
                </span>
                <button className="btn" onClick={() => setReplacing(true)}>
                  Replace…
                </button>
                <button className="btn danger" onClick={() => void saveKey(null)}>
                  Remove
                </button>
              </div>
            ) : (
              <form
                className="field-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (key.trim()) void saveKey(key)
                }}
              >
                <input
                  id="settings-ai-key"
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  placeholder={
                    provider === 'anthropic' ? 'sk-ant-…' : provider === 'openai' ? 'sk-…' : ''
                  }
                  onChange={(e) => setKey(e.target.value)}
                />
                <button type="submit" className="btn" disabled={!key.trim()}>
                  <KeyRound size={14} /> Save key
                </button>
                {replacing && (
                  <button type="button" className="btn" onClick={() => setReplacing(false)}>
                    Cancel
                  </button>
                )}
              </form>
            )}
            {keyError && <span className="help error">{keyError}</span>}
            {status?.provider === provider && status.keySavedFor && (
              <span className="help error">
                Your saved key belongs to {status.keySavedFor}, not to{' '}
                {status.endpoint || 'this base URL'}. GitDesk sends a key only to the address it was
                saved for: enter it again to use it here, or{' '}
                <button className="link-btn" onClick={() => void saveKey(null)}>
                  remove the saved key
                </button>
                .
              </span>
            )}
            {provider === 'anthropic' && status?.provider === provider && status.endpointError && (
              <span className="help error">{status.endpointError}</span>
            )}
            <span className="help">
              {KEY_HELP[provider]} The key is stored with your operating system’s encryption, never
              shown again, and only sent to the address it was saved for.
            </span>
          </div>

          <div className="field">
            <label htmlFor="settings-ai-model">Model</label>
            <input
              id="settings-ai-model"
              className="input mono"
              list="settings-ai-models"
              value={model}
              placeholder={defaultModel ? `${defaultModel} (default)` : ''}
              spellCheck={false}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() =>
                model.trim() !== settings.aiModel && void save({ aiModel: model.trim() })
              }
            />
            <datalist id="settings-ai-models">
              {MODEL_SUGGESTIONS[provider].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <span className="help">
              Leave empty for the default. Any model id of the provider works.
            </span>
          </div>

          <div className="field">
            <div className="field-row">
              <button
                className="btn"
                disabled={test.state === 'busy' || !status?.configured}
                onClick={runTest}
                title={status?.configured ? undefined : 'Save an API key first'}
              >
                {test.state === 'busy' && <LoaderCircle size={14} className="spin" />} Test
                connection
              </button>
              {test.state === 'ok' && (
                <span className="ai-test ok">
                  <Check size={14} /> {test.text}
                </span>
              )}
            </div>
            {test.state === 'error' && <pre className="ai-test error">{test.text}</pre>}
          </div>

          <div className="ai-privacy">
            <strong>Privacy:</strong>{' '}
            {provider === 'ollama'
              ? `Diffs, commit messages and conflicting code are sent to ${status?.endpoint || 'your local server'}. With a server on this computer, nothing leaves it.`
              : `When you use an AI feature, the diffs, commit messages and conflicting code it needs are sent to ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} with your key, under your agreement with them. Nothing is sent until you click an AI button.`}
          </div>
        </>
      )}
    </div>
  )
}
