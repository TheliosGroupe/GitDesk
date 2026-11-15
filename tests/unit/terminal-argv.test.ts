import { describe, expect, it } from 'vitest'
import {
  buildAgentArgv,
  cmdCommandLine,
  isCmdSafeArg,
  parseCmdShim,
  parseWorktreePorcelain,
  quoteWindowsArg,
  tokenizeCommand,
  uniqueName,
  windowsCommandLine
} from '../../src/main/terminal/argv'
import { branchSlug, taskSlug } from '../../src/shared/features/terminal'

/** CommandLineToArgvW / MSVC rules, to check that quoting round-trips. */
function parseWindowsArgs(line: string): string[] {
  const args: string[] = []
  let i = 0
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++
    if (i >= line.length) break
    let arg = ''
    let quoted = false
    while (i < line.length && (quoted || (line[i] !== ' ' && line[i] !== '\t'))) {
      let slashes = 0
      while (line[i] === '\\') {
        slashes++
        i++
      }
      if (line[i] === '"') {
        arg += '\\'.repeat(Math.floor(slashes / 2))
        if (slashes % 2) arg += '"'
        else if (quoted && line[i + 1] === '"') {
          arg += '"'
          i++
        } else quoted = !quoted
        i++
      } else {
        arg += '\\'.repeat(slashes)
        if (i < line.length) arg += line[i++]
      }
    }
    args.push(arg)
  }
  return args
}

const NASTY = [
  'fix "the" bug & run tests | tee log',
  'percent %PATH% and ^caret^ and !bang!',
  'multi\nline\r\ntask',
  'trailing backslash \\',
  'C:\\path with spaces\\',
  '"a b"',
  '"',
  '',
  '\\\\"\\',
  '--dangerously-skip-permissions',
  "it's $(rm -rf ~) `whoami` ; echo pwned"
]

describe('quoteWindowsArg', () => {
  it('round-trips through CommandLineToArgvW rules', () => {
    for (const arg of NASTY) expect(parseWindowsArgs(quoteWindowsArg(arg))).toEqual([arg])
    expect(parseWindowsArgs(windowsCommandLine(NASTY))).toEqual(NASTY)
  })
  it('leaves plain arguments alone', () => {
    expect(quoteWindowsArg('--continue')).toBe('--continue')
    expect(quoteWindowsArg('C:\\x\\y.js')).toBe('C:\\x\\y.js')
    expect(quoteWindowsArg('')).toBe('""')
  })
})

describe('tokenizeCommand', () => {
  it('splits words and honours quotes without expanding anything', () => {
    expect(tokenizeCommand('claude --model opus', true)).toEqual(['claude', '--model', 'opus'])
    expect(tokenizeCommand('"C:\\Program Files\\x\\x.exe" -i $HOME', true)).toEqual([
      'C:\\Program Files\\x\\x.exe',
      '-i',
      '$HOME'
    ])
    expect(tokenizeCommand(`node '/a b/c.js' "x y"`, false)).toEqual(['node', '/a b/c.js', 'x y'])
    expect(tokenizeCommand('a\\ b c', false)).toEqual(['a b', 'c'])
    expect(tokenizeCommand('a\\b', true)).toEqual(['a\\b'])
    expect(tokenizeCommand('  ', true)).toEqual([])
    expect(tokenizeCommand('x ""', true)).toEqual(['x', ''])
  })
  it('rejects an unclosed quote', () => {
    expect(() => tokenizeCommand('claude "oops', true)).toThrow(/Unclosed/)
  })
})

describe('buildAgentArgv', () => {
  const task = 'Fix "login" & | % ^ !\nnext line'
  it('passes the task as one argument', () => {
    expect(buildAgentArgv('claude', 'claude', task, true)).toEqual(['claude', '--', task])
    expect(buildAgentArgv('codex', 'codex --full-auto', task, false)).toEqual([
      'codex',
      '--full-auto',
      '--',
      task
    ])
    expect(buildAgentArgv('gemini', 'gemini', task, true)).toEqual([
      'gemini',
      '--prompt-interactive',
      task
    ])
    expect(buildAgentArgv('opencode', 'opencode', task, false)).toEqual([
      'opencode',
      '--prompt',
      task
    ])
  })
  it('never lets a task starting with "-" read as an option', () => {
    const dash = '--dangerously-skip-permissions please'
    expect(buildAgentArgv('claude', 'claude', dash, false)).toEqual(['claude', '--', dash])
    expect(buildAgentArgv('codex', 'codex', '-h', true)).toEqual(['codex', '--', '-h'])
    expect(buildAgentArgv('gemini', 'gemini', dash, false)).toEqual([
      'gemini',
      `--prompt-interactive=${dash}`
    ])
    expect(buildAgentArgv('copilot', 'copilot', '-x', false)).toEqual([
      'copilot',
      '--interactive=-x'
    ])
    expect(buildAgentArgv('opencode', 'opencode', '-x', false)).toEqual(['opencode', '--prompt=-x'])
  })
  it('puts the task at a {task} placeholder', () => {
    expect(buildAgentArgv('custom', 'my-agent run {task} --yes', task, false)).toEqual([
      'my-agent',
      'run',
      task,
      '--yes'
    ])
  })
  it('resumes with the agent continue arguments, without the task', () => {
    expect(buildAgentArgv('claude', 'claude --model opus', null, true)).toEqual([
      'claude',
      '--model',
      'opus',
      '--continue'
    ])
    expect(buildAgentArgv('codex', 'codex', null, true)).toEqual(['codex', 'resume', '--last'])
    expect(buildAgentArgv('custom', 'x {task}', null, true)).toEqual(['x'])
  })
  it('needs a command', () => {
    expect(() => buildAgentArgv('custom', '', 'task', true)).toThrow()
  })
})

