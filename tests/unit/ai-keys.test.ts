import { describe, expect, it } from 'vitest'
import {
  explainKeyRejection,
  keyElsewhereMessage,
  keyMatches,
  parseKeyFile
} from '../../src/main/ai/keyBinding'
import { AiError, DEFAULT_ENDPOINTS, endpointFor } from '../../src/main/ai/providers'

describe('AI keys are bound to an endpoint', () => {
  it('reads keys saved before binding as bound to the default endpoint', () => {
    expect(parseKeyFile({ anthropic: 'ENC1', openai: 'ENC2', other: 'x', ollama: 42 })).toEqual({
      anthropic: { enc: 'ENC1', endpoint: DEFAULT_ENDPOINTS.anthropic },
      openai: { enc: 'ENC2', endpoint: DEFAULT_ENDPOINTS.openai }
    })
  })

  it('reads bound keys and drops malformed entries', () => {
    const file = parseKeyFile({
      openai: { enc: 'E', endpoint: 'https://proxy.example.test/v1' },
      anthropic: { enc: 'E' },
      ollama: { enc: '', endpoint: 'http://localhost:11434/v1' }
    })
    expect(file).toEqual({ openai: { enc: 'E', endpoint: 'https://proxy.example.test/v1' } })
    expect(parseKeyFile(null)).toEqual({})
    expect(parseKeyFile('nope')).toEqual({})
  })

  it('hands a key out only for the endpoint it was saved for', () => {
    const saved = { enc: 'E', endpoint: endpointFor('openai', 'https://proxy.example.test/v1/') }
    expect(keyMatches(saved, endpointFor('openai', 'https://proxy.example.test/v1'))).toBe(true)
    // Another host, another path or the default endpoint: the key is not sent.
    expect(keyMatches(saved, endpointFor('openai', 'https://other.example.test/v1'))).toBe(false)
    expect(keyMatches(saved, endpointFor('openai', 'https://proxy.example.test/v2'))).toBe(false)
    expect(keyMatches(saved, endpointFor('openai', ''))).toBe(false)
    expect(keyMatches(saved, null)).toBe(false)
    expect(keyMatches(undefined, saved.endpoint)).toBe(false)
  })

  it('explains why no key was sent when it belongs to another address', () => {
    const lan = 'http://192.168.1.20:8080/v1'
    const msg = keyElsewhereMessage('ollama', DEFAULT_ENDPOINTS.ollama, lan, null)
    expect(msg).toContain(DEFAULT_ENDPOINTS.ollama)
    expect(msg).toContain(lan)
    expect(keyElsewhereMessage('ollama', lan, lan, null)).toBeNull()
    expect(keyElsewhereMessage('openai', null, lan, null)).toBeNull()
    expect(keyElsewhereMessage('openai', DEFAULT_ENDPOINTS.openai, lan, 'k')).toBeNull()
    // A local server that asks for the key: the 401 says why, other errors are kept.
    const rejected = explainKeyRejection(new AiError('401', 401), msg)
    expect((rejected as Error).message).toBe(msg)
    const other = new AiError('boom', 500)
    expect(explainKeyRejection(other, msg)).toBe(other)
    const unauth = new AiError('401', 401)
    expect(explainKeyRejection(unauth, null)).toBe(unauth)
  })
})
