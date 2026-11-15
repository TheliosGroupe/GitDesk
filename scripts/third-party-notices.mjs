// Writes build/THIRD_PARTY_NOTICES.txt: the license of every third-party package whose code
// ships in the app (see scripts/lib/notices.mjs). Runs in `npm run build`, before
// electron-vite; electron-builder copies the file to the app's resources folder
// (process.resourcesPath/THIRD_PARTY_NOTICES.txt, electron-builder.yml → extraResources).
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  assertNoLocalPaths,
  bundledPackages,
  findPackageDir,
  nodePtyBundledNotices,
  packageNotice,
  productionPackages,
  renderNotices,
  sourceFiles
} from './lib/notices.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'build', 'THIRD_PARTY_NOTICES.txt')

/** `npm ls` as JSON. It exits non-zero on any tree problem (extraneous, invalid…) but still prints the tree. */
function npmTree() {
  const args = ['ls', '--omit=dev', '--all', '--json', '--long']
  // Under `npm run`, npm_execpath is npm's own CLI script: run it with this Node.
  const npmCli = process.env.npm_execpath
  const [command, argv, shell] =
    npmCli && /\.[cm]?js$/.test(npmCli)
      ? [process.execPath, [npmCli, ...args], false]
      : ['npm', args, process.platform === 'win32']
  let stdout
  try {
    stdout = execFileSync(command, argv, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell
    })
  } catch (e) {
    if (!e.stdout) throw e
    stdout = e.stdout
  }
  return JSON.parse(stdout)
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const sources = sourceFiles(join(root, 'src')).map((file) => readFileSync(file, 'utf8'))

const packages = new Map()
for (const pkg of [...productionPackages(npmTree()), ...bundledPackages(root, manifest, sources)]) {
  packages.set(`${pkg.name}@${pkg.version}`, pkg)
}
const entries = [...packages.values()].map((pkg) => packageNotice(pkg))

// Vite injects its module-preload helper into the renderer bundle: its own license only
// (the rest of its LICENSE.md covers the dependencies of Vite's build tooling).
const vite = findPackageDir('vite', root, root)
if (vite)
  entries.push(packageNotice({ dir: vite }, { trimAt: '# Licenses of bundled dependencies' }))

const nodePty = findPackageDir('node-pty', root, root)
if (nodePty) entries.push(...nodePtyBundledNotices(nodePty))

const text = renderNotices(entries)
assertNoLocalPaths(text, root)
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, text)
console.log(`third-party-notices: ${entries.length} components → build/THIRD_PARTY_NOTICES.txt`)
