// Which endpoint each stored AI key belongs to. Pure (no Electron), so it is unit-tested.
//
// A key is sent only to the base URL it was saved for: pointing a provider at another
// address (by hand, or by a compromised renderer through setSettings) needs the key to be
// entered again, the way Jira and Linear tokens work.

import { AI_PROVIDERS, type AiProviderId } from '../../shared/features/ai'
import { AiError, DEFAULT_ENDPOINTS, PROVIDER_NAMES } from './providers'

export interface StoredKey {
  /** The key encrypted with the OS key store, base64. */
  enc: string
  /** The endpoint (endpointFor output) the key was saved for. */
  endpoint: string
}

export type KeyFile = Partial<Record<AiProviderId, StoredKey>>

/**
 * Reads ai-keys.json. Keys saved before keys were bound to an endpoint (a plain string) are
 * bound to the provider's default endpoint: one used with a custom base URL is asked again.
 */
export function parseKeyFile(raw: unknown): KeyFile {
  const out: KeyFile = {}
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  for (const p of AI_PROVIDERS) {
    const v = obj[p]
    if (typeof v === 'string' && v) out[p] = { enc: v, endpoint: DEFAULT_ENDPOINTS[p] }
    else if (v && typeof v === 'object') {
      const { enc, endpoint } = v as Record<string, unknown>
      if (typeof enc === 'string' && enc && typeof endpoint === 'string' && endpoint)
        out[p] = { enc, endpoint }
    }
  }
  return out
}

/** True when `entry` may be sent to `endpoint`. */
export function keyMatches(entry: StoredKey | undefined, endpoint: string | null): boolean {
  return !!entry && !!endpoint && entry.endpoint === endpoint
}

/**
 * Why no key is sent, when one is stored for another address (null otherwise): asked before
 * a request needing a key, or after a local server rejected one sent without it.
 */
export function keyElsewhereMessage(
  provider: AiProviderId,
  savedFor: string | null,
  endpoint: string,
  apiKey: string | null
): string | null {
  if (apiKey || !savedFor || savedFor === endpoint) return null
  return `Your ${PROVIDER_NAMES[provider]} API key was saved for ${savedFor}, and GitDesk sends a key only to the address it was saved for. Enter it again in Settings → AI to use it with ${endpoint}.`
}

/** A 401/403 from a server reached without the key saved for another address: say why. */
export function explainKeyRejection(e: unknown, elsewhere: string | null): unknown {
  const status = e instanceof AiError ? e.status : null
  return elsewhere && (status === 401 || status === 403) ? new AiError(elsewhere, status) : e
}
