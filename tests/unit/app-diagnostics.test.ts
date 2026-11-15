import { describe, expect, it } from 'vitest'
import { API_METHODS, diagnosticsText, type AppInfo } from '../../src/shared/api'

const info: AppInfo = {
  version: '1.2.3',
  electron: '44.9.3',
  chromium: '146.0.7680.0',
  node: '24.11.0',
  os: 'macOS',
  osVersion: '15.1.0',
  arch: 'arm64',
  git: '2.50.1'
}

describe('Copy diagnostics', () => {
  it('lists the versions, one per line', () => {
    expect(diagnosticsText(info)).toBe(
      [
        'GitDesk v1.2.3',
        'OS: macOS 15.1.0 (arm64)',
        'Git: 2.50.1',
        'Electron: 44.9.3',
        'Chromium: 146.0.7680.0',
        'Node: 24.11.0'
      ].join('\n')
    )
  })

  it('says when git was not found', () => {
    expect(diagnosticsText({ ...info, git: null })).toContain('Git: not found')
  })

  it('holds only the facts it is given: no path, user or repository', () => {
    const text = diagnosticsText(info)
    expect(text).not.toMatch(/[\\/]|@|:\\|~/)
  })

  it('is part of the API the renderer can call', () => {
    expect(API_METHODS).toContain('appInfo')
    expect(API_METHODS).toContain('openThirdPartyNotices')
  })
})
