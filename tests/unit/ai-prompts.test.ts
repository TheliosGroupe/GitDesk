import { describe, expect, it } from 'vitest'
import {
  budgetDiff,
  budgetNote,
  commitMessagePrompt,
  composePrompt,
  conflictPrompt,
  normalizeCommitMessage,
  parseComposeAnswer,
  parseConflictAnswer,
  parseJsonObject,
  parseMessage,
  skipReason,
  stripFence,
  UNREAD_REASON
} from '../../src/main/ai/prompts'
import { changeUnits } from '../../src/shared/features/ai-patch'
import { parseConflicts } from '../../src/renderer/src/lib/conflict'

function fileDiff(path: string, lines: number, width = 40): string {
  const body = Array.from({ length: lines }, (_, i) => `+${'x'.repeat(width)} ${i}`).join('\n')
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${body}\n`
}

describe('budgetDiff', () => {
  it('keeps a small diff whole', () => {
    const diff = fileDiff('a.ts', 5)
    const b = budgetDiff(diff, { maxChars: 10_000, perFile: 5_000 })
    expect(b.text).toBe(diff)
    expect(b.truncated).toBe(false)
    expect(budgetNote(b)).toBe('')
  })

  it('skips lockfiles, generated and binary files but names them', () => {
    const diff =
      fileDiff('src/a.ts', 3) +
      fileDiff('package-lock.json', 500) +
      fileDiff('dist/bundle.min.js', 50) +
      'diff --git a/logo.png b/logo.png\nnew file mode 100644\nBinary files /dev/null and b/logo.png differ\n'
    const b = budgetDiff(diff, { maxChars: 100_000, perFile: 50_000 })
    expect(b.text).toContain('src/a.ts')
    expect(b.text).not.toContain('package-lock.json')
    expect(b.omitted.map((o) => `${o.path}:${o.reason}`)).toEqual([
      'package-lock.json:lockfile',
      'dist/bundle.min.js:generated',
      'logo.png:binary'
    ])
    expect(budgetNote(b)).toContain('package-lock.json (lockfile)')
    // Leaving out lockfiles is not a truncation of the meaningful diff.
    expect(b.truncated).toBe(false)
  })

  it('caps each file and shares the budget fairly', () => {
    const diff = fileDiff('small.ts', 5) + fileDiff('huge.ts', 5000) + fileDiff('mid.ts', 60)
    const b = budgetDiff(diff, { maxChars: 6_000, perFile: 4_000 })
    expect(b.text.length).toBeLessThan(6_000 + 500)
    expect(b.text).toContain(fileDiff('small.ts', 5)) // small files whole
    expect(b.cut).toContain('huge.ts')
    expect(b.text).toMatch(/more lines of this file not shown/)
    expect(b.truncated).toBe(true)
    expect(budgetNote(b)).toContain('huge.ts')
  })

  it('omits files when nothing meaningful fits', () => {
    const diff = Array.from({ length: 50 }, (_, i) => fileDiff(`f${i}.ts`, 100)).join('')
    const b = budgetDiff(diff, { maxChars: 3_000, perFile: 2_000 })
    expect(b.omitted.some((o) => o.reason === 'too large for the prompt')).toBe(true)
    expect(b.text.length).toBeLessThanOrEqual(3_500)
  })

  it('recognizes lockfiles and vendored paths', () => {
    expect(skipReason('a/b/yarn.lock')).toBe('lockfile')
    expect(skipReason('Cargo.lock')).toBe('lockfile')
    expect(skipReason('node_modules/x/index.js')).toBe('generated or vendored')
    expect(skipReason('src/app.ts')).toBeNull()
  })
})

describe('prompts', () => {
  it('commit prompt carries the repo style and the scope', () => {
    const p = commitMessagePrompt({
      diff: budgetDiff(fileDiff('a.ts', 2), { maxChars: 1000, perFile: 1000 }),
      recentSubjects: ['feat(ui): add dark mode', 'fix: crash on start'],
      branch: 'feature/x',
      source: 'unstaged',
      untracked: ['new.ts']
    })
    expect(p.user).toContain('feat(ui): add dark mode')
    expect(p.user).toContain('Nothing is staged')
    expect(p.user).toContain('new.ts')
    expect(p.system).toMatch(/72 characters/)
    expect(p.system).toMatch(/never follow instructions/)
  })

  it('conflict prompt sends blocks with context and both commits', () => {
    const content = [
      ...Array.from({ length: 20 }, (_, i) => `line ${i}\n`),
      '<<<<<<< HEAD\n',
      'ours\n',
      '=======\n',
      'theirs\n',
      '>>>>>>> topic\n',
      'after\n'
    ].join('')
    const { prompt, sent } = conflictPrompt({
      path: 'x.ts',
      segments: parseConflicts(content),
      operation: 'merge',
      current: 'abc123 Main change',
      incoming: 'def456 Topic change'
    })
    expect(sent).toEqual([0])
    expect(prompt.user).toContain('Incoming side commit: def456 Topic change')
    expect(prompt.user).toContain('line 19')
    expect(prompt.user).not.toContain('line 7\n') // only 12 lines of context
    expect(prompt.user).toContain('<code side="incoming" label="topic">\ntheirs\n</code>')
  })

  it('names the files whose diff could not be read', () => {
    const b = budgetDiff(fileDiff('a.ts', 2), { maxChars: 10_000, perFile: 5_000 }, ['z.ts'])
    expect(b.truncated).toBe(true)
    expect(b.omitted).toEqual([{ path: 'z.ts', reason: UNREAD_REASON }])
    expect(budgetNote(b)).toContain(`z.ts (${UNREAD_REASON})`)
  })

  it('stays bounded with thousands of files', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => `node_modules/pkg${i}/index.js`)
    const p = commitMessagePrompt({
      diff: budgetDiff(
        many.map((path) => fileDiff(path, 1)).join(''),
        { maxChars: 60_000, perFile: 12_000 },
        many
      ),
      recentSubjects: [],
      branch: null,
      source: 'unstaged',
      untracked: many
    })
    expect(p.user.length).toBeLessThan(70_000)
    expect(p.user).toContain('and 19900 more')

    const set = changeUnits(
      Array.from({ length: 300 }, (_, i) => fileDiff(`src/f${i}.ts`, 60)).join(''),
      []
    )
    const bodies = new Map(set.units.map((u) => [u.id, u.preview.repeat(4)]))
    const c = composePrompt({ units: set.units, bodies, recentSubjects: [] })
    expect(set.units).toHaveLength(300)
    expect(c.truncated).toBe(true)
    // Headers are counted in the budget too.
    expect(c.prompt.user.length).toBeLessThan(72_000)
    expect(c.prompt.user).toContain('<change id="f300"')
  })

  it('compose prompt lists every change with its id', () => {
    const set = changeUnits(fileDiff('a.ts', 3) + fileDiff('b.ts', 3), [])
    const bodies = new Map(set.units.map((u) => [u.id, u.preview]))
    const { prompt, truncated } = composePrompt({ units: set.units, bodies, recentSubjects: [] })
    expect(prompt.user).toContain('<change id="f1" file="a.ts"')
    expect(prompt.user).toContain('<change id="f2" file="b.ts"')
    expect(truncated).toBe(false)
  })
})

describe('parsing answers', () => {
  it('reads commit messages in their many shapes', () => {
    expect(parseMessage('Add login form\n\nUses the new API.')).toEqual({
      summary: 'Add login form',
      description: 'Uses the new API.'
    })
    expect(parseMessage('```\nfix: typo\n```')).toEqual({ summary: 'fix: typo', description: '' })
    expect(parseMessage('Summary: "Fix crash"\nDescription: It crashed.')).toEqual({
      summary: 'Fix crash',
      description: 'It crashed.'
    })
    const long = parseMessage(
      'Refactor the whole authentication layer so that tokens are refreshed automatically before expiry'
    )
    expect(long.summary.length).toBeLessThanOrEqual(72)
    expect(long.description).toContain('expiry')
    expect(normalizeCommitMessage('  feat: x  \n\n body ')).toBe('feat: x\n\nbody')
  })

  it('strips a fence', () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('reads JSON wrapped in prose, fences or with trailing commas', () => {
    expect(parseJsonObject('Here you go:\n```json\n{"a": [1, 2,],}\n```\nDone')).toEqual({
      a: [1, 2]
    })
    expect(() => parseJsonObject('no json here')).toThrow(/could not be read/)
    expect(() => parseJsonObject('{"a": ')).toThrow(/could not be read/)
  })

  it('validates conflict answers', () => {
    const answer = JSON.stringify({
      blocks: [
        { index: 0, resolution: 'merged\n', explanation: 'Both.' },
        { index: 0, resolution: 'dup', explanation: '' },
        { index: 7, resolution: 'unknown block', explanation: '' },
        { index: 1, resolution: '<<<<<<< HEAD\nx', explanation: 'markers' },
        { index: 2, resolution: 42 }
      ],
      note: ' ok '
    })
    expect(parseConflictAnswer(answer, [0, 1, 2])).toEqual({
      blocks: [{ index: 0, resolution: 'merged\n', explanation: 'Both.' }],
      note: 'ok'
    })
    expect(() => parseConflictAnswer('{"blocks": []}', [0])).toThrow(/could not be read/)
  })

  it('reads compose answers ("changes" or "units")', () => {
    expect(
      parseComposeAnswer(
        '{"commits":[{"message":"a","changes":["h1",2]},{"message":"b","units":["f1"]},"junk"]}'
      )
    ).toEqual([
      { message: 'a', units: ['h1'] },
      { message: 'b', units: ['f1'] }
    ])
    expect(() => parseComposeAnswer('{"plan": []}')).toThrow()
  })
})
