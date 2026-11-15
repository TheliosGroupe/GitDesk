import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

// Build and release settings that are easy to undo by accident.
const root = join(__dirname, '..', '..')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')

describe('electron-builder.yml fuses', () => {
  const fuses = read('electron-builder.yml').split('\nelectronFuses:\n')[1] ?? ''
  const fuse = (name: string): string | undefined =>
    new RegExp(`^  ${name}: (true|false)$`, 'm').exec(fuses)?.[1]

  it('turns off what the app does not need', () => {
    expect(fuse('grantFileProtocolExtraPrivileges')).toBe('false')
    expect(fuse('enableNodeOptionsEnvironmentVariable')).toBe('false')
    expect(fuse('enableNodeCliInspectArguments')).toBe('false')
    expect(fuse('enableEmbeddedAsarIntegrityValidation')).toBe('true')
    expect(fuse('onlyLoadAppFromAsar')).toBe('true')
  })
})

describe('renderer CSP', () => {
  const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(read('src/renderer/index.html'))
  const directives = new Map(
    (csp?.[1] ?? '').split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/)
      return [name, values.join(' ')] as const
    })
  )

  it('allows scripts from the bundle only, and no frames, plugins or <base>', () => {
    expect(directives.get('default-src')).toBe("'none'")
    expect(directives.get('script-src')).toBe("'self'")
    expect(directives.get('frame-src')).toBe("'none'")
    expect(directives.get('object-src')).toBe("'none'")
    expect(directives.get('base-uri')).toBe("'none'")
    expect(csp?.[1]).not.toMatch(/unsafe-eval|file:|\*/)
  })
})

describe('GitHub workflows', () => {
  const ci = read('.github/workflows/ci.yml')
  const release = read('.github/workflows/release.yml')

  it('pin every action to a commit', () => {
    for (const text of [ci, release]) {
      const uses = text.match(/uses: .+/g) ?? []
      expect(uses.length).toBeGreaterThan(0)
      for (const line of uses) expect(line).toMatch(/^uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d/)
    }
  })

  it('never leave the token in .git/config', () => {
    for (const text of [ci, release]) {
      const checkouts = text.match(/uses: actions\/checkout@/g)?.length ?? 0
      expect(text.match(/persist-credentials: false/g)?.length).toBe(checkouts)
    }
  })

  it('give the release build a read-only token and no GH_TOKEN', () => {
    expect(release).toMatch(/^permissions: \{\}$/m)
    const build = release.split('\n  build:\n')[1].split('\n  publish:\n')[0]
    expect(build).toMatch(/permissions:\n\s+contents: read/)
    expect(build).not.toMatch(/GH_TOKEN|contents: write|--publish always/)
  })
})
