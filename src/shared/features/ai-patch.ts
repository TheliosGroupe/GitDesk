// Pure helpers for "Compose commits with AI": the working-copy diff split into change units
// (hunks or whole files), rebuilding a file from a subset of its hunks, and plan validation.
// No Node or DOM APIs, so main, renderer and unit tests can all use it.

import type { AiChangeUnit, AiPlannedCommit } from './ai'

export interface PatchHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  header: string
  /** Body lines with their ' ', '+', '-' or '\' prefix, without '\n'. */
  lines: string[]
}

export interface FilePatch {
  path: string
  /** Header lines before the first hunk ("diff --git", "index", "---", "+++"…). */
  header: string[]
  status: AiChangeUnit['status']
  hunks: PatchHunk[]
  /** Whole patch text of this file (header and hunks). */
  text: string
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Unquotes a C-style quoted git path ("a/caf\303\251.txt"). */
export function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p
  const body = p.slice(1, -1)
  const bytes: number[] = []
  const esc: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    '"': 34,
    '\\': 92,
    a: 7,
    b: 8,
    f: 12,
    v: 11
  }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '\\' && i + 1 < body.length) {
      const n = body[i + 1]
      if (/[0-7]/.test(n)) {
        bytes.push(parseInt(body.slice(i + 1, i + 4), 8))
        i += 3
      } else {
        bytes.push(esc[n] ?? n.charCodeAt(0))
        i += 1
      }
    } else {
      for (const b of new TextEncoder().encode(c)) bytes.push(b)
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function pathFromHeader(header: string[]): string {
  const plus = header.find((l) => l.startsWith('+++ '))
  const minus = header.find((l) => l.startsWith('--- '))
  const clean = (l: string, prefix: string): string | null => {
    const p = unquoteGitPath(l.slice(4).replace(/\t$/, ''))
    if (p === '/dev/null') return null
    return p.startsWith(prefix) ? p.slice(2) : p
  }
  const fromPlus = plus ? clean(plus, 'b/') : null
  if (fromPlus) return fromPlus
  const fromMinus = minus ? clean(minus, 'a/') : null
  if (fromMinus) return fromMinus
  // No ---/+++ lines (binary, mode change, empty file): "diff --git a/x b/x".
  const first = header[0] ?? ''
  const m = /^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*?)"?$/.exec(first)
  if (m) return m[2]
  return first.replace(/^diff --git /, '')
}

/** Splits the output of `git diff` (several files) into one patch per file. */
export function splitFilePatches(diff: string): FilePatch[] {
  const lines = diff.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const files: FilePatch[] = []
  let current: { header: string[]; hunks: PatchHunk[]; lines: string[] } | null = null
  let hunk: PatchHunk | null = null
  const finish = (): void => {
    if (!current) return
    const h = current.header
    const has = (prefix: string): boolean => h.some((l) => l.startsWith(prefix))
    let status: AiChangeUnit['status'] = 'M'
    if (has('Binary files') || has('GIT binary patch')) status = 'B'
    else if (has('new file mode')) status = 'A'
    else if (has('deleted file mode')) status = 'D'
    else if (has('old mode') || has('new mode') || h.some((l) => /^index \S+ 160000/.test(l)))
      status = 'T'
    if (h.some((l) => / 160000$/.test(l) || /^index \S+ 160000/.test(l))) status = 'T'
    files.push({
      path: pathFromHeader(h),
      header: h,
      status,
      hunks: current.hunks,
      text: current.lines.join('\n') + '\n'
    })
  }
  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      finish()
      current = { header: [line], hunks: [], lines: [line] }
      hunk = null
      continue
    }
    if (!current) continue
    current.lines.push(line)
    const m = line.startsWith('@@') ? HUNK_RE.exec(line) : null
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        header: line,
        lines: []
      }
      current.hunks.push(hunk)
    } else if (hunk) hunk.lines.push(line)
    else current.header.push(line)
  }
  finish()
  return files
}

