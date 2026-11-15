import { describe, expect, it } from 'vitest'
import {
  conflictCount,
  mergeConflicts,
  parseConflicts,
  type ConflictBlock
} from '../../src/renderer/src/lib/conflict'

const FILE = [
  'top\n',
  '<<<<<<< HEAD\n',
  'ours 1\n',
  'ours 2\n',
  '=======\n',
  'theirs\n',
  '>>>>>>> feature\n',
  'middle\n',
  '<<<<<<< HEAD\n',
  'a\n',
  '=======\n',
  'b\n',
  '>>>>>>> feature\n',
  'end'
].join('')

describe('parseConflicts', () => {
  it('splits text and conflict blocks with their labels', () => {
    const segs = parseConflicts(FILE)
    expect(segs.map((s) => s.kind)).toEqual(['text', 'conflict', 'text', 'conflict', 'text'])
    const first = segs[1] as ConflictBlock
    expect(first).toMatchObject({
      index: 0,
      current: ['ours 1\n', 'ours 2\n'],
      incoming: ['theirs\n'],
      base: null,
      currentLabel: 'HEAD',
      incomingLabel: 'feature'
    })
    expect((segs[3] as ConflictBlock).index).toBe(1)
    expect(conflictCount(segs)).toBe(2)
  })

  it('reads the base section of diff3 / zdiff3 conflicts', () => {
    const segs = parseConflicts(
      '<<<<<<< ours\nx\n||||||| merged common ancestors\nbase\n=======\ny\n>>>>>>> theirs\n'
    )
    expect(segs[0]).toMatchObject({
      base: ['base\n'],
      baseLabel: 'merged common ancestors',
      current: ['x\n'],
      incoming: ['y\n']
    })
  })

  it('handles empty sides, CRLF and markers without labels', () => {
    const segs = parseConflicts('<<<<<<<\r\n=======\r\nnew\r\n>>>>>>>\r\n')
    expect(segs[0]).toMatchObject({
      current: [],
      incoming: ['new\r\n'],
      currentLabel: '',
      incomingLabel: ''
    })
  })

  it('ignores lines that only look like markers', () => {
    const text = '<<<<<<<< eight\n======== x\n<<<<<<<x\n'
    expect(conflictCount(parseConflicts(text))).toBe(0)
    expect(mergeConflicts(parseConflicts(text), [])).toBe(text)
  })

  it('keeps an unterminated block as text', () => {
    const text = 'a\n<<<<<<< HEAD\nb\n=======\nc\n'
    const segs = parseConflicts(text)
    expect(conflictCount(segs)).toBe(0)
    expect(mergeConflicts(segs, [])).toBe(text)
  })
})

describe('mergeConflicts', () => {
  const segs = parseConflicts(FILE)

  it('rebuilds the file unchanged when nothing is chosen', () => {
    expect(mergeConflicts(segs, [])).toBe(FILE)
  })

  it('applies each choice', () => {
    expect(mergeConflicts(segs, ['current', 'incoming'])).toBe(
      'top\nours 1\nours 2\nmiddle\nb\nend'
    )
    expect(mergeConflicts(segs, ['both', 'both'])).toBe(
      'top\nours 1\nours 2\ntheirs\nmiddle\na\nb\nend'
    )
  })

  it('keeps the markers of a block left unresolved', () => {
    expect(mergeConflicts(segs, [undefined, 'current'])).toBe(
      FILE.replace('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> feature\n', 'a\n')
    )
  })
})
