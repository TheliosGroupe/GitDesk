// End-to-end test of the terminal, worktrees, agent sessions, git extras (compare, line
// history, Gitflow, conflict warnings, patches), AI and hosting features. Like tests/e2e.mjs it
// drives the built app on throwaway repositories and checks the result with git itself.
// AI and GitLab are served by a fake HTTP server in this process.
//
//   npm run test:e2e      (runs tests/e2e.mjs, then this file; screenshots in test-results/)

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gitIn, launch, lines, results, step, until } from './e2e-helpers.mjs'

// --- fake services: an OpenAI-compatible API and a GitLab API -----------------------------
const requests = []

/** What the fake model answers, by the task its system prompt gives. */
function aiAnswer(system, user) {
  if (/connection test/i.test(system)) return 'OK'
  if (/You write git commit messages/.test(system))
    return 'feat: add greeting helper\n\nAdds greet() and tweaks app.js.'
  if (/You split uncommitted changes/.test(system)) {
    const ids = [...user.matchAll(/<change id="(\w+)"/g)].map((m) => m[1])
    const half = Math.ceil(ids.length / 2)
    const commits = [
      { message: 'feat: first part', changes: ids.slice(0, half) },
      { message: 'chore: second part', changes: ids.slice(half) }
    ]
    return 'Here is the plan:\n```json\n' + JSON.stringify({ commits }) + '\n```'
  }
  if (/You resolve git merge conflicts/.test(system)) {
    const blocks = [...user.matchAll(/<conflict index="(\d+)">/g)].map((m) => ({
      index: Number(m[1]),
      resolution: 'line 10 merged by AI',
      explanation: 'Both sides edited line 10.'
    }))
    return JSON.stringify({ blocks, note: '' })
  }
  if (/You explain code changes/.test(system))
    return '## Summary\nThis commit **adds** app.js.\n\n## What changed\n- `app.js`\n\n## Risks\nNone spotted'
  return 'unexpected request'
}

const now = new Date().toISOString()
const glProject = (id, path) => ({
  id,
  path_with_namespace: path,
  description: null,
  visibility: 'private',
  last_activity_at: now,
  http_url_to_repo: `https://gitlab.fake.test/${path}.git`,
  web_url: `https://gitlab.fake.test/${path}`,
  default_branch: 'main'
})
const glMr = (iid, title) => ({
  iid,
  project_id: 1,
  title,
  draft: false,
  web_url: `https://gitlab.fake.test/team/app/-/merge_requests/${iid}`,
  updated_at: now,
  author: { username: 'ann', name: 'Ann', avatar_url: null },
  source_branch: `feature-${iid}`,
  target_branch: 'main',
  source_project_id: 1,
  target_project_id: 1,
  references: { full: `team/app!${iid}` }
})
const glIssue = {
  iid: 3,
  project_id: 1,
  title: 'Login button does nothing',
  state: 'opened',
  web_url: 'https://gitlab.fake.test/team/app/-/issues/3',
  updated_at: now,
  assignee: { username: 'fakeuser', avatar_url: null },
  author: { username: 'ann', avatar_url: null },
  references: { full: 'team/app#3' }
}
const gitlab = {
  '/gl/api/v4/user': { username: 'fakeuser', name: 'Fake User', avatar_url: null },
  '/gl/api/v4/projects': [glProject(1, 'team/app')],
  '/gl/api/v4/groups': [],
  '/gl/api/v4/issues': [glIssue],
  '/gl/api/v4/projects/1/merge_requests/8': glMr(8, 'My merge request'),
  '/gl/api/v4/projects/team%2Fapp': glProject(1, 'team/app'),
  '/gl/api/v4/projects/team%2Fapp/merge_requests': [glMr(7, 'Please review me')],
  '/gl/api/v4/projects/team%2Fapp/issues': [glIssue]
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x')
    const body = raw ? JSON.parse(raw) : null
    requests.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization })
    if (url.pathname === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const text = aiAnswer(body.messages[0].content, body.messages[1].content)
      for (let i = 0; i < text.length; i += 16) {
        const chunk = { choices: [{ delta: { content: text.slice(i, i + 16) } }] }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        await new Promise((r) => setTimeout(r, 5))
      }
      return res.end('data: [DONE]\n\n')
    }
    if (req.headers.authorization !== 'Bearer glpat-test') {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end('{"message":"401 Unauthorized"}')
    }
    let answer = gitlab[url.pathname]
    if (url.pathname === '/gl/api/v4/merge_requests')
      answer = [
        url.searchParams.get('scope') === 'created_by_me'
          ? glMr(8, 'My merge request')
          : glMr(7, 'Please review me')
      ]
    if (req.method === 'POST' && url.pathname === '/gl/api/v4/projects/team%2Fapp/merge_requests')
      answer = { web_url: 'https://gitlab.fake.test/team/app/-/merge_requests/9' }
    res.writeHead(answer ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer ?? { message: '404 Not found' }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const fake = `http://127.0.0.1:${server.address().port}`

// --- fixture repositories ----------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'gitdesk-e2e-features-'))
const repo = join(work, 'sample')
const hosted = join(work, 'app')
const userData = join(work, 'userdata')
for (const dir of [repo, hosted, userData]) mkdirSync(dir)
const git = gitIn(repo)
const appGit = gitIn(hosted)
const read = (file) => readFileSync(join(repo, file), 'utf8')
const savedState = () => JSON.parse(readFileSync(join(userData, 'gitdesk.json'), 'utf8'))
const initRepo = (g) => {
  g('init', '-q', '-b', 'main')
  g('config', 'user.name', 'Test User')
  g('config', 'user.email', 'test@example.com')
  g('config', 'core.autocrlf', 'false')
}

initRepo(git)
writeFileSync(join(repo, 'app.js'), lines(30))
git('add', '-A')
git('commit', '-qm', 'Initial commit')
writeFileSync(join(repo, 'app.js'), lines(30, { 3: 'line three' }))
git('commit', '-qam', 'Edit line 3')
writeFileSync(join(repo, 'app.js'), lines(30, { 3: 'line three', 4: 'line FOUR' }))
git('commit', '-qam', 'Edit line 4')
// A local "remote", and a pushed branch of someone else's that edits line 10.
const remote = join(work, 'remote.git')
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
git('remote', 'add', 'origin', remote)
git('push', '-q', '-u', 'origin', 'main')
git('switch', '-qc', 'other')
writeFileSync(join(repo, 'app.js'), lines(30, { 3: 'line three', 4: 'line FOUR', 10: 'theirs' }))
git('commit', '-qam', 'Other work on line 10')
git('push', '-q', 'origin', 'other')
git('switch', '-q', 'main')
git('branch', '-qD', 'other')
// A local branch to compare with main.
git('switch', '-qc', 'topic')
writeFileSync(join(repo, 'feature.txt'), 'feature\n')
writeFileSync(join(repo, 'app.js'), lines(30, { 3: 'line three', 4: 'line FOUR', 20: 'feat' }))
git('add', '-A')
git('commit', '-qm', 'Feature work')
git('switch', '-q', 'main')

// A repository whose origin is on the fake GitLab. Pushes go to a local bare repository.
const hostedRemote = join(work, 'app-remote.git')
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', hostedRemote])
initRepo(appGit)
writeFileSync(join(hosted, 'a.txt'), 'a\n')
appGit('add', '-A')
appGit('commit', '-qm', 'Initial commit')
appGit('remote', 'add', 'origin', 'https://gitlab.fake.test/team/app.git')
appGit('config', 'remote.origin.pushurl', hostedRemote)
appGit('push', '-q', '-u', 'origin', 'main')

// What the fake coding agent does: records its arguments, then commits them.
const fakeAgent = join(work, 'fake-agent.js')
writeFileSync(
  fakeAgent,
  `const { writeFileSync } = require('fs')
const { execFileSync } = require('child_process')
writeFileSync('TASK.json', JSON.stringify({ argv: process.argv.slice(2), env: process.env.GITDESK_AGENT_TASK }))
execFileSync('git', ['add', 'TASK.json'])
execFileSync('git', ['commit', '-qm', 'Agent: record the task'])
console.log('fake agent done')
`
)

writeFileSync(
  join(userData, 'gitdesk.json'),
  JSON.stringify({ repos: [repo, hosted], openTabs: [repo], activeTab: repo })
)

const appEnv = { GITDESK_API_OVERRIDES: JSON.stringify({ 'gitlab.fake.test': `${fake}/gl` }) }
const first = await launch(userData, appEnv)
let app = first.app
const {
  page,
  pageErrors,
  shot,
  modal,
  menuItem,
  row,
  section,
  toast,
  confirmModal,
  goHome,
  repoTabs,
  blur
} = first
// Several repository tabs share the DOM (hidden ones stay mounted): only use the shown one.
const shown = (locator) => locator.filter({ visible: true })
const sbItem = (name) => shown(page.locator(`.sidebar .sb-item[title="${name}"]`))
const tab = (name) => page.getByRole('tab', { name })
const isSelected = async (name) => (await tab(name).getAttribute('aria-selected')) === 'true'
const openSettings = async (sectionLabel) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  // The dialog is loaded on first use (a lazy chunk): wait for it before reading it.
  await modal().locator('.settings-nav-item').first().waitFor()
  if (sectionLabel)
    await modal()
      .locator('.settings-nav-item', { hasText: new RegExp(`^${sectionLabel}$`) })
      .click()
}
const closeSettings = async () => {
  await page.keyboard.press('Escape')
  await modal().waitFor({ state: 'detached' })
}
const setTheme = async (name) => {
  await openSettings()
  await modal()
    .getByRole('radio', { name: new RegExp(name, 'i') })
    .click()
  await until(
    () => page.evaluate((t) => document.documentElement.dataset.theme === t, name.toLowerCase()),
    `${name} theme`
  )
  await closeSettings()
}
const undoButton = () => shown(page.locator('.toolbar .tool', { hasText: 'Undo' }))
const termText = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.terminal-dock:not([hidden]) .xterm-rows')]
      .map((e) => e.textContent)
      .join('\n')
  )

