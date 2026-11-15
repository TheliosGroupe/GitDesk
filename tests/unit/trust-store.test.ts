import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const base = mkdtempSync(join(tmpdir(), 'gitdesk-trust-store-'))
let userData = base
const warnings: string[] = []

vi.mock('electron', () => ({
  app: { getPath: () => userData, isReady: () => true, whenReady: () => Promise.resolve() },
  dialog: {
    showMessageBox: (o: { detail: string }) => {
      warnings.push(o.detail)
      return Promise.resolve({ response: 0 })
    }
  }
}))

/** A fresh store module (its state is cached per module) on a fresh folder. */
async function freshStore(): Promise<typeof import('../../src/main/store')> {
  vi.resetModules()
  return import('../../src/main/store')
}

beforeEach(() => {
  userData = mkdtempSync(join(base, 'data-'))
  warnings.length = 0
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('a damaged gitdesk.json', () => {
  it('is kept aside, never overwritten, and the user is told', async () => {
    const damaged = '{ "repos": ["C:/one", "C:/two"], }'
    writeFileSync(join(userData, 'gitdesk.json'), damaged)
    const store = await freshStore()
    expect(store.loadState().repos).toEqual([])
    const backups = readdirSync(userData).filter((f) => f.startsWith('gitdesk.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(warnings[0]).toContain(backups[0])

    store.addRepos([join(userData, 'repo')])
    expect(readFileSync(join(userData, backups[0]), 'utf8')).toBe(damaged)
    expect(JSON.parse(readFileSync(join(userData, 'gitdesk.json'), 'utf8')).repos).toHaveLength(1)
  })

  it('reads a file with a BOM, and a missing file quietly', async () => {
    writeFileSync(join(userData, 'gitdesk.json'), '\uFEFF{ "repos": ["/r"] }')
    // In canonical form, as an older file is converted (C:\r on Windows).
    const canonical = join(realpathSync.native(resolve('/')), 'r')
    expect((await freshStore()).loadState().repos).toEqual([canonical])
    userData = mkdtempSync(join(base, 'empty-'))
    expect((await freshStore()).loadState().repos).toEqual([])
    expect(warnings).toEqual([])
  })

  it('readJsonStore works for other stores', async () => {
    const { readJsonStore, writeJsonAtomic } = await freshStore()
    const file = join(userData, 'accounts.json')
    expect(readJsonStore(file, [])).toEqual([])
    writeJsonAtomic(file, [{ id: 'a' }])
    expect(readJsonStore(file, [])).toEqual([{ id: 'a' }])
    expect(existsSync(file + '.tmp')).toBe(false)
    writeFileSync(file, '[{')
    expect(readJsonStore(file, [])).toEqual([])
    expect(existsSync(file)).toBe(false)
  })

  it('leaves a file it cannot read as it is, and does not save over it', async () => {
    const path = join(userData, 'gitdesk.json')
    const original = '{ "repos": ["/kept"] }'
    writeFileSync(path, original)
    vi.doMock('fs', async (importOriginal) => {
      const real = await importOriginal<typeof import('fs')>()
      const readFileSync = ((p: unknown, ...rest: unknown[]) => {
        if (String(p) === path)
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
        return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
      }) as typeof real.readFileSync
      return { ...real, default: { ...real, readFileSync }, readFileSync }
    })
    try {
      const store = await freshStore()
      expect(store.loadState().repos).toEqual([])
      store.addRepos([join(userData, 'repo')])
    } finally {
      vi.doUnmock('fs')
    }
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(readdirSync(userData).filter((f) => f.includes('.corrupt-'))).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')(
    'gives a private file its mode even over a temporary file left by a crash',
    async () => {
      const { writeJsonAtomic } = await freshStore()
      const file = join(userData, 'keys.json')
      writeFileSync(file + '.tmp', 'old', { mode: 0o644 })
      chmodSync(file + '.tmp', 0o644)
      writeJsonAtomic(file, { k: 1 }, 0o600)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ k: 1 })
    }
  )
})

describe('trust records', () => {
  it('are saved, survive a restart, stay out of the UI state and go with the repository', async () => {
    let store = await freshStore()
    const repo = join(userData, 'repo')
    store.addRepos([repo])
    store.setTrustRecord(repo, 'abc')
    // Windows paths match whatever their case.
    expect(store.trustRecord(process.platform === 'win32' ? repo.toUpperCase() : repo)).toBe('abc')
    expect('trustedRepos' in store.loadState()).toBe(false)

    store = await freshStore()
    expect(store.trustRecord(repo)).toBe('abc')
    // Other code saving the state keeps the records.
    store.saveState({ ...store.loadState() })
    expect((await freshStore()).trustRecord(repo)).toBe('abc')

    store = await freshStore()
    store.removeRepo(repo)
    expect(store.trustRecord(repo)).toBeNull()
  })
})
