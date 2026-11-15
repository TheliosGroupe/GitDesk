import { describe, expect, it } from 'vitest'
import {
  classifyResolution,
  hasConflictMarkers,
  mergeConflicts,
  parseConflicts,
  textToBlockLines,
  type ConflictBlock,
  type Choice
} from '../../src/renderer/src/lib/conflict'

const FILE =
  'top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\nmid\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> topic\nend\n'

describe('AI choice in conflicts', () => {
  const segments = parseConflicts(FILE)
  const blocks = segments.filter((s): s is ConflictBlock => s.kind === 'conflict')

  it('merges an AI resolution as a fourth choice', () => {
    const choices: Choice[] = ['ai', 'incoming']
    const custom = [textToBlockLines('ours and theirs\ncombined', blocks[0]), undefined]
    expect(mergeConflicts(segments, choices, custom)).toBe(
      'top\nours and theirs\ncombined\nmid\nb\nend\n'
    )
  })

  it('an empty resolution removes the block; a missing one keeps the markers', () => {
    expect(mergeConflicts(segments, ['ai', 'current'], [[], undefined])).toBe('top\nmid\na\nend\n')
    expect(mergeConflicts(segments, ['ai', 'current'], [])).toContain('<<<<<<< HEAD\nours')
  })

  it('uses the block line endings', () => {
    const crlf = parseConflicts(FILE.replace(/\n/g, '\r\n'))
    const block = crlf.find((s): s is ConflictBlock => s.kind === 'conflict')!
    expect(textToBlockLines('x\ny\n', block)).toEqual(['x\r\n', 'y\r\n'])
    expect(textToBlockLines('', block)).toEqual([])
  })

  it('keeps a missing final newline when the block ended the file', () => {
    const file = 'top\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> topic'
    const block = parseConflicts(file).find((s): s is ConflictBlock => s.kind === 'conflict')!
    expect(textToBlockLines('c', block)).toEqual(['c'])
  })

  it('shows where the lines of a suggestion come from', () => {
    const file =
      '<<<<<<< HEAD\nkeep()\ncheck(user)\nshared()\n=======\nshared()\nnewFeature()\n>>>>>>> topic\n'
    const block = parseConflicts(file).find((s): s is ConflictBlock => s.kind === 'conflict')!
    // Keeps incoming whole, silently drops "check(user)", adds a line from nowhere.
    const p = classifyResolution('keep()\nshared()\nnewFeature()\n\nsendTo(remote)\n', block)
    expect(p.lines.map((l) => l.origin)).toEqual(['current', 'both', 'incoming', 'blank', 'new'])
    expect(p.added).toBe(1)
    expect(p.dropped).toEqual({ current: 1, incoming: 0 })
    expect(p.total).toEqual({ current: 3, incoming: 2 })
    const both = classifyResolution('keep()\ncheck(user)\nshared()\nnewFeature()', block)
    expect(both.added).toBe(0)
    expect(both.dropped).toEqual({ current: 0, incoming: 0 })
    expect(classifyResolution('', block).dropped).toEqual({ current: 3, incoming: 2 })
  })

  it('detects leftover markers', () => {
    expect(hasConflictMarkers('a\n=======\nb')).toBe(true)
    expect(hasConflictMarkers('a == b\n========= heading')).toBe(false)
  })
})