describe('parseCmdShim', () => {
  const header =
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n'
  it('reads native-program shims', () => {
    expect(
      parseCmdShim(
        header + '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
      )
    ).toEqual({ kind: 'exe', target: 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe' })
  })
  it('reads node-script shims', () => {
    const body =
      'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
    expect(parseCmdShim(header + body)).toEqual({
      kind: 'node',
      script: 'node_modules\\@openai\\codex\\bin\\codex.js'
    })
  })
  it('refuses anything else', () => {
    expect(parseCmdShim('@echo off\r\npython "%~dp0\\x.py" %*\r\n')).toBeNull()
    expect(parseCmdShim(header + '"%dp0%\\..\\evil.exe" %*')).toBeNull()
    expect(parseCmdShim(header + '"%dp0%\\x.sh" %*')).toBeNull()
    expect(parseCmdShim('')).toBeNull()
  })
})

describe('cmd.exe fallback', () => {
  it('only lets inert arguments through', () => {
    expect(isCmdSafeArg('--model opus-4')).toBe(true)
    expect(isCmdSafeArg('C:\\Users\\me\\x.bat')).toBe(true)
    for (const bad of ['a&b', 'a|b', '50%', 'a^b', 'a"b', 'a!b', 'a\nb', 'a<b', 'a>b'])
      expect(isCmdSafeArg(bad)).toBe(false)
    expect(cmdCommandLine('C:\\a b\\x.cmd', ['-y'])).toBe('/d /s /c ""C:\\a b\\x.cmd" "-y""')
  })
})

describe('parseWorktreePorcelain', () => {
  it('parses every kind of entry', () => {
    const out = [
      'worktree C:/dev/app',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree C:/dev/app.worktrees/feature-x',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature/x',
      'locked moved to usb drive',
      '',
      'worktree C:/tmp/detached',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\n')
    const list = parseWorktreePorcelain(out)
    expect(list).toHaveLength(3)
    expect(list[0]).toMatchObject({ path: 'C:/dev/app', branch: 'main', locked: false })
    expect(list[1]).toMatchObject({
      branch: 'feature/x',
      locked: true,
      lockReason: 'moved to usb drive'
    })
    expect(list[2]).toMatchObject({ branch: null, detached: true, prunable: true })
  })
  it('handles bare repositories, CRLF and paths with spaces', () => {
    const list = parseWorktreePorcelain('worktree /srv/x y.git\r\nbare\r\n\r\n')
    expect(list).toEqual([expect.objectContaining({ path: '/srv/x y.git', bare: true })])
    expect(parseWorktreePorcelain('')).toEqual([])
  })
})

describe('slugs', () => {
  it('makes branch-name slugs of tasks', () => {
    expect(taskSlug('Fix the login bug!')).toBe('fix-the-login-bug')
    expect(taskSlug('Réparer l’écran « paramètres »')).toBe('reparer-l-ecran-parametres')
    expect(taskSlug('   ')).toBe('task')
    expect(taskSlug('a b c d e f g h')).toBe('a-b-c-d-e-f')
    expect(taskSlug('x'.repeat(80))).toHaveLength(40)
    expect(taskSlug('add "quotes" & pipes | and %vars%')).toBe('add-quotes-pipes-and-vars')
  })
  it('makes folder slugs of branches', () => {
    expect(branchSlug('feature/login')).toBe('feature-login')
    expect(branchSlug('agent/fix-bug')).toBe('agent-fix-bug')
    expect(branchSlug('..')).toBe('worktree')
    expect(branchSlug('a//b..c')).toBe('a-b..c')
  })
  it('finds a free name', () => {
    const taken = new Set(['x', 'x-2'])
    expect(uniqueName('x', (n) => taken.has(n))).toBe('x-3')
    expect(uniqueName('y', (n) => taken.has(n))).toBe('y')
  })
})
