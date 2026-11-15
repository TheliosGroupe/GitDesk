// node-pty 1.1.0 publishes its macOS helper (prebuilds/darwin-*/spawn-helper) without the
// executable bit, so every terminal fails to start on macOS ("posix_spawnp failed").
// Used by scripts/fix-node-pty.mjs (postinstall) and scripts/after-pack.mjs (packaging).
import { chmodSync, statSync } from 'fs'
import { join } from 'path'

/** The helpers node-pty runs on macOS, relative to its package folder. */
export const SPAWN_HELPERS = [
  'prebuilds/darwin-arm64/spawn-helper',
  'prebuilds/darwin-x64/spawn-helper'
]

const EXECUTABLE = 0o755

/** Whether `file` exists and its owner, group and others can all run it. */
export function isExecutable(file) {
  try {
    return (statSync(file).mode & EXECUTABLE) === EXECUTABLE
  } catch {
    return false
  }
}

/**
 * Makes the spawn helpers under `ptyDir` executable and returns the ones it changed;
 * missing files are skipped and errors only warned about. Windows has no executable bit:
 * nothing to do there (the macOS build, which ships these files, installs on macOS).
 */
export function fixNodePty(ptyDir, { platform = process.platform, warn = console.warn } = {}) {
  if (platform === 'win32') return []
  const fixed = []
  for (const helper of SPAWN_HELPERS) {
    const file = join(ptyDir, helper)
    try {
      if ((statSync(file).mode & EXECUTABLE) === EXECUTABLE) continue
      chmodSync(file, EXECUTABLE)
      fixed.push(helper)
    } catch (e) {
      if (e?.code !== 'ENOENT')
        warn(`fix-node-pty: cannot make ${helper} executable: ${e?.message ?? e}`)
    }
  }
  return fixed
}
