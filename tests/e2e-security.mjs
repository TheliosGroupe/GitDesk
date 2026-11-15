// End-to-end test of repository trust and of the window's own hardening. Every fixture is
// harmless: the settings and hooks that would run a program only append a line to a
// marker file in this test's own temp folder, and the only "network" is 127.0.0.1 or a
// .invalid name that never resolves. Until a repository is trusted, no marker may appear.
//
//   npm run test:e2e      (runs the other suites, then this file; screenshots in test-results/)

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitIn, launch, results, root, step, until } from './e2e-helpers.mjs'

const windows = process.platform === 'win32'
const work = mkdtempSync(join(tmpdir(), 'gitdesk-e2e-security-'))

// Your own git configuration (credential managers, proxies, askpass programs) stays out
// of this test, for the fixtures and for the app (which inherits this environment).
writeFileSync(join(work, 'gitconfig'), '')
process.env.GIT_CONFIG_GLOBAL = join(work, 'gitconfig')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_TERMINAL_PROMPT = '0'
for (const name of [
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND'
])
  delete process.env[name]

const slash = (p) => p.split(String.fromCharCode(92)).join('/')
/** A marker file of this test; the command below only appends a line to it. */
const marker = (name) => join(work, `marker-${name}`)
const writesMarker = (name) => `echo ran >> '${slash(marker(name))}'`
const ran = (name) => existsSync(marker(name))

/** A repository with one commit on main and a second branch "other", made outside the app. */
function newRepo(name, parent = work) {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true })
  const g = gitIn(dir)
  g('init', '-q', '-b', 'main')
  g('config', 'user.name', 'Test User')
  g('config', 'user.email', 'test@example.com')
  g('config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  g('add', '-A')
  g('commit', '-qm', 'First commit')
  g('branch', 'other')
  return { dir, g }
}

// (1) Hooks, fsmonitor and a textconv program, all set after the last git command here.
const risky = newRepo('risky')
writeFileSync(join(risky.dir, '.gitattributes'), '*.txt diff=x\n')
risky.g('add', '.gitattributes')
risky.g('commit', '-qm', 'Attributes')
risky.g('config', 'diff.x.textconv', `${writesMarker('textconv')}; cat`)
risky.g('config', 'core.fsmonitor', writesMarker('fsmonitor'))
writeFileSync(
  join(risky.dir, '.git', 'hooks', 'post-checkout'),
  `#!/bin/sh\n${writesMarker('post-checkout')}\n`,
  { mode: 0o755 }
)
writeFileSync(join(risky.dir, 'a.txt'), 'one\ntwo changed\n')

// (2) Its own git server program on a local remote.
const uploadpack = newRepo('uploadpack')
const bare = join(work, 'bare.git')
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
uploadpack.g('remote', 'add', 'origin', bare)
uploadpack.g('push', '-q', 'origin', 'main')
uploadpack.g('config', 'remote.origin.uploadpack', writesMarker('uploadpack'))

// (3) Its own credential helper, asked by a server on this computer that always says 401.
// The same server also plays a GitLab whose answers have wrong-typed fields (NEW-06).
const now = new Date().toISOString()
const goodMr = {
  iid: 7,
  project_id: 1,
  title: 'A well-formed merge request',
  draft: false,
  web_url: 'https://gitlab.fake.test/team/app/-/merge_requests/7',
  updated_at: now,
  author: { username: 'ann', name: 'Ann', avatar_url: null },
  source_branch: 'feature-7',
  target_branch: 'main',
  source_project_id: 1,
  target_project_id: 1,
  references: { full: 'team/app!7' }
}
const badMrs = [
  { ...goodMr, iid: 'eight', title: { text: 'object title' } },
  { ...goodMr, iid: 9, title: 42, web_url: ['not', 'a', 'url'], author: 'ann' },
  { ...goodMr, iid: 10, web_url: 'javascript:alert(1)', references: null },
  null,
  'just a string'
]
const goodProject = {
  id: 1,
  path_with_namespace: 'team/app',
  description: null,
  visibility: 'private',
  last_activity_at: now,
  http_url_to_repo: 'https://gitlab.fake.test/team/app.git',
  web_url: 'https://gitlab.fake.test/team/app',
  default_branch: 'main'
}
const fakeGitLab = {
  '/gl/api/v4/user': { username: 'fakeuser', name: 'Fake User', avatar_url: null },
  '/gl/api/v4/projects': [
    goodProject,
    { ...goodProject, id: 'x', path_with_namespace: ['a'], web_url: 12 },
    { id: 3, path_with_namespace: '../../etc', http_url_to_repo: {}, web_url: null },
    7
  ],
  '/gl/api/v4/groups': { not: 'a list' },
  '/gl/api/v4/merge_requests': [goodMr, ...badMrs],
  '/gl/api/v4/issues': [
    { iid: 'three', title: null, web_url: 5, assignee: [], author: 1, references: 'x' },
    {
      iid: 3,
      project_id: 1,
      title: 'A well-formed issue',
      state: 'opened',
      web_url: 'https://gitlab.fake.test/team/app/-/issues/3',
      updated_at: now,
      assignee: { username: 'fakeuser', avatar_url: { url: 'x' } },
      author: { username: 'ann', avatar_url: 99 },
      references: { full: 'team/app#3' }
    }
  ]
}
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  if (path.startsWith('/gl/') && req.headers.authorization === 'Bearer glpat-test') {
    const answer = fakeGitLab[path]
    res.writeHead(answer ? 200 : 404, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(answer ?? { message: '404 Not found' }))
  }
  res.writeHead(401, { 'www-authenticate': 'Basic realm="gitdesk-test"' })
  res.end('no')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const helper = newRepo('helper')
