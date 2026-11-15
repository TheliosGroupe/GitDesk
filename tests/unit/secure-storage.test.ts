import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({ available: true, backend: 'gnome_libsecret' }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => storage.available,
    getSelectedStorageBackend: () => storage.backend
  }
}))

import { requireSecureStorage, secureStorageProblem } from '../../src/main/secureStorage'

describe('secure storage for tokens and keys', () => {
  beforeEach(() => {
    storage.available = true
    storage.backend = 'gnome_libsecret'
  })

  it('allows saving when the key store protects secrets', () => {
    expect(secureStorageProblem('linux')).toBeNull()
    expect(secureStorageProblem('win32')).toBeNull()
    expect(secureStorageProblem('darwin')).toBeNull()
  })

  it('refuses when encryption is not available', () => {
    storage.available = false
    expect(secureStorageProblem('win32')).toBe('Secure storage is not available on this system.')
  })

  it("refuses Linux's built-in key (no keyring running)", () => {
    storage.backend = 'basic_text'
    expect(secureStorageProblem('linux')).toMatch(/No keyring is running/)
    // The backend only exists on Linux: other systems never report it.
    expect(secureStorageProblem('darwin')).toBeNull()
  })

  it('says what was not saved', () => {
    storage.available = false
    expect(() => requireSecureStorage('the key cannot be saved.')).toThrow(
      'Secure storage is not available on this system: the key cannot be saved.'
    )
    expect(() => requireSecureStorage()).toThrow('Secure storage is not available on this system.')
  })
})
