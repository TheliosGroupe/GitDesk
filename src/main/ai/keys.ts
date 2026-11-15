import { app, safeStorage } from 'electron'
import { join } from 'path'
import { AI_PROVIDERS, type AiProviderId } from '../../shared/features/ai'
import { requireSecureStorage } from '../secureStorage'
import { readJsonStore, writeJsonAtomic } from '../store'
import { keyMatches, parseKeyFile, type KeyFile } from './keyBinding'

// AI API keys, encrypted with the OS key store (DPAPI on Windows, Keychain, libsecret) like
// the GitHub tokens in accounts.ts. They never leave the main process, and each one is only
// handed out for the endpoint it was saved for (see keyBinding.ts).

let stored: KeyFile | null = null
const cache = new Map<AiProviderId, string>()

function file(): string {
  return join(app.getPath('userData'), 'ai-keys.json')
}

function load(): KeyFile {
  if (stored) return stored
  try {
    stored = parseKeyFile(readJsonStore(file(), {}))
  } catch {
    stored = {}
  }
  return stored
}

function save(): void {
  // Readable by you only (POSIX); the keys inside are encrypted anyway.
  writeJsonAtomic(file(), load(), 0o600)
}

export function isProvider(p: unknown): p is AiProviderId {
  return typeof p === 'string' && (AI_PROVIDERS as readonly string[]).includes(p)
}

/** A key is stored for `provider` and may be sent to `endpoint`. */
export function hasKey(provider: AiProviderId, endpoint: string | null): boolean {
  return keyMatches(load()[provider], endpoint)
}

/** The endpoint the stored key of `provider` belongs to (null: no key). */
export function keyEndpoint(provider: AiProviderId): string | null {
  return load()[provider]?.endpoint ?? null
}

/** The key of `provider`, only when it was saved for `endpoint`. */
export function getKey(provider: AiProviderId, endpoint: string): string | null {
  const entry = load()[provider]
  if (!entry || !keyMatches(entry, endpoint)) return null
  const cached = cache.get(provider)
  if (cached) return cached
  try {
    const key = safeStorage.decryptString(Buffer.from(entry.enc, 'base64'))
    cache.set(provider, key)
    return key
  } catch {
    return null
  }
}

/** Stores the key of `provider` for `endpoint`, or removes it (null). */
export function setKey(provider: AiProviderId, key: string | null, endpoint: string | null): void {
  if (!isProvider(provider)) throw new Error('Unknown AI provider')
  const next = { ...load() }
  const clean = typeof key === 'string' ? key.trim() : ''
  if (clean) {
    if (clean.length > 4096 || /[\s\0]/.test(clean))
      throw new Error('This does not look like an API key.')
    if (!endpoint) throw new Error('Fix the base URL first: the key is saved for that address.')
    requireSecureStorage('the key cannot be saved.')
    next[provider] = { enc: safeStorage.encryptString(clean).toString('base64'), endpoint }
    cache.set(provider, clean)
  } else {
    delete next[provider]
    cache.delete(provider)
  }
  stored = next
  save()
}