helper.g('remote', 'add', 'origin', `http://127.0.0.1:${server.address().port}/repo.git`)
helper.g('config', 'credential.helper', `!${writesMarker('credential')}`)

// (4) core.worktree pointing to a sibling folder that holds a file.
const sibling = join(work, 'sibling')
mkdirSync(sibling)
writeFileSync(join(sibling, 'outside.txt'), 'keep me\n')
const pinned = newRepo('worktree-pin')
pinned.g('config', 'core.worktree', slash(sibling))

// (8) A nested repository known only from a gitlink, with its own fsmonitor program.
const gitlink = newRepo('gitlink')
const sub = newRepo('sub', gitlink.dir)
const subSha = sub.g('rev-parse', 'HEAD')
gitlink.g('update-index', '--add', '--cacheinfo', `160000,${subSha},sub`)
gitlink.g('commit', '-qm', 'Add a gitlink')
sub.g('config', 'core.fsmonitor', writesMarker('gitlink'))

// (9) An ordinary submodule, as `git submodule add` writes it: nothing to warn about.
const library = newRepo('library')
const withSubmodule = newRepo('submodule-ok')
withSubmodule.g('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library.dir, 'mod')
withSubmodule.g('commit', '-qm', 'Add a submodule')

// (10) A settings file too large to check, hiding an fsmonitor program at its end.
const bigConfig = newRepo('big-config')
appendFileSync(
  join(bigConfig.dir, '.git', 'config'),
  `# ${'x'.repeat(1 << 20)}\n[core]\n\tfsmonitor = ${writesMarker('big-config')}\n`
)

// (11) A folder whose .git is an empty folder, inside a repository with an fsmonitor.
const outer = newRepo('outer')
const inner = join(outer.dir, 'inner')
mkdirSync(join(inner, '.git'), { recursive: true })
writeFileSync(join(inner, 'notes.txt'), 'inner\n')
outer.g('config', 'core.fsmonitor', writesMarker('outer'))

// (12) A proxy of its own: local commands work, the network waits.
const proxy = newRepo('proxy')
proxy.g('remote', 'add', 'origin', bare)
proxy.g('config', 'http.proxy', 'http://proxy.invalid')

// (5) Windows: a program named git.exe / git.com in the repository is never run as git.
// (6) Windows: a borrowed history on another computer (.invalid never resolves).
const extra = []
if (windows) {
  const fakeGit = newRepo('fake-git')
  const where = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'where.exe')
  // Last: git must not run in that folder from this script any more (Windows looks there).
  copyFileSync(where, join(fakeGit.dir, 'git.exe'))
  copyFileSync(where, join(fakeGit.dir, 'git.com'))
  const alternates = newRepo('alternates')
  const bs = String.fromCharCode(92)
  writeFileSync(
    join(alternates.dir, '.git', 'objects', 'info', 'alternates'),
    `${bs}${bs}gitdesk-test.invalid${bs}share${bs}objects\n`
  )
  extra.push(fakeGit.dir, alternates.dir)
}

