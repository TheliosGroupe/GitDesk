// Collects the license of every third-party package whose code ships in GitDesk, for
// build/THIRD_PARTY_NOTICES.txt (scripts/third-party-notices.mjs):
// - the production dependencies and their own dependencies (copied to the app by
//   electron-builder), from `npm ls --omit=dev --all --json --long`;
// - the devDependencies electron-vite bundles into out/ because src/** imports them
//   (React, lucide-react, xterm.js, highlight.js…), with their own dependencies;
// - code shipped inside those packages under its own license (winpty and ConPTY in
//   node-pty) and Vite's runtime helpers in the renderer bundle.
import { builtinModules } from 'module'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, extname, isAbsolute, join, relative, sep } from 'path'

/** Not shipped as a package: electron-builder adds Electron's binary, with its own notices. */
const NOT_SHIPPED = new Set(['electron'])

/** The bare package name of an import specifier, or null for relative, built-in or aliased ones. */
export function packageName(specifier) {
  const s = specifier.split('?')[0]
  if (!s || s.startsWith('.') || s.startsWith('/') || s.includes(':') || s.startsWith('\\')) {
    return null
  }
  const parts = s.split('/')
  const name = s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (s.startsWith('@') && parts.length < 2) return null
  if (builtinModules.includes(name)) return null
  // Path aliases such as '@renderer/…' look like scoped names: callers keep only the
  // names they find in package.json.
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) ? name : null
}

/**
 * The packages a source file loads at run time: static and dynamic imports, re-exports,
 * require() and CSS @import. Type-only imports and exports are erased by the compiler and
 * left out.
 */
export function importedPackages(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\b(?:import|export)\s+type\s[^'"]*?\sfrom\s*['"][^'"]+['"]/g, ' ')
  const found = new Set()
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const name = packageName(match[1])
      if (name) found.add(name)
    }
  }
  return found
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css'])

/** Every source file under `dir` (recursively). */
export function sourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files.sort()
}

/**
 * The folder of package `name` as Node resolves it from `fromDir`: the nearest
 * node_modules/<name> going up, no higher than `rootDir`. Null when it is not installed.
 */
export function findPackageDir(name, fromDir, rootDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const rel = relative(rootDir, dir)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    dir = dirname(dir)
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** The dependencies a package needs at run time (not its peer or dev dependencies). */
function runtimeDependencies(manifest) {
  return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })
}

/**
 * The production packages of an `npm ls --omit=dev --all --json --long` tree, as
 * { name, version, dir }. Peer dependencies (npm lists them too) and Electron are left
 * out, with everything below them.
 */
export function productionPackages(tree) {
  const found = new Map()
  const visit = (node) => {
    // --long lists a package's own dependencies (no peers) in _dependencies.
    const own = node._dependencies ? new Set(Object.keys(node._dependencies)) : null
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (NOT_SHIPPED.has(name) || (own && !own.has(name))) continue
      if (child.missing || child.deduped || !child.version) continue
      const key = `${name}@${child.version}`
      if (found.has(key)) continue
      found.set(key, { name, version: child.version, dir: child.path })
      visit(child)
    }
  }
  visit(tree)
  return [...found.values()]
}

/**
 * The devDependencies the bundler inlines into the app (those that `src/**` imports), plus
 * their own run-time dependencies, as { name, version, dir }. Throws when one is not
 * installed: the notices must not silently miss shipped code.
 */
export function bundledPackages(rootDir, manifest, sources) {
  const dev = new Set(Object.keys(manifest.devDependencies ?? {}))
  const imported = new Set()
  for (const source of sources) {
    for (const name of importedPackages(source)) {
      if (dev.has(name) && !NOT_SHIPPED.has(name)) imported.add(name)
    }
  }
  const found = new Map()
  const add = (name, fromDir) => {
    const dir = findPackageDir(name, fromDir, rootDir)
    if (!dir) throw new Error(`${name} is bundled into the app but is not installed`)
    const pkg = readJson(join(dir, 'package.json'))
    const key = `${pkg.name}@${pkg.version}`
    if (found.has(key)) return
    found.set(key, { name: pkg.name, version: pkg.version, dir })
    for (const dep of runtimeDependencies(pkg)) add(dep, dir)
  }
  for (const name of [...imported].sort()) add(name, rootDir)
  return [...found.values()]
}

// LICENSE, LICENCE.md, COPYING.txt, LICENSE-MIT, LICENSE.BSD, NOTICE…
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-][\w-]+)*$/i
// …but not code or data that only has such a name (license-checker.js, licenseCheck.json).
const NOT_A_LICENSE = /\.(c?js|mjs|ts|json|node|sh|py)$/i

/** The license and notice files at the top of a package folder, sorted (LICENSE before NOTICE). */
export function licenseFiles(dir) {
  return readdirSync(dir)
    .filter(
      (name) =>
        LICENSE_FILE.test(name) && !NOT_A_LICENSE.test(name) && statSync(join(dir, name)).isFile()
    )
    .sort((a, b) => {
      const notice = (n) => (/^notice/i.test(n) ? 1 : 0)
      return notice(a) - notice(b) || a.localeCompare(b)
    })
}

/** A package.json `license` field as text ("MIT", "(MIT OR Apache-2.0)"…). */
export function declaredLicense(manifest) {
  const { license, licenses } = manifest
  if (typeof license === 'string') return license
  if (license?.type) return license.type
  if (Array.isArray(licenses)) return licenses.map((l) => l?.type ?? l).join(' OR ')
  return 'UNKNOWN'
}

