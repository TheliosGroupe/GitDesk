import { describe, expect, it } from 'vitest'
import {
  escapeIgnore,
  ignoreExtensionPattern,
  ignoreFilePattern
} from '../../src/renderer/src/lib/gitignore'

describe('escapeIgnore', () => {
  it('leaves plain names alone', () => {
    expect(escapeIgnore('src/notes.txt')).toBe('src/notes.txt')
    expect(escapeIgnore('a b/c#d!e.txt')).toBe('a b/c#d!e.txt')
  })

  it('escapes glob characters and backslashes', () => {
    expect(escapeIgnore('foo[1].txt')).toBe('foo\\[1\\].txt')
    expect(escapeIgnore('a*b?.txt')).toBe('a\\*b\\?.txt')
    expect(escapeIgnore('a\\b')).toBe('a\\\\b')
  })

  it('escapes a leading # or ! and trailing spaces', () => {
    expect(escapeIgnore('#x')).toBe('\\#x')
    expect(escapeIgnore('!y')).toBe('\\!y')
    expect(escapeIgnore('z  ')).toBe('z\\ \\ ')
  })
})

describe('ignore patterns', () => {
  it('anchors a file at the repository root', () => {
    expect(ignoreFilePattern('foo[1].txt')).toBe('/foo\\[1\\].txt')
    expect(ignoreFilePattern('#x')).toBe('/\\#x')
  })

  it('ignores an extension literally', () => {
    expect(ignoreExtensionPattern('log')).toBe('*.log')
    expect(ignoreExtensionPattern('t[x]')).toBe('*.t\\[x\\]')
  })
})