const userData = join(work, 'userdata')
mkdirSync(userData)
const repos = [
  risky.dir,
  uploadpack.dir,
  helper.dir,
  pinned.dir,
  gitlink.dir,
  withSubmodule.dir,
  bigConfig.dir,
  inner,
  proxy.dir,
  ...extra
]
writeFileSync(
  join(userData, 'gitdesk.json'),
  JSON.stringify({ repos, openTabs: [], activeTab: null })
)
const markers = ['textconv', 'fsmonitor', 'post-checkout', 'uploadpack', 'credential', 'gitlink']
markers.push('big-config', 'outer')
for (const m of markers) assert.equal(ran(m), false, `${m} ran while setting up`)

const { app, page, pageErrors, shot, section, toast, confirmModal, goHome } = await launch(userData)
let closed = false

// Several repository tabs share the DOM (hidden ones stay mounted): only use the shown one.
const shown = (locator) => locator.filter({ visible: true })
const card = (name) =>
  page
    .locator('.card')
    .filter({ has: page.locator('.card-name', { hasText: new RegExp(`^${name}$`) }) })
const banner = () => shown(page.locator('.trust-banner'))
const toolbarButton = (label) => shown(page.locator('.toolbar .tool', { hasText: label }))
const sbItem = (name) => shown(page.locator(`.sidebar .sb-item[title="${name}"]`))
const openRepo = async (name) => {
  await goHome('Projects')
  await card(name).click()
  await shown(page.locator('.repo-view')).first().waitFor()
}
const closeTab = async () => {
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+w')
  await page.locator('.home').waitFor()
}
/** Waits a moment, then checks that a marker never appeared. */
const unstaged = () => shown(section('Unstaged files'))
const stillNot = async (name, what) => {
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(ran(name), false, what)
}