/** Splits text into lines that keep their '\n'. */
function splitKeep(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/**
 * True when the hunk's body has exactly the old and new line counts of its "@@" header
 * (a diff cut short, or a malformed one, does not).
 */
export function hunkIsComplete(h: PatchHunk): boolean {
  let oldLines = 0
  let newLines = 0
  for (const line of h.lines) {
    const sign = line === '' ? ' ' : line[0]
    if (sign === '\\') continue
    if (sign !== ' ' && sign !== '-' && sign !== '+') return false
    if (sign !== '+') oldLines++
    if (sign !== '-') newLines++
  }
  return oldLines === h.oldCount && newLines === h.newCount
}

/**
 * Applies some hunks of a file's diff to its old content (the content the diff was made
 * from). Hunks must come from that one diff; they are applied by line number, so any subset
 * works. Throws when a hunk is incomplete or does not match the old content.
 */
export function applyHunks(oldText: string, hunks: PatchHunk[]): string {
  const old = splitKeep(oldText)
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart)
  const out: string[] = []
  let pos = 0 // index into old (0-based)
  for (const h of sorted) {
    if (!hunkIsComplete(h)) throw new Error(`Hunk ${h.header} is incomplete`)
    // A hunk that only adds lines at the very top has oldStart 0; otherwise oldStart is 1-based.
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1
    if (start < pos) throw new Error('Overlapping hunks')
    while (pos < start) out.push(old[pos++])
    let last: string | null = null
    for (const line of h.lines) {
      const sign = line === '' ? ' ' : line[0]
      const body = line.slice(1)
      if (sign === '\\') {
        // "\ No newline at end of file": the previous line has no '\n' on its side(s).
        if ((last === '+' || last === ' ') && out.length)
          out[out.length - 1] = out[out.length - 1].replace(/\n$/, '')
        continue
      }
      if (sign === '-' || sign === ' ') {
        const actual = old[pos]
        if (actual === undefined || actual.replace(/\n$/, '') !== body)
          throw new Error(`Hunk ${h.header} does not match the file`)
        pos++
      }
      if (sign === '+' || sign === ' ') out.push(body + '\n')
      last = sign
    }
  }
  while (pos < old.length) out.push(old[pos++])
  // The old file ended without '\n' and lines follow it now: they need a separator.
  for (let i = 0; i < out.length - 1; i++) if (!out[i].endsWith('\n')) out[i] += '\n'
  return out.join('')
}

const UNIT_PREVIEW_LINES = 24

function countLines(hunk: PatchHunk): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of hunk.lines) {
    if (l.startsWith('+')) added++
    else if (l.startsWith('-')) removed++
  }
  return { added, removed }
}

function preview(lines: string[]): string {
  const shown = lines
    .slice(0, UNIT_PREVIEW_LINES)
    .map((l) => (l.length > 200 ? l.slice(0, 200) + '…' : l))
  const more = lines.length - shown.length
  return shown.join('\n') + (more > 0 ? `\n… ${more} more line${more > 1 ? 's' : ''}` : '')
}

export interface UntrackedFile {
  path: string
  /** Content for a text file; null for binary or unreadable. */
  content: string | null
}

export interface ChangeSet {
  units: AiChangeUnit[]
  /** Hunk units -> their file and hunk (for applying). */
  hunkOf: Map<string, { path: string; hunk: PatchHunk }>
  /** Per path, the ids of its hunk units, in file order. */
  hunksByPath: Map<string, string[]>
  level: 'hunk' | 'file'
}

/**
 * The change units of a working copy: `diff` is `git diff <HEAD> --no-renames` (index and
 * working tree against HEAD), `untracked` the untracked files. Text files with only content
 * changes are split into hunks unless `fileLevel` (or there are more than `maxHunks` in all).
 */
export function changeUnits(
  diff: string,
  untracked: UntrackedFile[],
  opts: { fileLevel?: boolean; maxHunks?: number; splittable?: (path: string) => boolean } = {}
): ChangeSet {
  const patches = splitFilePatches(diff)
  const maxHunks = opts.maxHunks ?? 150
  const canSplit = (p: FilePatch): boolean =>
    p.status === 'M' &&
    p.hunks.length > 0 &&
    p.hunks.every(hunkIsComplete) &&
    (opts.splittable?.(p.path) ?? true)
  const totalHunks = patches.filter(canSplit).reduce((n, p) => n + p.hunks.length, 0)
  const level: 'hunk' | 'file' = opts.fileLevel || totalHunks > maxHunks ? 'file' : 'hunk'
  const units: AiChangeUnit[] = []
  const hunkOf = new Map<string, { path: string; hunk: PatchHunk }>()
  const hunksByPath = new Map<string, string[]>()
  let f = 0
  let h = 0
  for (const p of patches) {
    if (level === 'hunk' && canSplit(p) && p.hunks.length > 1) {
      const ids: string[] = []
      for (const hunk of p.hunks) {
        const id = `h${++h}`
        ids.push(id)
        hunkOf.set(id, { path: p.path, hunk })
        units.push({
          id,
          kind: 'hunk',
          path: p.path,
          status: 'M',
          header: hunk.header,
          ...countLines(hunk),
          preview: preview(hunk.lines)
        })
      }
      hunksByPath.set(p.path, ids)
      continue
    }
    const counts = p.hunks.reduce(
      (acc, hk) => {
        const c = countLines(hk)
        return { added: acc.added + c.added, removed: acc.removed + c.removed }
      },
      { added: 0, removed: 0 }
    )
    const header =
      {
        M: 'Modified',
        A: 'New file',
        D: 'Deleted file',
        B: 'Binary file',
        T: 'Mode or type change'
      }[p.status] + (p.hunks.length > 1 ? ` (${p.hunks.length} hunks)` : '')
    units.push({
      id: `f${++f}`,
      kind: 'file',
      path: p.path,
      status: p.status,
      header,
      ...counts,
      preview: preview(p.hunks.flatMap((hk) => [hk.header, ...hk.lines]))
    })
  }
  for (const u of untracked) {
    const lines =
      u.content === null ? [] : splitKeep(u.content).map((l) => '+' + l.replace(/\n$/, ''))
    units.push({
      id: `f${++f}`,
      kind: 'file',
      path: u.path,
      status: u.content === null ? 'B' : 'A',
      header: u.content === null ? 'New binary file (untracked)' : 'New file (untracked)',
      added: lines.length,
      removed: 0,
      preview: preview(lines)
    })
  }
  return { units, hunkOf, hunksByPath, level }
}

