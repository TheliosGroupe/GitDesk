import { describe, expect, it } from 'vitest'
import {
  budgetDiff,
  budgetNote,
  commitMessagePrompt,
  composePrompt,
  oldPathOf,
  withheldPaths
} from '../../src/main/ai/prompts'
import {
  hasSecretContent,
  isSecretPath,
  SECRET_REASON,
  secretReason
} from '../../src/main/ai/secrets'
import type { AiChangeUnit } from '../../src/shared/features/ai'
import { splitFilePatches } from '../../src/shared/features/ai-patch'

// Fixtures are built from pieces so that no complete token-shaped string sits in the source.
const FAKE_PEM = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ') + '\nAAAA\n-----END RSA KEY-----'
const FAKE_GH = 'gh' + 'p_' + 'A1b2C3'.repeat(6)
const FAKE_AWS = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'

function patch(path: string, added: string[]): string {
  return (
    `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n` +
    `@@ -0,0 +1,${added.length} @@\n` +
    added.map((l) => '+' + l).join('\n') +
    '\n'
  )
}

describe('secret detection', () => {
  it('recognizes secret file names, not their examples or public keys', () => {
    for (const p of [
      '.env',
      'app/.env.local',
      'certs/server.pem',
      'tls.key',
      'keystore.p12',
      'home/.ssh/id_ed25519',
      'id_rsa',
      '.npmrc',
      '.git-credentials',
      'config/credentials.json',
      'gcp/service-account-prod.json',
      '.aws/credentials',
      'config/secrets.yml',
      'deploy/prod.env',
      '.envrc',
      'infra/prod.tfvars',
      'infra/prod.auto.tfvars.json',
      'infra/terraform.tfstate',
      'infra/terraform.tfstate.backup',
      'home/.docker/config.json',
      'home/.kube/config',
      'kubeconfig',
      'AuthKey_ABC.p8'
    ])
      expect(isSecretPath(p), p).toBe(true)
    for (const p of [
      '.env.example',
      'app/.env.sample',
      'id_rsa.pub',
      'src/env.ts',
      'README.md',
      'keys.ts',
      'credentials.md',
      'prod.env.example',
      'src/environment.ts',
      'config.json',
      'docker/config.json',
      'variables.tf'
    ])
      expect(isSecretPath(p), p).toBe(false)
  })

  it('recognizes private keys and well-known token shapes in content', () => {
    expect(hasSecretContent(`x\n${FAKE_PEM}\n`)).toBe(true)
    expect(hasSecretContent(`token = "${FAKE_GH}"`)).toBe(true)
    expect(hasSecretContent(`key=${FAKE_AWS}`)).toBe(true)
    expect(hasSecretContent('placeholder: sk-ant-…, AKIA…, ghp_xxx')).toBe(false)
    expect(hasSecretContent('const BEGIN = 1 // PRIVATE KEY handling')).toBe(false)
    expect(secretReason('a.txt', `x ${FAKE_GH}`)).toBe(SECRET_REASON)
    expect(secretReason('a.txt', 'nothing here')).toBeNull()
  })

  it('scans large inputs in linear time', () => {
    const big =
      ('-----BEGIN ' + 'A '.repeat(50) + '\n').repeat(20_000) + 'ghp_short '.repeat(50_000)
    const start = performance.now()
    expect(hasSecretContent(big)).toBe(false)
    expect(performance.now() - start).toBeLessThan(500)
  })
})