try {
  // --- the window itself ---------------------------------------------------------------
  assert.match(page.url(), /^app:\/\/gitdesk\//)
  const target = `file:///${slash(join(work, 'elsewhere.html'))}`
  writeFileSync(join(work, 'elsewhere.html'), '<p>not GitDesk</p>')
  await page.evaluate((url) => {
    location.href = url
  }, target)
  await new Promise((r) => setTimeout(r, 1000))
  assert.match(page.url(), /^app:\/\/gitdesk\//, 'the window stays on GitDesk')
  await page.locator('.home').waitFor()
  // Chromium logs its own refusal of the page asked for: expected, not an app error.
  for (let i = pageErrors.length - 1; i >= 0; i--)
    if (
      pageErrors[i].includes('Not allowed to load local resource') &&
      pageErrors[i].includes('elsewhere.html')
    )
      pageErrors.splice(i, 1)
  step('the window is served from app://gitdesk and cannot be sent to a file:// page')

  const electronPath = createRequire(import.meta.url)('electron')
  const env = { ...process.env, GITDESK_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const second = spawn(electronPath, [root], { env, stdio: 'ignore' })
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20_000)
    second.on('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  if (!exited) second.kill()
  assert.equal(exited, true, 'a second GitDesk on the same profile quits by itself')
  assert.equal(await page.evaluate(() => 1 + 1), 2, 'the first window is still there')
  step('a second launch on the same profile quits and leaves the first window open')

  // --- (1) settings that would run programs ---------------------------------------------
  await goHome('Projects')
  await until(
    async () =>
      (await card('risky').locator('.trust-badge').innerText()).includes('settings ignored'),
    'risky card badge'
  )
  await openRepo('risky')
  const riskyText = await banner().innerText()
  for (const key of ['core.fsmonitor', 'hooks', 'diff.x.textconv'])
    assert.ok(riskyText.includes(key), `the banner lists ${key}: ${riskyText}`)
  await shot('s01-trust-banner')
  // A diff of the changed file (it has a textconv driver), its blame, and a branch switch.
  await unstaged().locator('li', { hasText: 'a.txt' }).click()
  await shown(page.locator('.diff-view')).first().waitFor()
  await page.keyboard.press('Escape') // back to the graph
  await shown(page.locator('.graph-row', { hasText: 'First commit' }))
    .first()
    .click()
  await shown(page.locator('.side-panel li', { hasText: 'a.txt' })).click({ button: 'right' })
  await page.locator('.context-menu [role=menuitem]', { hasText: 'File history' }).first().click()
  await page.getByRole('tab', { name: 'Blame' }).click()
  await page.locator('.bl-row').first().waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.file-history').waitFor({ state: 'detached' })
  // The edited a.txt is the same on both branches: it comes along.
  await sbItem('other').dblclick()
  await toast('Switched to other').waitFor()
  // Read without git: git here would run the repository's own fsmonitor.
  assert.match(readFileSync(join(risky.dir, '.git', 'HEAD'), 'utf8'), /refs\/heads\/other/)
  for (const m of ['fsmonitor', 'textconv', 'post-checkout'])
    await stillNot(m, `${m} ran in an untrusted repository`)
  step('untrusted: hooks, fsmonitor and textconv never run (diff, blame, switch branch)')

  await banner().getByRole('button', { name: 'Trust this repository…' }).click()
  await confirmModal('Trust')
  await banner().waitFor({ state: 'detached' })
  // The next refresh runs the repository's own fsmonitor program.
  writeFileSync(join(risky.dir, 'b.txt'), 'new\n')
  await until(() => ran('fsmonitor'), 'the fsmonitor program runs once trusted', 20_000)
  await closeTab()
  await until(async () => (await card('risky').locator('.trust-badge').count()) === 0, 'no badge')
  step('Trust this repository… removes the banner and the badge; its settings then apply')

  // --- (2) its own git server program --------------------------------------------------
  await openRepo('uploadpack')
  await toolbarButton('Fetch').click()
  await toast('paused').waitFor()
  await stillNot('uploadpack', 'remote.origin.uploadpack ran')
  await closeTab()
  step('a repository with its own upload-pack program: Fetch is paused, nothing runs')

  // --- (3) its own credential helper --------------------------------------------------
  await openRepo('helper')
  assert.ok((await banner().innerText()).includes('credential.helper'))
  await toolbarButton('Fetch').click()
  await page.locator('.toast.error').first().waitFor({ timeout: 30_000 })
  await stillNot('credential', 'the repository credential helper ran')
  await closeTab()
  step('a repository credential helper is never asked for a password')

  // --- (4) core.worktree pointing elsewhere --------------------------------------------
  await openRepo('worktree-pin')
  writeFileSync(join(pinned.dir, 'a.txt'), 'edited here\n')
  await unstaged().locator('li', { hasText: 'a.txt' }).waitFor()
  assert.equal(await unstaged().locator('li', { hasText: 'outside.txt' }).count(), 0)
  await unstaged().getByRole('button', { name: 'Discard all' }).click()
  await confirmModal('Discard')
  await until(() => readFileSync(join(pinned.dir, 'a.txt'), 'utf8') === 'one\ntwo\n', 'discarded')
  assert.equal(readFileSync(join(sibling, 'outside.txt'), 'utf8'), 'keep me\n')
  await closeTab()
  step(
    'core.worktree elsewhere: the registered folder is the working copy; Discard all keeps the other'
  )

  // --- (8) a nested repository known only from a gitlink -------------------------------
  await openRepo('gitlink')
  assert.ok((await banner().innerText()).includes('sub: core.fsmonitor'))
  writeFileSync(join(gitlink.dir, 'refresh.txt'), 'x\n')
  await unstaged().locator('li', { hasText: 'refresh.txt' }).waitFor()
  await stillNot('gitlink', 'the nested repository fsmonitor ran')
  await closeTab()
  step('a nested repository without .gitmodules is inspected too; git stays out of it')

  // --- (9) an ordinary submodule -------------------------------------------------------
  await goHome('Projects')
  await card('submodule-ok').locator('.card-status, .card-last').first().waitFor()
  assert.equal(await card('submodule-ok').locator('.trust-badge').count(), 0)
  await openRepo('submodule-ok')
  await shown(page.locator('.graph-row', { hasText: 'Add a submodule' }))
    .first()
    .waitFor()
  assert.equal(await banner().count(), 0)
  await closeTab()
  step('an ordinary submodule (git submodule add) shows no warning')

  // --- (10) a settings file too large to check ----------------------------------------
  await goHome('Projects')
  await until(
    async () =>
      (await card('big-config').locator('.trust-badge').innerText()).includes('not opened'),
    'big-config is not opened'
  )
  await stillNot('big-config', 'an fsmonitor hidden after 1 MiB ran')
  step('a settings file too large to check counts as risky: git does not run there')

  // --- (11) an empty .git inside another repository -----------------------------------
  await openRepo('inner')
  assert.ok((await banner().innerText()).includes('core.fsmonitor'))
  writeFileSync(join(inner, 'notes.txt'), 'inner, edited\n')
  await new Promise((r) => setTimeout(r, 1000))
  await stillNot('outer', 'the enclosing repository fsmonitor ran')
  await closeTab()
  step('a folder with an empty .git shows the findings of the repository git really uses')

  // --- (12) a proxy of its own ---------------------------------------------------------
  await openRepo('proxy')
  assert.ok((await banner().innerText()).includes('Git LFS'))
  await sbItem('other').dblclick()
  await toast('Switched to other').waitFor()
  assert.equal(proxy.g('branch', '--show-current'), 'other')
  await toolbarButton('Fetch').click()
  await toast('paused').waitFor()
  await closeTab()
  step('its own proxy: local commands work, Fetch is paused, the banner mentions Git LFS')

  // --- (5) and (6), Windows ------------------------------------------------------------
  if (windows) {
    await openRepo('fake-git')
    await shown(page.locator('.graph-row', { hasText: 'First commit' }))
      .first()
      .waitFor()
    await unstaged().locator('li', { hasText: 'git.exe' }).waitFor()
    await closeTab()
    step('a git.exe / git.com in the repository is never run as git')

    await goHome('Projects')
    await until(
      async () =>
        (await card('alternates').locator('.trust-badge').innerText()).includes('not opened'),
      'alternates card'
    )
    await openRepo('alternates')
    await shown(page.locator('.trust-banner.blocked')).waitFor()
    await shot('s06-blocked-banner')
    await closeTab()
    step('a borrowed history on another computer: not opened, with the blocked banner')
  }

  assert.deepEqual(pageErrors, [])
  await app.close()
  closed = true
  step('no renderer errors')

  // --- (7) a damaged gitdesk.json -----------------------------------------------------
  const damagedData = join(work, 'damaged')
  mkdirSync(damagedData)
  const damaged = `{ "repos": [${JSON.stringify(proxy.dir)}], }`
  writeFileSync(join(damagedData, 'gitdesk.json'), damaged)
  const third = await launch(damagedData)
  try {
    await third.page.locator('.home').waitFor()
    await until(
      () => readdirSync(damagedData).some((f) => f.startsWith('gitdesk.json.corrupt-')),
      'the damaged file is kept aside'
    )
    const backup = readdirSync(damagedData).find((f) => f.startsWith('gitdesk.json.corrupt-'))
    assert.equal(readFileSync(join(damagedData, backup), 'utf8'), damaged)
    // The warning box has no parent window: the app keeps answering.
    await third.page.getByRole('tab', { name: 'Home', exact: true }).click()
    await third.page
      .locator('.home-nav')
      .getByRole('tab', { name: 'Activity', exact: true })
      .click()
    await third.page
      .locator('.home-nav')
      .getByRole('tab', { name: 'Projects', exact: true })
      .click()
    await until(
      () => readFileSync(join(damagedData, backup), 'utf8') === damaged,
      'the backup is never overwritten'
    )
    assert.deepEqual(third.pageErrors, [])
  } finally {
    await third.app.close()
  }
  step('a damaged gitdesk.json is kept as gitdesk.json.corrupt-*, and the app still starts')

  // --- a service answering with wrong-typed fields (NEW-06) ------------------------------
  const hostingData = join(work, 'hosting')
  mkdirSync(hostingData)
  const hostingEnv = {
    GITDESK_API_OVERRIDES: JSON.stringify({
      'gitlab.fake.test': `http://127.0.0.1:${server.address().port}/gl`
    })
  }
  const fourth = await launch(hostingData, hostingEnv)
  try {
    const p = fourth.page
    await fourth.goHome('Projects')
    await p.getByRole('button', { name: 'GitLab, Bitbucket, Azure DevOps…' }).click()
    await fourth.modal().getByRole('radio', { name: 'GitLab' }).click()
    await fourth.modal().getByLabel('Host').fill('gitlab.fake.test')
    await fourth.modal().getByLabel('Token').fill('glpat-test')
    await fourth.modal().getByRole('button', { name: 'Add account' }).click()
    await p.locator('.account-chip', { hasText: 'fakeuser' }).waitFor()
    await fourth.modal().waitFor({ state: 'detached' })
    await fourth.goHome('Launchpad')
    const launchpad = p.locator('.launchpad')
    await launchpad.getByText('A well-formed merge request').first().waitFor({ timeout: 15000 })
    await launchpad.getByText('A well-formed issue').waitFor()
    assert.equal(await launchpad.getByText('object title').count(), 0)
    await fourth.shot('s07-launchpad-bad-fields')
    await fourth.goHome('Projects')
    await p.getByRole('button', { name: /^Clone from/ }).click()
    await fourth.modal().getByText('team/app').first().waitFor({ timeout: 15000 })
    await p.keyboard.press('Escape')
    assert.ok((await p.locator('#root').innerHTML()).length > 0)
    assert.deepEqual(fourth.pageErrors, [])
  } finally {
    await fourth.app.close()
  }
  const fifth = await launch(hostingData, hostingEnv)
  try {
    await fifth.goHome('Launchpad')
    await fifth.page
      .locator('.launchpad')
      .getByText('A well-formed merge request')
      .first()
      .waitFor({ timeout: 15000 })
    assert.ok((await fifth.page.locator('#root').innerHTML()).length > 0)
    assert.deepEqual(fifth.pageErrors, [])
  } finally {
    await fifth.app.close()
  }
  step('a service answering with wrong-typed fields: good items show, the rest is skipped')

  // --- hidden and bidirectional characters (SEC-21) -------------------------------------
  // Harmless text only: a right-to-left override in a string and in a branch name, and a
  // UTF-8 byte order mark at the top of a C# file (which must not raise the warning).
  const RLO = '‮'
  const uni = newRepo('unicode')
  writeFileSync(join(uni.dir, 'trojan.js'), 'const ok = true\n')
  writeFileSync(join(uni.dir, 'bom.cs'), '﻿using System;\nclass A {}\n')
  uni.g('add', '-A')
  uni.g('commit', '-qm', 'Unicode files')
  uni.g('branch', `rlo${RLO}name`)
  writeFileSync(join(uni.dir, 'trojan.js'), `const ok = true\nconst s = "x${RLO}y"\n`)
  writeFileSync(join(uni.dir, 'bom.cs'), '﻿using System;\nclass B {}\n')
  const uniData = join(work, 'unicode-data')
  mkdirSync(uniData)
  writeFileSync(
    join(uniData, 'gitdesk.json'),
    JSON.stringify({ repos: [uni.dir], openTabs: [uni.dir], activeTab: uni.dir })
  )
  const sixth = await launch(uniData)
  try {
    const p = sixth.page
    const files = sixth.section('Unstaged files')
    await files.locator('li', { hasText: 'trojan.js' }).click()
    const diff = p.locator('.diff-view')
    await diff.locator('.hunk').first().waitFor()
    await p.locator('.hidden-chars-banner').waitFor()
    assert.equal(await diff.locator('.hunk .hidden-char', { hasText: 'U+202E' }).count(), 1)
    // The override itself never reaches the page: only its marker does.
    assert.equal((await diff.innerText()).includes(RLO), false)
    await sixth.shot('s08-hidden-chars')

    await files.locator('li', { hasText: 'bom.cs' }).click()
    await diff.locator('.diff-path', { hasText: 'bom.cs' }).waitFor()
    await diff.locator('.hidden-char.bom').first().waitFor()
    assert.equal(await p.locator('.hidden-chars-banner').count(), 0)
    assert.equal(await diff.locator('.hidden-char:not(.bom)').count(), 0)
    await p.keyboard.press('Escape')
    await diff.waitFor({ state: 'detached' })

    // A branch named with an override: a marker in the sidebar, and in its menu and its
    // dialogs the name is isolated and its override written out.
    const branch = p.locator(`.sidebar .sb-item[title="rlo${RLO}name"]`)
    await branch.locator('.hidden-char', { hasText: 'U+202E' }).waitFor()
    await branch.click({ button: 'right' })
    const checkout = p.locator('.context-menu [role=menuitem]', { hasText: 'Check out rlo' })
    await checkout.first().waitFor()
    const label = await checkout.first().innerText()
    assert.equal(label.includes(RLO), false)
    assert.match(label, /\[U\+202E\]/)
    assert.equal(await checkout.first().locator('bdi').count(), 1)
    await p.keyboard.press('Escape')
    assert.deepEqual(sixth.pageErrors, [])
  } finally {
    await sixth.app.close()
  }
  step('hidden characters show as markers with a warning; a leading BOM does not warn')

  console.log(`\nAll security checks passed. Screenshots: ${results}`)
} catch (e) {
  if (!closed) await shot('security-failure').catch(() => {})
  throw e
} finally {
  if (!closed) await app.close().catch(() => {})
  server.close()
  rmSync(work, { recursive: true, force: true, maxRetries: 5 })
}