/** Paths touched by a list of unit ids, in first-seen order. */
export function filesOf(unitIds: string[], units: AiChangeUnit[]): string[] {
  const byId = new Map(units.map((u) => [u.id, u]))
  const seen = new Set<string>()
  for (const id of unitIds) {
    const u = byId.get(id)
    if (u) seen.add(u.path)
  }
  return [...seen]
}

/**
 * Throws unless every unit is used exactly once, every commit has units and a message, and
 * no unknown id appears. Returns the commits with empty ones dropped.
 */
export function validatePlan(
  commits: { message: string; units: string[] }[],
  units: AiChangeUnit[]
): { message: string; units: string[] }[] {
  if (!Array.isArray(commits) || !commits.length) throw new Error('The plan has no commits.')
  const known = new Set(units.map((u) => u.id))
  const used = new Set<string>()
  const result: { message: string; units: string[] }[] = []
  for (const [i, c] of commits.entries()) {
    if (!c || typeof c.message !== 'string' || !Array.isArray(c.units))
      throw new Error(`Commit ${i + 1} of the plan is invalid.`)
    if (!c.units.length) continue
    if (!c.message.trim()) throw new Error(`Commit ${i + 1} has no message.`)
    for (const id of c.units) {
      if (typeof id !== 'string' || !known.has(id))
        throw new Error(`Commit ${i + 1} uses an unknown change (${String(id)}).`)
      if (used.has(id)) throw new Error(`A change is used twice (${id}).`)
      used.add(id)
    }
    result.push({ message: c.message, units: c.units })
  }
  const missing = units.filter((u) => !used.has(u.id))
  if (missing.length)
    throw new Error(
      `The plan leaves out ${missing.length} change${missing.length > 1 ? 's' : ''} (${missing
        .slice(0, 3)
        .map((u) => u.path)
        .join(', ')}${missing.length > 3 ? '…' : ''}).`
    )
  if (!result.length) throw new Error('The plan has no commits.')
  return result
}

/**
 * Turns what a model proposed into a valid plan: unknown ids are dropped, a unit used twice
 * stays in its first commit, units left out go to the commit holding most of the same file's
 * units (or a final "remaining changes" commit), and empty commits disappear.
 */
export function repairPlan(
  proposed: { message: string; units: string[] }[],
  units: AiChangeUnit[]
): AiPlannedCommit[] {
  const byId = new Map(units.map((u) => [u.id, u]))
  const used = new Set<string>()
  const commits = proposed
    .map((c) => ({
      message: (c.message ?? '').trim(),
      units: (Array.isArray(c.units) ? c.units : []).filter((id) => {
        if (typeof id !== 'string' || !byId.has(id) || used.has(id)) return false
        used.add(id)
        return true
      })
    }))
    .filter((c) => c.units.length)
  const leftovers: string[] = []
  for (const u of units) {
    if (used.has(u.id)) continue
    let best = -1
    let bestCount = 0
    commits.forEach((c, i) => {
      const n = c.units.filter((id) => byId.get(id)?.path === u.path).length
      if (n > bestCount) {
        best = i
        bestCount = n
      }
    })
    if (best >= 0) commits[best].units.push(u.id)
    else leftovers.push(u.id)
  }
  if (leftovers.length) commits.push({ message: 'Update remaining files', units: leftovers })
  return commits.map((c, i) => ({
    message: c.message || `Commit ${i + 1}`,
    units: c.units,
    files: filesOf(c.units, units)
  }))
}
