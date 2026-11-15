import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import afterPack, { brokenSpawnHelpers, unpackedNodePty } from '../../scripts/after-pack.mjs'
import { SPAWN_HELPERS, fixNodePty, isExecutable } from '../../scripts/lib/node-pty.mjs'

// Windows has no executable bit: the mode checks only run where it exists.
const posix = process.platform !== 'win32'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitdesk-pty-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A node-pty folder whose spawn helpers have the given mode, as npm installs them. */
function nodePty(root: string, helpers: string[] = SPAWN_HELPERS, mode = 0o644): string {
  for (const helper of helpers) {
    const file = join(root, helper)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'helper')
    chmodSync(file, mode)
  }
  return root
}

describe('fixNodePty', () => {
  it('lists both macOS helpers', () => {
    expect(SPAWN_HELPERS).toEqual([
      'prebuilds/darwin-arm64/spawn-helper',
      'prebuilds/darwin-x64/spawn-helper'
    ])
  })

  it.runIf(posix)('makes the spawn helpers executable, once', () => {
    const pty = nodePty(dir)
    expect(SPAWN_HELPERS.some((h) => isExecutable(join(pty, h)))).toBe(false)
    expect(fixNodePty(pty)).toEqual(SPAWN_HELPERS)
    for (const helper of SPAWN_HELPERS) {
      expect(statSync(join(pty, helper)).mode & 0o777).toBe(0o755)
    }
    expect(fixNodePty(pty)).toEqual([])
  })

  it('skips missing helpers without failing', () => {
    const warn = vi.fn()
    expect(fixNodePty(join(dir, 'nothing-here'), { warn })).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it.runIf(posix)('fixes the helpers that exist', () => {
    const pty = nodePty(dir, [SPAWN_HELPERS[1]])
    expect(fixNodePty(pty)).toEqual([SPAWN_HELPERS[1]])
  })

  it('does nothing on Windows', () => {
    const pty = nodePty(dir)
    expect(fixNodePty(pty, { platform: 'win32' })).toEqual([])
  })

  it('reports a missing file as not executable', () => {
    expect(isExecutable(join(dir, 'missing'))).toBe(false)
  })
})

describe('afterPack', () => {
  it('finds node-pty in app.asar.unpacked', () => {
    expect(unpackedNodePty(join(dir, 'Resources'))).toBe(
      join(dir, 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
    )
  })

  it.runIf(posix)('restores the mode in a packaged app', () => {
    const resources = join(dir, 'Resources')
    nodePty(unpackedNodePty(resources))
    expect(brokenSpawnHelpers(resources)).toEqual([])
    expect(isExecutable(join(unpackedNodePty(resources), SPAWN_HELPERS[0]))).toBe(true)
  })

  it.runIf(posix)('fails a macOS build whose app has no spawn-helper', async () => {
    const resources = join(dir, 'Resources')
    nodePty(unpackedNodePty(resources), [SPAWN_HELPERS[0]])
    expect(brokenSpawnHelpers(resources)).toEqual([SPAWN_HELPERS[1]])
    const context = {
      electronPlatformName: 'darwin',
      appOutDir: dir,
      packager: { getResourcesDir: () => resources }
    }
    await expect(afterPack(context)).rejects.toThrow(/darwin-x64\/spawn-helper/)
  })

  it('leaves Windows and Linux builds alone', async () => {
    const getResourcesDir = vi.fn()
    for (const platform of ['win32', 'linux']) {
      await afterPack({
        electronPlatformName: platform,
        appOutDir: dir,
        packager: { getResourcesDir }
      })
    }
    expect(getResourcesDir).not.toHaveBeenCalled()
  })
})