/** A browsable URL for a package.json `repository` (or `homepage`), or ''. */
export function repositoryUrl(manifest) {
  const repo =
    typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  if (repo) {
    const shorthand = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/.exec(repo)
    if (shorthand) {
      const host =
        { gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[shorthand[1]] ?? 'github.com'
      return `https://${host}/${shorthand[2]}`
    }
    const url = repo
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^ssh:\/\/git@/, 'https://')
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/\.git$/, '')
    if (/^https?:\/\//.test(url)) return url
  }
  return typeof manifest.homepage === 'string' ? manifest.homepage : ''
}

/** The MIT license terms, after its title and copyright line. */
const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

/** Normalizes a license text: LF line endings, no trailing spaces or blank lines at the ends. */
function cleanText(text) {
  // A leading byte order mark (U+FEFF).
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '')
}

/**
 * One notice entry for the package in `dir`: its name, version, license, URL and the text
 * of its license (and NOTICE) files. `trimAt`, when given, cuts the text at that line (to
 * keep only the part that applies to the shipped code).
 */
export function packageNotice({ name, version, dir }, { trimAt } = {}) {
  const manifest = readJson(join(dir, 'package.json'))
  const files = licenseFiles(dir)
  let text = files
    .map((file) => {
      const body = cleanText(readFileSync(join(dir, file), 'utf8'))
      return files.length > 1 ? `${file}:\n\n${body}` : body
    })
    .join('\n\n')
  if (trimAt) {
    const at = text.indexOf(trimAt)
    if (at > 0) text = cleanText(text.slice(0, at))
  }
  if (!text) {
    // No license file: the license package.json declares (with the MIT text when it is MIT).
    const license = declaredLicense(manifest)
    const rawAuthor = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name
    // "Name <email> (url)" → "Name"
    const author = rawAuthor?.replace(/\s*[<(].*$/, '').trim()
    text = `This package includes no license file. It is distributed under the ${license} license${
      author ? ` by ${author}` : ''
    }.`
    if (license === 'MIT') {
      text += `\n\nMIT License\n\nCopyright (c) ${author ?? 'the authors'}\n\n${MIT_TEXT}`
    }
  }
  return {
    name: name ?? manifest.name,
    version: version ?? manifest.version,
    license: declaredLicense(manifest),
    url: repositoryUrl(manifest),
    text
  }
}

/**
 * Code node-pty ships under other licenses than its own: the winpty binaries
 * (winpty.dll, winpty-agent.exe; license in deps/winpty) and Microsoft's ConPTY
 * (conpty.dll, OpenConsole.exe, from the Windows Terminal project, MIT).
 */
export function nodePtyBundledNotices(ptyDir) {
  const notices = []
  const winptyLicense = join(ptyDir, 'deps', 'winpty', 'LICENSE')
  if (existsSync(winptyLicense)) {
    const versionFile = join(ptyDir, 'deps', 'winpty', 'VERSION.txt')
    notices.push({
      name: 'winpty',
      version: existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '',
      license: 'MIT',
      url: 'https://github.com/rprichard/winpty',
      text: cleanText(readFileSync(winptyLicense, 'utf8'))
    })
  }
  const prebuilds = join(ptyDir, 'prebuilds')
  const conpty =
    existsSync(join(ptyDir, 'third_party', 'conpty')) ||
    (existsSync(prebuilds) &&
      readdirSync(prebuilds).some((arch) => existsSync(join(prebuilds, arch, 'conpty'))))
  if (conpty) {
    const versions = existsSync(join(ptyDir, 'third_party', 'conpty'))
      ? readdirSync(join(ptyDir, 'third_party', 'conpty')).sort()
      : []
    notices.push({
      name: 'ConPTY (conpty.dll, OpenConsole.exe)',
      version: versions.join(', '),
      license: 'MIT',
      url: 'https://github.com/microsoft/terminal',
      text: `MIT License\n\nCopyright (c) Microsoft Corporation. All rights reserved.\n\n${MIT_TEXT}`
    })
  }
  return notices
}

const RULE = '='.repeat(80)
const THIN_RULE = '-'.repeat(80)

/** The notices file: a header, then each entry sorted by name and version. */
export function renderNotices(entries, { product = 'GitDesk' } = {}) {
  const sorted = [...entries].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en')
  )
  const header = [
    `${product}: third-party notices`,
    '',
    `${product} is distributed under the MIT License (see LICENSE). It includes the`,
    'third-party software listed below, each under its own license, reproduced in full.',
    '',
    'Electron and Chromium, which run the app, ship their own notices next to the',
    'executable (LICENSE and LICENSES.chromium.html).',
    '',
    `${sorted.length} components:`,
    ...sorted.map((e) => `  - ${e.name}${e.version ? ` ${e.version}` : ''} (${e.license})`)
  ].join('\n')
  const body = sorted.map((e) =>
    [
      RULE,
      `${e.name}${e.version ? ` ${e.version}` : ''}`,
      `License: ${e.license}`,
      ...(e.url ? [e.url] : []),
      THIN_RULE,
      e.text
    ].join('\n')
  )
  return `${[header, ...body].join('\n\n')}\n`
}

/** Fails when a notice would leak a local path (the build machine's user folder). */
export function assertNoLocalPaths(text, rootDir) {
  const needles = [rootDir, rootDir.split(sep).join('/')]
  for (const needle of needles) {
    if (needle && text.includes(needle)) throw new Error('The notices contain a local path')
  }
}