try {
  await page.locator('.graph-row').first().waitFor()

  // --- tabs and settings -----------------------------------------------------------------
  await blur()
  for (const [key, name] of [
    ['Control+1', 'Home'],
    ['Control+Shift+1', 'Projects'],
    ['Control+Shift+2', 'Launchpad'],
    ['Control+Shift+3', 'Agents'],
    ['Control+Shift+4', 'Activity'],
    ['Control+2', /sample/]
  ]) {
    await page.keyboard.press(key)
    await until(() => isSelected(name), `${key} selects ${name}`)
  }
  await page.locator('.graph-row').first().waitFor()
  step('Ctrl+1 shows Home, Ctrl+Shift+1…4 its pages, Ctrl+2 the first repository')

  const homeNav = page.locator('.home-nav')
  await goHome('Launchpad')
  await page.locator('.launchpad').waitFor()
  await homeNav.getByRole('tab', { name: 'Agents', exact: true }).click()
  await page.locator('.agents-view').waitFor()
  assert.equal(await page.locator('.launchpad').count(), 0)
  await tab(/sample/).click()
  await page.locator('.home').waitFor({ state: 'detached' })
  await goHome()
  await until(() => isSelected('Agents'), 'Home remembers Agents')
  await page.locator('.agents-view').waitFor()
  // Arrow keys move along the pages.
  await homeNav.getByRole('tab', { name: 'Agents', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await until(() => isSelected('Activity'), 'ArrowDown selects Activity')
  // The focus follows (Home is not remounted on a page change), so the keys keep working.
  await until(
    () => page.evaluate(() => document.activeElement?.getAttribute('role') === 'tab'),
    'the selected page keeps the focus'
  )
  await page.keyboard.press('ArrowUp')
  await until(() => isSelected('Agents'), 'ArrowUp selects Agents')
  await page.keyboard.press('ArrowUp')
  await until(() => isSelected('Launchpad'), 'a second ArrowUp selects Launchpad')
  await page.getByRole('button', { name: 'Collapse the navigation' }).click()
  await page.locator('.home.collapsed').waitFor()
  await until(async () => (await homeNav.boundingBox()).width < 60, 'navigation collapsed to icons')
  await shot('f00-home-collapsed')
  await page.getByRole('button', { name: 'Expand the navigation' }).click()
  await page.locator('.home:not(.collapsed)').waitFor()
  await tab(/sample/).click()
  step('Home: the navigation switches pages, remembers the last one, collapses to icons')

  await openSettings()
  const navItems = modal().locator('.settings-nav-item')
  const sectionIds = ['general', 'appearance', 'integrations', 'ai', 'agents', 'updates']
  assert.equal(await navItems.count(), sectionIds.length)
  for (let i = 0; i < sectionIds.length; i++) {
    await navItems.nth(i).click()
    await until(
      async () => (await navItems.nth(i).getAttribute('aria-current')) === 'true',
      `settings section ${sectionIds[i]} current`
    )
    assert.equal(
      await modal().locator(`[data-section="${sectionIds[i]}"]`).isVisible(),
      true,
      sectionIds[i]
    )
  }
  await shot('f01-settings')
  await closeSettings()
  step('Settings: every section of the navigation renders and becomes current')

  // --- terminal ----------------------------------------------------------------------------
  const dock = shown(page.locator('.terminal-dock'))
  const terminalTool = shown(page.locator('.toolbar .tool', { hasText: 'Terminal' }))
  await blur()
  await page.keyboard.press('Control+Backquote')
  await page.locator('.terminal-dock .xterm').waitFor()
  await until(async () => (await termText()).includes('sample'), 'shell prompt', 20000)
  await page.locator('.terminal-dock .xterm').click()
  await page.keyboard.type('git commit --allow-empty -m from-terminal')
  await page.keyboard.press('Enter')
  await row('from-terminal').waitFor({ timeout: 20000 })
  assert.equal(git('log', '-1', '--format=%s'), 'from-terminal')
  step('Ctrl+` opens the terminal; a commit typed there shows up in the graph')

  // Focus is in the terminal, which keeps most keys for itself, but not Ctrl+`.
  await page.keyboard.press('Control+Backquote')
  await page.locator('.terminal-dock').waitFor({ state: 'hidden' })
  assert.equal(await terminalTool.getAttribute('aria-pressed'), 'false')
  await terminalTool.click()
  await dock.waitFor()
  await until(async () => (await termText()).includes('from-terminal'), 'output kept')
  // Ctrl+W deletes a word in the shell; it must not close the repository tab.
  await page.locator('.terminal-dock .xterm').click()
  await page.keyboard.press('Control+w')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(await isSelected(/sample/), true)
  step('Ctrl+` from inside the terminal hides it; showing it again keeps the output')

  await setTheme('Light')
  await shot('f02-light-terminal')
  await setTheme('Dark')
  await terminalTool.click()
  await page.locator('.terminal-dock').waitFor({ state: 'hidden' })
  step('light theme screenshot of the repository with the terminal open')

  // --- conflict warnings ---------------------------------------------------------------------
  writeFileSync(join(repo, 'app.js'), read('app.js').replace('line 10\n', 'line 10 mine\n'))
  const cw = shown(page.locator('.cw-tool'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await cw.waitFor({ timeout: 15000 })
  await cw.click()
  await page.locator('.cw-popover .cw-item', { hasText: 'origin/other' }).waitFor()
  await page.locator('.cw-popover .cw-files li', { hasText: 'app.js' }).first().waitFor()
  await shot('f03-conflict-warnings')
  await page.keyboard.press('Escape')
  await page.locator('.cw-popover').waitFor({ state: 'detached' })
  git('checkout', '--', 'app.js')
  await cw.waitFor({ state: 'detached', timeout: 15000 })
  step('conflict warnings: a remote branch editing the same file shows up, and goes away')

  // --- compare -------------------------------------------------------------------------------
  const compare = page.locator('.compare-view')
  await sbItem('topic').click({ button: 'right' })
  await menuItem('Compare with main').click()
  await compare.locator('.cmp-commit', { hasText: 'Feature work' }).waitFor()
  await compare.locator('.cmp-commit', { hasText: 'from-terminal' }).waitFor()
  const cmpFiles = git('diff', '--name-only', 'main...topic').split('\n')
  await until(
    async () => (await compare.locator('.cmp-file').count()) === cmpFiles.length,
    'compared files'
  )
  assert.deepEqual((await compare.locator('.cmp-path').allInnerTexts()).sort(), cmpFiles.sort())
  assert.equal(
    await compare.locator('.cmp-commit').count(),
    Number(git('rev-list', '--count', 'main...topic'))
  )
  await shot('f04-compare')
  await compare.getByRole('button', { name: 'Close', exact: true }).click()
  await compare.waitFor({ state: 'detached' })

  await row('Edit line 3').click()
  await row('Feature work').click({ modifiers: ['Control'] })
  await compare.locator('.cmp-commit', { hasText: 'Feature work' }).waitFor()
  assert.deepEqual(await compare.locator('.cmp-subject').allInnerTexts(), [
    'Feature work',
    'Edit line 4'
  ])
  await compare.getByRole('button', { name: 'Close', exact: true }).click()
  await compare.waitFor({ state: 'detached' })
  step('compare: "Compare with main" and Ctrl+click on two commits list commits and files')

  // --- line history --------------------------------------------------------------------------
  await row('Edit line 4').click()
  await page.locator('.side-panel li', { hasText: 'app.js' }).click({ button: 'right' })
  await menuItem('File history').click()
  await page.getByRole('tab', { name: 'Blame' }).click()
  const ln = (n) => page.locator('.bl-ln', { hasText: new RegExp(`^${n}$`) }).first()
  await ln(3).click()
  await ln(4).click({ modifiers: ['Shift'] })
  await page.locator('.bl-select-bar', { hasText: 'Lines 3–4 selected' }).waitFor()
  await page.getByRole('button', { name: 'Line history' }).click()
  await page.locator('.line-history .lh-entry').first().waitFor()
  assert.deepEqual(
    await page.locator('.lh-subject').allInnerTexts(),
    git('log', '-L', '3,4:app.js', '--no-patch', '--format=%s').split('\n')
  )
  await shot('f05-line-history')
  await page.keyboard.press('Escape')
  await page.locator('.line-history').waitFor({ state: 'detached' })
  await page.keyboard.press('Escape')
  await page.locator('.file-history').waitFor({ state: 'detached' })
  step('blame: select lines 3–4, Line history lists the commits that changed them')

  // --- Gitflow -------------------------------------------------------------------------------
  const gitflow = shown(page.locator('.gf-tool'))
  await gitflow.click()
  await menuItem('Initialize Gitflow').click()
  await modal().getByRole('button', { name: 'Initialize' }).click()
  await modal().waitFor({ state: 'detached' })
  await until(() => git('config', 'gitflow.branch.develop') === 'develop', 'gitflow config')
  assert.equal(git('rev-parse', 'develop'), git('rev-parse', 'main'))
  await gitflow.click()
  await menuItem('Start feature').click()
  await modal().locator('#gf-name').fill('login page')
  await modal().getByRole('button', { name: 'Start feature' }).click()
  await until(() => git('branch', '--show-current') === 'feature/login-page', 'feature branch')
  writeFileSync(join(repo, 'login.js'), 'login\n')
  git('add', '-A')
  git('commit', '-qm', 'Login page')
  await shown(page.locator('.toolbar-branch', { hasText: 'feature/login-page' })).waitFor()
  await gitflow.click()
  await menuItem('Finish feature login-page').click()
  await modal().getByRole('button', { name: 'Finish feature' }).click()
  await toast('Finished feature').waitFor()
  assert.equal(git('branch', '--show-current'), 'develop')
  assert.equal(git('branch', '--list', 'feature/login-page'), '')
  assert.match(git('log', '--format=%s', 'develop'), /^Login page$/m)
  assert.notEqual(git('rev-parse', 'develop'), git('rev-parse', 'main'))
  await until(async () => /Undo/.test(await undoButton().getAttribute('title')), 'undo finish')
  await undoButton().click()
  await until(() => git('branch', '--list', 'feature/login-page') !== '', 'branch restored')
  assert.equal(git('rev-parse', 'develop'), git('rev-parse', 'main'))
  git('switch', '-q', 'main')
  await shown(page.locator('.toolbar-branch', { hasText: /^main$/ })).waitFor()
  step('Gitflow: init, start a feature, finish it into develop, then undo the finish')

  // --- patches (native file dialogs stubbed in the main process) -----------------------------
  const patchFile = join(work, 'login.patch')
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, patchFile)
  await row('Login page').click({ button: 'right' })
  await menuItem('Export as patch').click()
  await toast('Patch saved').waitFor()
  assert.match(readFileSync(patchFile, 'utf8'), /Subject: \[PATCH\] Login page/)
  await shown(page.getByRole('button', { name: 'More actions' })).click()
  await menuItem('Apply patch').click()
  await toast('Applied 1 commit').waitFor()
  assert.equal(git('log', '-1', '--format=%s'), 'Login page')
  assert.equal(git('branch', '--show-current'), 'main')
  assert.equal(read('login.js'), 'login\n')
  assert.equal(git('status', '--porcelain'), '')
  // Staged changes too: a plain diff, applied back with `git apply`.
  writeFileSync(join(repo, 'login.js'), 'login v2\n')
  git('add', 'login.js')
  await shown(page.locator('.graph-row.wip')).waitFor()
  await shown(page.getByRole('button', { name: 'More actions' })).click()
  await menuItem('Export staged changes as patch').click()
  await until(() => /^\+login v2$/m.test(readFileSync(patchFile, 'utf8')), 'staged patch saved')
  git('reset', '-q', '--hard')
  await shown(page.locator('.graph-row.wip')).waitFor({ state: 'detached' })
  await shown(page.getByRole('button', { name: 'More actions' })).click()
  await menuItem('Apply patch').click()
  await toast('Patch applied to the working copy').waitFor()
  assert.equal(git('status', '--porcelain'), 'M  login.js')
  assert.equal(read('login.js'), 'login v2\n')
  git('reset', '-q', '--hard')
  step('patches: export a commit and staged changes, apply them from the "More actions" menu')

  // --- worktrees -----------------------------------------------------------------------------
  const worktrees = shown(
    page.locator('.sidebar .sb-section', {
      has: page.locator('.sb-section-title', { hasText: 'Worktrees' })
    })
  )
  await worktrees.getByRole('button', { name: 'Add worktree…' }).click()
  await modal().locator('#wt-name').fill('feature/ui')
  await modal().getByRole('button', { name: 'Add worktree' }).click()
  const wtPath = join(work, 'sample.worktrees', 'feature-ui')
  const wtTab = tab(/feature-ui/)
  await until(() => isSelected(/feature-ui/), 'worktree tab active', 15000)
  await wtTab.getByLabel('worktree').waitFor()
  await shown(page.locator('.toolbar-worktree', { hasText: 'worktree of sample' })).waitFor()
  assert.ok(existsSync(wtPath))
  assert.equal(git('-C', wtPath, 'branch', '--show-current'), 'feature/ui')
  await shot('f06-worktree-tab')
  // A shell running in the worktree must not keep its folder from being removed (Windows).
  await blur()
  await page.keyboard.press('Control+Backquote')
  await until(async () => (await termText()).includes('feature-ui'), 'worktree shell', 20000)
  await tab(/sample/).click()
  await worktrees.locator('.wt-item', { hasText: 'feature/ui' }).click({ button: 'right' })
  await menuItem('Remove worktree…').click()
  await confirmModal('Remove')
  await until(() => !existsSync(wtPath), 'worktree folder removed', 15000)
  await wtTab.waitFor({ state: 'detached' })
  assert.equal(git('worktree', 'list').split('\n').length, 1)
  assert.equal(git('branch', '--list', 'feature/ui'), '  feature/ui') // the branch is kept
  assert.deepEqual(savedState().repos.sort(), [hosted, repo].sort())
  step('worktrees: Add worktree opens a tab with a worktree badge; Remove closes it')

  // --- agent session -------------------------------------------------------------------------
  await openSettings('Terminal & agents')
  await modal().locator('#settings-agent-custom').fill(`node "${fakeAgent}"`)
  await modal().locator('#settings-agent-custom').press('Tab')
  await modal().locator('.agent-found', { hasText: 'Found' }).first().waitFor()
  await closeSettings()
  await goHome('Agents')
  await page.getByRole('button', { name: 'New agent session' }).first().click()
  const task = 'Fix "quotes" & pipes | 100% done %PATH% ^caret'
  await modal().locator('#agent-repo').selectOption(repo)
  await modal().locator('#agent-kind').selectOption('custom')
  await modal().locator('#agent-task').fill(task)
  await modal().getByRole('button', { name: 'Start agent' }).click()
  await modal().waitFor({ state: 'detached' })
  const card = page.locator('.agent-card', { hasText: task })
  await card
    .locator('.agent-last', { hasText: 'Agent: record the task' })
    .waitFor({ timeout: 20000 })
  const agentBranch = await card.locator('.agent-meta .mono').innerText()
  const agentPath = await card.locator('.agent-meta .mono').getAttribute('title')
  assert.match(agentBranch, /^agent\//)
  assert.ok(existsSync(agentPath))
  assert.deepEqual(JSON.parse(git('show', `${agentBranch}:TASK.json`)), { argv: [task], env: task })
  await shot('f07-agents')
  await card.getByRole('button', { name: 'Open' }).click()
  const agentTab = tab(new RegExp(basename(agentPath)))
  await until(() => isSelected(new RegExp(basename(agentPath))), 'agent worktree tab')
  await shown(page.locator('.graph-row', { hasText: 'Agent: record the task' })).waitFor()
  await goHome('Agents')
  // Uncommitted work and a commit no other branch has: kept until confirmed a second time.
  writeFileSync(join(agentPath, 'notes.txt'), 'draft')
  await card.getByRole('button', { name: 'End session…' }).click()
  await modal()
    .getByLabel(/Remove the worktree folder/)
    .check()
  await modal()
    .getByLabel(/Delete the branch/)
    .check()
  await modal().getByRole('button', { name: 'End session' }).click()
  await modal().locator('.warning', { hasText: 'has 1 uncommitted change' }).waitFor()
  await modal()
    .locator('.warning', { hasText: 'has 1 commit that is in no other branch' })
    .waitFor()
  assert.ok(existsSync(join(agentPath, 'notes.txt')))
  assert.equal(git('branch', '--list', agentBranch), `+ ${agentBranch}`)
  await confirmModal('Discard changes and commits')
  await card.waitFor({ state: 'detached' })
  await agentTab.waitFor({ state: 'detached' })
  await until(() => !existsSync(agentPath), 'agent worktree removed')
  assert.equal(git('branch', '--list', agentBranch), '')
  assert.equal(git('worktree', 'list').split('\n').length, 1)
  assert.deepEqual(savedState().repos.sort(), [hosted, repo].sort())
  step(
    'agent session: the task arrives verbatim, its commit shows; End session asks again before losing work'
  )

  // --- AI (fake OpenAI-compatible server) ----------------------------------------------------
  await openSettings('AI')
  await modal().locator('#settings-ai-provider').selectOption('ollama')
  await modal().locator('#settings-ai-url').fill(fake)
  await modal().locator('#settings-ai-model').click() // leaving the URL field saves it
  await modal().getByRole('button', { name: 'Test connection' }).click()
  await modal().locator('.ai-test.ok').waitFor()
  await closeSettings()
  await tab(/sample/).click()

  writeFileSync(join(repo, 'app.js'), read('app.js').replace('line 2\n', 'line 2 changed\n'))
  writeFileSync(join(repo, 'app.js'), read('app.js').replace('line 28\n', 'line 28 changed\n'))
  writeFileSync(join(repo, 'greet.js'), 'export const greet = () => "hi"\n')
  git('add', 'greet.js')
  await row('// WIP').click()
  await shown(page.getByRole('button', { name: 'Generate commit message' })).click()
  const summary = shown(page.getByPlaceholder('Summary'))
  await until(async () => (await summary.inputValue()) === 'feat: add greeting helper', 'summary')
  const lastAi = () => requests.filter((r) => r.path === '/v1/chat/completions').at(-1)
  assert.match(lastAi().body.messages[1].content, /greet\.js/)
  assert.doesNotMatch(lastAi().body.messages[1].content, /line 2 changed/) // staged only
  await summary.fill('')
  await shown(page.locator('.commit-box textarea')).fill('')
  step('AI: Generate commit message fills the summary from the staged diff')

  const before = Number(git('rev-list', '--count', 'HEAD'))
  await shown(page.getByRole('button', { name: /Compose commits with AI/ })).click()
  await modal().locator('.ai-group').nth(1).waitFor()
  assert.equal(await modal().locator('.ai-unit').count(), 3) // two hunks of app.js, greet.js
  await modal()
    .getByRole('button', { name: /Commit all \(2\)/ })
    .click()
  await modal().waitFor({ state: 'detached' })
  await until(() => Number(git('rev-list', '--count', 'HEAD')) === before + 2, 'two commits')
  assert.deepEqual(git('log', '-2', '--format=%s').split('\n'), [
    'chore: second part',
    'feat: first part'
  ])
  assert.equal(git('status', '--porcelain'), '')
  step('AI: Compose commits splits the changes into two commits')

  await row('Initial commit').click({ button: 'right' })
  await menuItem('Explain this commit (AI)').click()
  await modal().locator('.markdown h3', { hasText: 'Risks' }).waitFor()
  assert.match(await modal().locator('.markdown').innerHTML(), /<strong>adds<\/strong>/)
  await modal().getByRole('button', { name: 'Close' }).first().click()
  await modal().waitFor({ state: 'detached' })
  step('AI: Explain this commit renders the answer')

  git('switch', '-qc', 'ai-side')
  writeFileSync(join(repo, 'app.js'), read('app.js').replace('line 10\n', 'line 10 theirs\n'))
  git('commit', '-qam', 'Line 10 on ai-side')
  git('switch', '-q', 'main')
  writeFileSync(join(repo, 'app.js'), read('app.js').replace('line 10\n', 'line 10 ours\n'))
  git('commit', '-qam', 'Line 10 on main')
  assert.throws(() => git('merge', '-q', 'ai-side'))
  const conflicts = shown(section('Conflicts'))
  await conflicts.locator('li', { hasText: 'app.js' }).click()
  await page.getByRole('button', { name: 'Suggest with AI' }).click()
  await until(
    async () => (await page.locator('.conflict-ai-text').inputValue()) === 'line 10 merged by AI',
    'AI suggestion'
  )
  await shot('f08-conflict-ai')
  // A suggestion is never used by itself: it is accepted conflict by conflict.
  const markResolved = page.getByRole('button', { name: 'Mark resolved', exact: true })
  assert.equal(await markResolved.isDisabled(), true, 'not resolved before accepting the AI text')
  const useAi = page.getByRole('button', { name: 'Use AI suggestion' })
  await useAi.click()
  await until(() => markResolved.isEnabled(), 'Mark resolved once the suggestion is accepted')
  // New suggestions are reviewed again: Suggest again drops the earlier acceptance.
  await page.getByRole('button', { name: 'Suggest again' }).click()
  await until(() => markResolved.isDisabled(), 'Suggest again asks for a new review')
  await until(() => useAi.isVisible(), 'the new suggestion is offered')
  await useAi.click()
  await markResolved.click()
  await conflicts.waitFor({ state: 'detached' })
  await shown(page.locator('.banner:not(.trust-banner)'))
    .getByRole('button', { name: 'Continue' })
    .click()
  await until(() => git('log', '-1', '--format=%P').split(' ').length === 2, 'merge commit')
  assert.match(read('app.js'), /\nline 9\nline 10 merged by AI\nline 11\n/)
  assert.equal(git('status', '--porcelain'), '')
  step(
    'AI: Suggest with AI proposes a block, used only once accepted; Mark resolved + Continue merge it'
  )

  // --- hosting (fake GitLab) -----------------------------------------------------------------
  await goHome('Projects')
  await page.getByRole('button', { name: 'GitLab, Bitbucket, Azure DevOps…' }).click()
  await modal().getByRole('radio', { name: 'GitLab' }).click()
  await modal().getByLabel('Host').fill('gitlab.fake.test')
  await modal().getByLabel('Token').fill('glpat-test')
  await modal().getByRole('button', { name: 'Add account' }).click()
  await page.locator('.account-chip', { hasText: 'fakeuser' }).waitFor()
  await modal().waitFor({ state: 'detached' })
  step('hosting: add a GitLab account with a token')

  await goHome('Launchpad')
  const launchpad = page.locator('.launchpad')
  await launchpad.getByText('Please review me').waitFor({ timeout: 15000 })
  await launchpad.getByText('My merge request').waitFor()
  await launchpad.getByText('Login button does nothing').waitFor()
  await shot('f09-launchpad')
  step('Launchpad lists the review request, my merge request and the assigned issue')

  const projectCard = (name) =>
    page
      .locator('.card')
      .filter({ has: page.locator('.card-name', { hasText: new RegExp(`^${name}$`) }) })
  await goHome('Projects')
  await projectCard('app').click()
  await until(() => isSelected(/^app/), 'app tab')
  const issue = shown(page.locator('.issue-item', { hasText: 'Login button does nothing' }))
  await issue.click({ timeout: 15000 })
  await menuItem('Create branch and check out').click()
  const issueBranch = '3-login-button-does-nothing'
  await until(() => appGit('branch', '--show-current') === issueBranch, 'issue branch')
  await sbItem(issueBranch).click({ button: 'right' })
  await menuItem('Create pull request…').click()
  await modal().locator('#pr-title').waitFor()
  assert.equal(await modal().locator('#pr-title').inputValue(), 'Login button does nothing')
  assert.equal(await modal().locator('#pr-body').inputValue(), 'Closes #3')
  await shot('f10-create-mr')
  await modal().getByRole('button', { name: 'Create merge request' }).click()
  await toast('Pull request created').waitFor()
  await modal().waitFor({ state: 'detached' })
  assert.equal(await page.locator('.toast', { hasText: 'Pull request created' }).count(), 1)
  const created = requests.find((r) => r.method === 'POST' && r.path.endsWith('/merge_requests'))
  assert.equal(created.path, '/gl/api/v4/projects/team%2Fapp/merge_requests')
  assert.equal(created.body.source_branch, issueBranch)
  assert.equal(created.body.target_branch, 'main')
  assert.equal(created.body.title, 'Login button does nothing')
  const pushed = execFileSync('git', ['ls-remote', '--heads', hostedRemote], { encoding: 'utf8' })
  assert.match(pushed, new RegExp(`refs/heads/${issueBranch}`))
  step('sidebar Issues: branch from an issue; Create merge request pushes it and creates it')

  // --- workspaces ----------------------------------------------------------------------------
  await goHome('Projects')
  const picker = page.getByLabel('Workspace', { exact: true })
  await picker.selectOption({ label: 'New workspace…' })
  await modal().locator('input').fill('Work')
  await modal().getByRole('button', { name: 'Create' }).click()
  await page.locator('.dash-empty', { hasText: '“Work” is empty' }).waitFor()
  await picker.selectOption({ label: 'All repositories' })
  await projectCard('sample').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Add to workspace ▸ Work/ }).click()
  await picker.selectOption({ label: 'Work (1)' })
  await projectCard('sample').waitFor()
  assert.equal(await projectCard('app').count(), 0)
  assert.deepEqual(
    savedState().workspaces.map((w) => [w.name, w.repos.length]),
    [['Work', 1]]
  )
  // Someone pushes to main: Sync workspace fetches it.
  const other = join(work, 'other')
  execFileSync('git', ['clone', '-q', remote, other])
  const otherGit = gitIn(other)
  otherGit('config', 'user.name', 'Test User')
  otherGit('config', 'user.email', 'test@example.com')
  otherGit('config', 'core.autocrlf', 'false')
  writeFileSync(join(other, 'pushed.txt'), 'pushed\n')
  otherGit('add', '-A')
  otherGit('commit', '-qm', 'Pushed from elsewhere')
  otherGit('push', '-q', 'origin', 'main')
  await page.getByRole('button', { name: 'Sync workspace' }).click()
  await projectCard('sample').locator('.badge', { hasText: '↓1' }).waitFor()
  assert.equal(git('rev-list', '--count', 'main..origin/main'), '1')
  await shot('f11-workspace')
  step('workspaces: create, add a repository, filter by it, Sync workspace fetches it')

  // --- Home pages and the tab bar -------------------------------------------------------------
  const homePages = {
    Projects: () => page.locator('.cards .card').first().waitFor(),
    Launchpad: () => page.locator('.launchpad').getByText('Please review me').waitFor(),
    Agents: () => page.locator('.agents-view').waitFor(),
    Activity: () => page.locator('.stat-value').first().waitFor()
  }
  const homeShots = async (theme) => {
    for (const [name, ready] of Object.entries(homePages)) {
      await goHome(name)
      await ready()
      await shot(`f12-home-${name.toLowerCase()}-${theme}`)
    }
  }
  const appTab = tab(/^app/)
  /** Drags the app tab onto the left half of the sample tab, with a screenshot mid-drag. */
  const dragAppBeforeSample = async (shotName) => {
    const from = await appTab.boundingBox()
    const to = await tab(/sample/).boundingBox()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + 8, to.y + to.height / 2, { steps: 12 })
    await page.locator('.tab-drop-indicator').waitFor()
    await new Promise((r) => setTimeout(r, 250)) // the other tabs slide aside
    await shot(shotName)
    await page.mouse.up()
    await page.locator('.tab-drop-indicator').waitFor({ state: 'detached' })
  }
  await homeShots('dark')
  await appTab.click()
  assert.deepEqual(await repoTabs(), ['sample', 'app'])
  // A press that barely moves is a click, not a drag.
  const box = await appTab.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 3, box.y + box.height / 2)
  await page.mouse.up()
  assert.equal(await page.locator('.tab-drop-indicator').count(), 0)
  assert.deepEqual(await repoTabs(), ['sample', 'app'])
  await dragAppBeforeSample('f13-tab-drag-dark')
  assert.deepEqual(await repoTabs(), ['app', 'sample'])
  assert.equal(await isSelected(/^app/), true)
  await until(() => savedState().openTabs.join() === [hosted, repo].join(), 'order saved')
  step('dragging a repository tab before another reorders the tabs and saves the order')

  await blur()
  await page.keyboard.press('Control+Shift+PageDown')
  await until(async () => (await repoTabs()).join() === 'sample,app', 'moved right')
  await page.keyboard.press('Control+Shift+PageDown') // already last: stays
  await page.keyboard.press('Control+2')
  await until(() => isSelected(/sample/), 'Ctrl+2 selects the first tab')
  await page.keyboard.press('Control+Shift+PageUp') // already first: stays
  assert.deepEqual(await repoTabs(), ['sample', 'app'])
  step('Ctrl+Shift+PageDown / PageUp move the active tab; Ctrl+2 follows the new order')

  await setTheme('Light')
  await dragAppBeforeSample('f13-tab-drag-light')
  assert.deepEqual(await repoTabs(), ['app', 'sample'])
  await homeShots('light')
  await setTheme('Dark')
  await blur()
  await page.keyboard.press('Control+Shift+3')
  await until(() => isSelected('Agents'), 'Agents')
  await until(() => savedState().openTabs.join() === [hosted, repo].join(), 'order saved')
  assert.deepEqual(pageErrors, [])
  await app.close()

  const second = await launch(userData, appEnv)
  app = second.app
  await second.page.locator('.tabbar-tabs [role=tab]').nth(1).waitFor()
  assert.deepEqual(await second.repoTabs(), ['app', 'sample'])
  const tab2 = (name) => second.page.getByRole('tab', { name })
  await until(async () => (await tab2('Agents').getAttribute('aria-selected')) === 'true', 'Agents')
  await second.page.keyboard.press('Control+2')
  await until(async () => (await tab2(/^app/).getAttribute('aria-selected')) === 'true', 'app')
  assert.deepEqual(second.pageErrors, [])
  step('after a restart: the tab order is kept and Home reopens on the page used last')

  // --- big changes: a 60,000-line diff, 5,000 untracked files, a conflict too large to
  // show, and a linked worktree's tab refreshing by itself (PERF-09, PERF-32, PERF-25) ---
  await app.close()
  const scale = join(work, 'scale')
  const scaleData = join(work, 'userdata-scale')
  for (const dir of [scale, scaleData]) mkdirSync(dir)
  const scaleGit = gitIn(scale)
  initRepo(scaleGit)
  const BIG = 30000
  const bigLines = (fmt) => Array.from({ length: BIG }, (_, i) => fmt(i + 1)).join('\n') + '\n'
  writeFileSync(
    join(scale, 'big.txt'),
    bigLines((n) => `line ${n}`)
  )
  scaleGit('add', '-A')
  scaleGit('commit', '-qm', 'Big file')
  // Every line changed: one hunk of 30,000 removed and 30,000 added lines.
  writeFileSync(
    join(scale, 'big.txt'),
    bigLines((n) => `LINE ${n} changed`)
  )
  mkdirSync(join(scale, 'many'))
  const MANY = 5000
  const manyName = (i) => `f${String(i).padStart(4, '0')}.txt`
  for (let i = 0; i < MANY; i++) writeFileSync(join(scale, 'many', manyName(i)), `${i}\n`)
  // A linked worktree, opened as its own tab.
  const linked = join(work, 'scale-linked')
  scaleGit('worktree', 'add', '-q', '-b', 'linked-branch', linked)
  const linkedGit = gitIn(linked)
  // Both sides rewrite a file into more than GitDesk shows (5 MB): the merge stops on it.
  const huge = join(work, 'huge')
  mkdirSync(huge)
  const hugeGit = gitIn(huge)
  initRepo(hugeGit)
  writeFileSync(join(huge, 'data.txt'), 'base\n')
  hugeGit('add', '-A')
  hugeGit('commit', '-qm', 'Base')
  const hugeText = (ch) => `${ch.repeat(79)}\n`.repeat(70000)
  hugeGit('switch', '-qc', 'theirs')
  writeFileSync(join(huge, 'data.txt'), hugeText('t'))
  hugeGit('commit', '-qam', 'Theirs')
  hugeGit('switch', '-q', 'main')
  writeFileSync(join(huge, 'data.txt'), hugeText('m'))
  hugeGit('commit', '-qam', 'Ours')
  try {
    hugeGit('merge', '-q', 'theirs')
  } catch {
    /* stops on the conflict, as expected */
  }
  assert.match(hugeGit('status', '--porcelain'), /^UU data\.txt/m)
  writeFileSync(
    join(scaleData, 'gitdesk.json'),
    JSON.stringify({
      repos: [scale, linked, huge],
      openTabs: [scale, linked, huge],
      activeTab: scale
    })
  )
  const third = await launch(scaleData)
  app = third.app
  const p3 = third.page
  const shown3 = (locator) => locator.filter({ visible: true })
  const unstaged3 = shown3(third.section('Unstaged files'))
  /** Scrolls the box that scrolls `locator` (the element itself or a parent) to its end. */
  const scrollToEnd = (locator) =>
    locator.evaluate((el) => {
      for (let e = el; e; e = e.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight) {
          e.scrollTop = e.scrollHeight
          return
        }
      }
    })
  const diffNodes = () => p3.evaluate(() => document.querySelectorAll('.diff-view *').length)
  await shown3(p3.locator('.graph-row.wip')).waitFor({ timeout: 30000 })

  await unstaged3.locator('li', { hasText: 'big.txt' }).click()
  await p3.locator('.diff-view .hunk').first().waitFor({ timeout: 30000 })
  await p3.getByRole('checkbox', { name: 'Removed line 1', exact: true }).waitFor()
  assert.ok((await diffNodes()) < 3000, `the diff draws ${await diffNodes()} nodes`)
  const lastLine = p3.getByRole('checkbox', { name: `Added line ${BIG}`, exact: true })
  await until(
    async () => {
      await scrollToEnd(p3.locator('.diff-view .diff-body'))
      return (await lastLine.count()) > 0
    },
    'the last line is drawn once scrolled to',
    20000
  )
  assert.ok((await diffNodes()) < 3000, `the scrolled diff draws ${await diffNodes()} nodes`)
  await third.shot('f20-big-diff-end')
  const farDown = BIG - 10
  await p3.getByRole('checkbox', { name: `Added line ${farDown}`, exact: true }).click()
  await p3.getByRole('button', { name: 'Stage selected lines' }).click()
  await until(
    () => scaleGit('diff', '--cached', '--', 'big.txt').includes(`+LINE ${farDown} changed`),
    'the line far down is staged',
    20000
  )
  const cachedBig = scaleGit('diff', '--cached', '--', 'big.txt')
  assert.equal(cachedBig.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length, 1)
  // Esc first clears a line selection still shown (the diff may not be read again yet),
  // then closes the diff.
  await third.blur()
  await until(
    async () => {
      if ((await p3.locator('.diff-view').count()) === 0) return true
      await p3.keyboard.press('Escape')
      return false
    },
    'the diff closes',
    15000
  )
  step('a 60,000-line diff draws only what is in view; a line far down can be staged')

  const listed = () => shown3(p3.locator('.file-list li')).count()
  await unstaged3.locator('li', { hasText: manyName(0) }).waitFor()
  assert.ok((await listed()) < 200, `the file lists draw ${await listed()} rows`)
  const lastFile = unstaged3.locator('li', { hasText: manyName(MANY - 1) })
  await until(
    async () => {
      await scrollToEnd(unstaged3.locator('.file-list'))
      return (await lastFile.count()) > 0
    },
    'the last file is drawn once scrolled to',
    20000
  )
  assert.ok((await listed()) < 200, `the scrolled lists draw ${await listed()} rows`)
  await lastFile.click()
  await p3.locator('.diff-view .diff-path', { hasText: manyName(MANY - 1) }).waitFor()
  await p3.keyboard.press('Escape')
  await p3.locator('.diff-view').waitFor({ state: 'detached' })
  await unstaged3.getByRole('button', { name: 'Stage all' }).click()
  // --no-optional-locks: polling must not take index.lock while GitDesk is staging.
  const stagedAll = () =>
    !/^(\?\?| M)/m.test(scaleGit('--no-optional-locks', 'status', '--porcelain'))
  await until(stagedAll, 'every file staged', 30000).catch(async (e) => {
    const left = scaleGit('--no-optional-locks', 'status', '--porcelain')
      .split('\n')
      .filter((l) => !/^[AM]/.test(l))
    console.error('not staged:', left.length, left.slice(0, 5))
    console.error('toasts:', await p3.locator('.toast').allInnerTexts())
    throw e
  })
  assert.equal(scaleGit('diff', '--cached', '--name-only').split('\n').length, MANY + 1)
  step('5,000 untracked files: the list draws only what is in view; Stage all stages every one')

  // A commit made in the linked worktree, outside the app: its tab refreshes by itself.
  await p3.getByRole('tab', { name: /scale-linked/ }).click()
  await shown3(p3.locator('.graph-row')).first().waitFor({ timeout: 15000 })
  writeFileSync(join(linked, 'from-linked.txt'), 'x\n')
  // A tab shown for the first time refreshes its index once (git update-index, in its write
  // queue): a command typed at that moment may find index.lock and has to be run again.
  await until(() => {
    try {
      linkedGit('add', '-A')
      linkedGit('commit', '-qm', 'Made in the linked worktree')
      return true
    } catch (e) {
      if (/index\.lock/.test(String(e.stderr ?? e))) return false
      throw e
    }
  }, 'committed in the linked worktree')
  await shown3(p3.locator('.graph-row', { hasText: 'Made in the linked worktree' })).waitFor({
    timeout: 15000
  })
  step("a commit in a linked worktree shows in that worktree's tab by itself")

  await p3.getByRole('tab', { name: /huge/ }).click()
  const hugeView = shown3(p3.locator('.repo-view')).first()
  await hugeView.waitFor()
  await shown3(third.section('Conflicts')).locator('li', { hasText: 'data.txt' }).click()
  const conflictView = p3.locator('.conflict-view', { hasText: 'is too large to resolve here' })
  await conflictView.waitFor({ timeout: 15000 })
  assert.equal(await conflictView.getByRole('button', { name: /Mark resolved/ }).count(), 0)
  await third.shot('f21-huge-conflict')
  await conflictView.getByRole('button', { name: 'Take all incoming' }).click()
  await third.confirmModal('Take it')
  await until(() => !/^UU/m.test(hugeGit('status', '--porcelain')), 'conflict resolved', 15000)
  assert.equal(readFileSync(join(huge, 'data.txt'), 'utf8'), hugeText('t'))
  step('a conflicted file too large to show offers whole sides only, and taking one works')

  assert.deepEqual(third.pageErrors, [])

  assert.deepEqual(pageErrors, [])
  step('no renderer errors')

  console.log(`\nAll feature checks passed. Screenshots: ${results}`)
} catch (e) {
  await shot('features-failure').catch(() => {})
  throw e
} finally {
  await app.close()
  server.close()
  rmSync(work, { recursive: true, force: true })
}
