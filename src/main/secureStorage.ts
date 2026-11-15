// Where tokens and API keys may be saved: only when the operating system's key store protects
// them (DPAPI on Windows, Keychain on macOS, a running keyring on Linux).

import { safeStorage } from 'electron'

/**
 * Why secrets cannot be saved on this system, or null when they can. On Linux without a
 * keyring (GNOME Keyring, KWallet…), Electron falls back to a key built into Chromium
 * ('basic_text'), which only hides them: GitDesk refuses to save them then.
 */
export function secureStorageProblem(platform: NodeJS.Platform = process.platform): string | null {
  if (!safeStorage.isEncryptionAvailable()) return 'Secure storage is not available on this system.'
  if (platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
    return 'No keyring is running (GNOME Keyring, KWallet…), so tokens and keys cannot be stored safely. Sign in to a desktop session with a keyring, then try again.'
  return null
}

/** Throws (with the reason) unless secrets can be saved; `suffix` says what was not saved. */
export function requireSecureStorage(suffix = ''): void {
  const problem = secureStorageProblem()
  if (problem) throw new Error(suffix ? `${problem.replace(/\.$/, '')}: ${suffix}` : problem)
}
