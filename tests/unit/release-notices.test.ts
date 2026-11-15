import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertNoLocalPaths,
  bundledPackages,
  declaredLicense,
  findPackageDir,
  importedPackages,
  licenseFiles,
  nodePtyBundledNotices,
  packageName,
  packageNotice,
  productionPackages,
  renderNotices,
  repositoryUrl,
  sourceFiles
} from '../../scripts/lib/notices.mjs'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gitdesk-notices-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Writes files (relative path → content) under `dir`. */
function files(dir: string, contents: Record<string, string>): void {
  for (const [path, content] of Object.entries(contents)) {
    const file = join(dir, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }
}

/** A package in `dir`/node_modules/`name`, with the given package.json fields and files. */
function pkg(
  dir: string,
  name: string,
  manifest: Record<string, unknown> = {},
  extra: Record<string, string> = { LICENSE: `${name} license text\n` }
): string {
  const at = join(dir, 'node_modules', ...name.split('/'))
  files(at, {
    'package.json': JSON.stringify({ name, version: '1.0.0', license: 'MIT', ...manifest }),
    ...extra
  })
  return at
}

describe('packageName', () => {
  it('keeps the package of bare specifiers', () => {
    expect(packageName('react')).toBe('react')
    expect(packageName('react-dom/client')).toBe('react-dom')
    expect(packageName('@xterm/xterm/css/xterm.css')).toBe('@xterm/xterm')
    expect(packageName('highlight.js/lib/languages/yaml')).toBe('highlight.js')
    expect(packageName('lucide-react?raw')).toBe('lucide-react')
  })

  it('drops relative, absolute, built-in and protocol specifiers', () => {
    for (const s of [
      './x',
      '../x',
      '/abs',
      'fs',
      'fs/promises',
      'node:path',
      'virtual:x',
      '@scope',
      ''
    ]) {
      expect(packageName(s)).toBeNull()
    }
  })
})

describe('importedPackages', () => {
  it('finds static, dynamic, side-effect, require and CSS imports', () => {
    const source = `
      import { useState } from 'react'
      import {
        GitBranch,
        GitCommit
      } from 'lucide-react'
      import '@xterm/xterm/css/xterm.css'
      export * from 'highlight.js/lib/core'
      const m = await import('electron-updater')
      const pty = require('node-pty')
      @import url('font-pkg/index.css');
      import { join } from 'path'
      import { local } from './local'
    `
    expect([...importedPackages(source)].sort()).toEqual([
      '@xterm/xterm',
      'electron-updater',
      'font-pkg',
      'highlight.js',
      'lucide-react',
      'node-pty',
      'react'
    ])
  })

  it('ignores type-only imports and block comments', () => {
    const source = `
      import type { Terminal } from '@xterm/xterm'
      export type {
        Options
      } from 'some-types'
      /* import x from 'commented-out' */
      import { a } from 'real'
    `
    expect([...importedPackages(source)]).toEqual(['real'])
  })
})

describe('sourceFiles', () => {
  it('lists source files recursively, sorted', () => {
    files(root, {
      'src/b.ts': '',
      'src/a/c.tsx': '',
      'src/a/style.css': '',
      'src/index.html': '',
      'src/logo.svg': ''
    })
    const found = sourceFiles(join(root, 'src')).map((f: string) => f.slice(root.length + 1))
    expect(found).toEqual([
      join('src', 'a', 'c.tsx'),
      join('src', 'a', 'style.css'),
      join('src', 'b.ts')
    ])
  })
})

describe('findPackageDir', () => {
  it('resolves like Node: nested first, then up to the root', () => {
    const top = pkg(root, 'scheduler')
    const parent = pkg(root, 'react-dom')
    expect(findPackageDir('scheduler', parent, root)).toBe(top)
    const nested = pkg(parent, 'scheduler')
    expect(findPackageDir('scheduler', parent, root)).toBe(nested)
    expect(findPackageDir('missing', parent, root)).toBeNull()
  })

  it('handles scoped names and stops at the root', () => {
    const xterm = pkg(root, '@xterm/xterm')
    expect(findPackageDir('@xterm/xterm', root, root)).toBe(xterm)
    expect(
      findPackageDir('@xterm/xterm', join(root, 'elsewhere'), join(root, 'elsewhere'))
    ).toBeNull()
  })
})

describe('productionPackages', () => {
  it('walks the npm ls tree without peers, Electron or duplicates', () => {
    const tree = {
      name: 'gitdesk',
      _dependencies: { '@electron-toolkit/utils': '^4', 'electron-updater': '^6' },
      dependencies: {
        '@electron-toolkit/utils': {
          version: '4.0.0',
          path: '/x/utils',
          _dependencies: {},
          // A peer dependency: npm lists it, the app does not ship it.
          dependencies: { electron: { version: '44.0.0', path: '/x/electron' } }
        },
        'electron-updater': {
          version: '6.8.9',
          path: '/x/updater',
          _dependencies: { 'fs-extra': '^10', semver: '^7' },
          dependencies: {
            'fs-extra': {
              version: '10.1.0',
              path: '/x/fs-extra',
              _dependencies: { 'graceful-fs': '^4' },
              dependencies: { 'graceful-fs': { version: '4.2.11', path: '/x/graceful-fs' } }
            },
            semver: { version: '7.7.4', path: '/x/semver' }
          }
        },
        'graceful-fs': { version: '4.2.11', deduped: true },
        missing: { missing: true }
      }
    }
    expect(productionPackages(tree)).toEqual([
      { name: '@electron-toolkit/utils', version: '4.0.0', dir: '/x/utils' },
      { name: 'electron-updater', version: '6.8.9', dir: '/x/updater' },
      { name: 'fs-extra', version: '10.1.0', dir: '/x/fs-extra' },
      { name: 'graceful-fs', version: '4.2.11', dir: '/x/graceful-fs' },
      { name: 'semver', version: '7.7.4', dir: '/x/semver' }
    ])
  })
})

describe('bundledPackages', () => {
  it('keeps the imported devDependencies and their runtime dependencies', () => {
    pkg(root, 'react')
    pkg(root, 'react-dom', {
      dependencies: { scheduler: '^0.28' },
      peerDependencies: { react: '^19' }
    })
    pkg(root, 'scheduler')
    pkg(root, 'vitest')
    pkg(root, 'electron')
    const manifest = {
      dependencies: { 'node-pty': '^1' },
      devDependencies: { react: '^19', 'react-dom': '^19', vitest: '^3', electron: '^44' }
    }
    const sources = [
      "import { createRoot } from 'react-dom/client'",
      "import { app } from 'electron'\nimport pty from 'node-pty'\nimport { x } from '@renderer/x'"
    ]
    const names = bundledPackages(root, manifest, sources).map((p: { name: string }) => p.name)
    expect(names).toEqual(['react-dom', 'scheduler'])
  })

  it('fails when a bundled package is not installed', () => {
    const manifest = { devDependencies: { react: '^19' } }
    expect(() => bundledPackages(root, manifest, ["import 'react'"])).toThrow(/react/)
  })
})

describe('package metadata', () => {
  it('finds license and notice files, licenses first', () => {
    const dir = pkg(
      root,
      'multi',
      {},
      {
        'NOTICE.md': 'notice',
        'LICENSE-MIT': 'mit',
        'LICENSE-APACHE': 'apache',
        'LICENSE.BSD': 'bsd',
        'license-checker.js': 'not a license',
        'licenseCheck.json': '{}',
        'README.md': 'readme'
      }
    )
    expect(licenseFiles(dir)).toEqual(['LICENSE-APACHE', 'LICENSE-MIT', 'LICENSE.BSD', 'NOTICE.md'])
  })

  it('reads every form of the license field', () => {
    expect(declaredLicense({ license: 'MIT' })).toBe('MIT')
    expect(declaredLicense({ license: { type: 'ISC' } })).toBe('ISC')
    expect(declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      'MIT OR Apache-2.0'
    )
    expect(declaredLicense({})).toBe('UNKNOWN')
  })

  it('turns repository fields into browsable URLs', () => {
    expect(
      repositoryUrl({ repository: { url: 'git+https://github.com/facebook/react.git' } })
    ).toBe('https://github.com/facebook/react')
    expect(repositoryUrl({ repository: 'git://github.com/microsoft/node-pty.git' })).toBe(
      'https://github.com/microsoft/node-pty'
    )
    expect(repositoryUrl({ repository: 'git@github.com:a/b.git' })).toBe('https://github.com/a/b')
    expect(repositoryUrl({ repository: 'develar/lazy-val' })).toBe(
      'https://github.com/develar/lazy-val'
    )
    expect(repositoryUrl({ repository: 'gitlab:a/b' })).toBe('https://gitlab.com/a/b')
    expect(repositoryUrl({ homepage: 'https://example.com' })).toBe('https://example.com')
    expect(repositoryUrl({})).toBe('')
  })
})

describe('packageNotice', () => {
  it('reproduces the license file with normalized line endings', () => {
    const dir = pkg(
      root,
      'crlf',
      { repository: 'a/crlf' },
      { 'LICENSE.txt': '\uFEFFLine one  \r\nLine two\r\n\r\n' }
    )
    expect(packageNotice({ dir })).toEqual({
      name: 'crlf',
      version: '1.0.0',
      license: 'MIT',
      url: 'https://github.com/a/crlf',
      text: 'Line one\nLine two'
    })
  })

  it('labels each file when there are several', () => {
    const dir = pkg(root, 'dual', {}, { 'LICENSE-MIT': 'mit', 'LICENSE-APACHE': 'apache' })
    expect(packageNotice({ dir }).text).toBe('LICENSE-APACHE:\n\napache\n\nLICENSE-MIT:\n\nmit')
  })

  it('writes the MIT terms for a package without a license file', () => {
    const dir = pkg(
      root,
      'bare',
      { author: 'Jane Doe <jane@example.com> (https://example.com)' },
      {}
    )
    const { text } = packageNotice({ dir })
    expect(text).toMatch(
      /^This package includes no license file\. It is distributed under the MIT license by Jane Doe\./
    )
    expect(text).toContain('Copyright (c) Jane Doe\n\nPermission is hereby granted')
    expect(text).not.toContain('jane@example.com')
  })

  it('states a non-MIT license it cannot reproduce', () => {
    const dir = pkg(root, 'other', { license: 'ISC' }, {})
    expect(packageNotice({ dir }).text).toBe(
      'This package includes no license file. It is distributed under the ISC license.'
    )
  })

  it('cuts the text where asked', () => {
    const dir = pkg(
      root,
      'vite',
      {},
      { 'LICENSE.md': '# Core\nMIT core\n\n# Licenses of bundled dependencies\nlots' }
    )
    expect(packageNotice({ dir }, { trimAt: '# Licenses of bundled dependencies' }).text).toBe(
      '# Core\nMIT core'
    )
  })
})

describe('nodePtyBundledNotices', () => {
  it('adds winpty and ConPTY when node-pty ships them', () => {
    const pty = pkg(
      root,
      'node-pty',
      {},
      {
        LICENSE: 'node-pty',
        'deps/winpty/LICENSE':
          'The MIT License (MIT)\r\n\r\nCopyright (c) 2011-2016 Ryan Prichard\r\n',
        'deps/winpty/VERSION.txt': '0.4.4-dev\n',
        'third_party/conpty/1.23.251008001/win10-x64/conpty.dll': '',
        'prebuilds/win32-x64/conpty/conpty.dll': ''
      }
    )
    const notices = nodePtyBundledNotices(pty)
    expect(notices.map((n: { name: string; version: string }) => [n.name, n.version])).toEqual([
      ['winpty', '0.4.4-dev'],
      ['ConPTY (conpty.dll, OpenConsole.exe)', '1.23.251008001']
    ])
    expect(notices[0].text).toBe('The MIT License (MIT)\n\nCopyright (c) 2011-2016 Ryan Prichard')
    expect(notices[1].text).toContain('Copyright (c) Microsoft Corporation.')
  })

  it('adds nothing for a node-pty without them', () => {
    expect(nodePtyBundledNotices(pkg(root, 'node-pty'))).toEqual([])
  })
})

describe('renderNotices', () => {
  const entries = [
    { name: 'zeta', version: '2.0.0', license: 'ISC', url: '', text: 'zeta text' },
    {
      name: 'Alpha',
      version: '1.0.0',
      license: 'MIT',
      url: 'https://example.com/alpha',
      text: 'alpha text'
    },
    { name: 'winpty', version: '', license: 'MIT', url: '', text: 'winpty text' }
  ]

  it('lists the components, then each license, sorted by name', () => {
    const text = renderNotices(entries)
    expect(text.startsWith('GitDesk: third-party notices\n')).toBe(true)
    expect(text).toContain(
      '3 components:\n  - Alpha 1.0.0 (MIT)\n  - winpty (MIT)\n  - zeta 2.0.0 (ISC)'
    )
    expect(text).toContain(
      `${'='.repeat(80)}\nAlpha 1.0.0\nLicense: MIT\nhttps://example.com/alpha\n${'-'.repeat(80)}\nalpha text`
    )
    expect(text).toContain(`zeta 2.0.0\nLicense: ISC\n${'-'.repeat(80)}\nzeta text`)
    expect(text.indexOf('alpha text')).toBeLessThan(text.indexOf('winpty text'))
    expect(text.indexOf('winpty text')).toBeLessThan(text.indexOf('zeta text'))
    expect(text.endsWith('zeta text\n')).toBe(true)
    expect(text).not.toContain('\r')
  })

  it('is the same for the same input', () => {
    expect(renderNotices([...entries].reverse())).toBe(renderNotices(entries))
  })
})

describe('assertNoLocalPaths', () => {
  it('rejects a text that contains the project folder', () => {
    expect(() => assertNoLocalPaths(`see ${root}/node_modules`, root)).toThrow(/local path/)
    expect(() => assertNoLocalPaths(`see ${root.split('\\').join('/')}/x`, root)).toThrow(
      /local path/
    )
    expect(() => assertNoLocalPaths('MIT License', root)).not.toThrow()
  })
})
