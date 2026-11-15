// electron-builder afterPack hook (electron-builder.yml): runs once the app folder is
// written, before the fuses are flipped and the app is signed.
//
// macOS: node-pty's spawn-helper must be executable in app.asar.unpacked, or the built-in
// terminal cannot start a shell. electron-builder keeps the mode the file has in
// node_modules (set by scripts/fix-node-pty.mjs on install); this restores it if needed and
// fails the build rather than shipping a broken terminal.
import { join } from 'path'
import { SPAWN_HELPERS, fixNodePty, isExecutable } from './lib/node-pty.mjs'

/** node-pty's folder in a packaged app's resources folder. */
export function unpackedNodePty(resourcesDir) {
  return join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-pty')
}

/**
 * Makes the spawn helpers of a packaged app executable and returns the ones that are still
 * missing or not executable (an empty list when all is well).
 */
export function brokenSpawnHelpers(resourcesDir, platform = process.platform) {
  const ptyDir = unpackedNodePty(resourcesDir)
  fixNodePty(ptyDir, { platform })
  return SPAWN_HELPERS.filter((helper) => !isExecutable(join(ptyDir, helper)))
}

export default async function afterPack(context) {
  // A macOS app is only built on macOS (Windows has no executable bit to check).
  if (context.electronPlatformName !== 'darwin' || process.platform === 'win32') return
  const broken = brokenSpawnHelpers(context.packager.getResourcesDir(context.appOutDir))
  if (broken.length) {
    throw new Error(
      `node-pty's spawn-helper is missing or not executable in app.asar.unpacked: ${broken.join(', ')}`
    )
  }
}
