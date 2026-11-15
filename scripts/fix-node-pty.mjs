// postinstall: makes node-pty's macOS spawn-helper executable in node_modules (see
// scripts/lib/node-pty.mjs); electron-builder keeps that mode in app.asar.unpacked.
// Never fails the install: a broken terminal is caught by the "Check node-pty" CI step
// and by the afterPack hook (scripts/after-pack.mjs).
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { fixNodePty } from './lib/node-pty.mjs'

try {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const fixed = fixNodePty(join(root, 'node_modules', 'node-pty'))
  if (fixed.length) console.log(`fix-node-pty: made executable: ${fixed.join(', ')}`)
} catch (e) {
  console.warn(`fix-node-pty: skipped (${e?.message ?? e})`)
}