describe('secrets never reach a prompt', () => {
  const diff =
    patch('src/app.ts', ['export const a = 1']) +
    patch('.env', ['DB_PASSWORD=hunter2']) +
    patch('notes.txt', [`token: ${FAKE_GH}`]) +
    patch('deploy/id_rsa', ['abc'])

  it('budgetDiff lists the path only, and reports it as withheld', () => {
    const b = budgetDiff(diff, { maxChars: 60_000, perFile: 12_000 })
    expect(b.text).toContain('export const a = 1')
    expect(b.text).not.toContain('hunter2')
    expect(b.text).not.toContain(FAKE_GH)
    expect(b.text).not.toContain('+abc')
    expect(withheldPaths(b)).toEqual(['.env', 'notes.txt', 'deploy/id_rsa'])
    expect(budgetNote(b)).toContain(`.env (${SECRET_REASON})`)
    const prompt = commitMessagePrompt({
      diff: b,
      recentSubjects: [],
      branch: 'main',
      source: 'staged',
      untracked: []
    })
    expect(prompt.user).not.toContain('hunter2')
    expect(prompt.user).not.toContain(FAKE_GH)
  })

  it('budgetDiff withholds a renamed secret file under its new name', () => {
    const renamed =
      'diff --git a/.env b/config/settings.txt\nsimilarity index 90%\n' +
      'rename from .env\nrename to config/settings.txt\n' +
      '--- a/.env\n+++ b/config/settings.txt\n@@ -1,1 +1,2 @@\n DB_PASSWORD=hunter2\n+X=1\n'
    const b = budgetDiff(renamed, { maxChars: 60_000, perFile: 12_000 })
    expect(b.text).not.toContain('hunter2')
    expect(withheldPaths(b)).toEqual(['config/settings.txt'])
    expect(oldPathOf(splitFilePatches(renamed)[0])).toBe('.env')
    expect(oldPathOf(splitFilePatches(patch('a.ts', ['x']))[0])).toBeNull()
  })

  const unit = (id: string, path: string, header: string): AiChangeUnit => ({
    id,
    kind: 'hunk',
    path,
    status: 'M',
    header,
    added: 1,
    removed: 1,
    preview: ''
  })

  it('composePrompt withholds every hunk of a file when one of them holds a token', () => {
    const units = [
      unit('h1', 'src/app.js', '@@ -1,1 +1,1 @@ function first()'),
      unit('h2', 'src/app.js', '@@ -9,1 +9,1 @@ function second()'),
      unit('h3', 'src/b.js', '@@ -1,1 +1,1 @@')
    ]
    const bodies = new Map([
      ['h1', '@@ -1,1 +1,1 @@\n-const plain = 1\n+const plain = 2'],
      ['h2', `@@ -9,1 +9,1 @@\n-const t = ''\n+const t = '${FAKE_GH}'`],
      ['h3', '@@ -1,1 +1,1 @@\n-b\n+kept']
    ])
    const { prompt, withheld } = composePrompt({ units, bodies, recentSubjects: [] })
    expect(withheld).toEqual(['src/app.js'])
    expect(prompt.user).not.toContain(FAKE_GH)
    expect(prompt.user).not.toContain('const plain')
    expect(prompt.user).not.toContain('function first')
    expect(prompt.user).not.toContain('function second')
    expect(prompt.user).toContain('id="h1"')
    expect(prompt.user).toContain('id="h2"')
    expect(prompt.user).toContain('+kept')
  })

  it('composePrompt keeps the unit but not its content', () => {
    // The hunk header's function context is a line of the file: dropped for a secret.
    const units = [
      unit('h1', '.env', '@@ -1,1 +1,1 @@ DB_PASSWORD=hunter2'),
      unit('h2', 'src/a.ts', '@@ -1,1 +1,1 @@ function a()')
    ]
    const bodies = new Map([
      ['h1', '@@ -1,1 +1,1 @@\n-DB_PASSWORD=old\n+DB_PASSWORD=hunter2'],
      ['h2', '@@ -1,1 +1,1 @@\n-a\n+b']
    ])
    const { prompt, withheld } = composePrompt({ units, bodies, recentSubjects: [] })
    expect(withheld).toEqual(['.env'])
    expect(prompt.user).toContain('id="h1"')
    expect(prompt.user).toContain(SECRET_REASON)
    expect(prompt.user).not.toContain('hunter2')
    expect(prompt.user).toContain('+b')
  })
})
