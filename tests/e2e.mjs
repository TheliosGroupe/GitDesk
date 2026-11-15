// End-to-end smoke test: builds a throwaway repository, drives the real app
// through its main flows and checks the result with git itself.
//
//   npm run test:e2e      (screenshots land in test-results/)

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitIn, launch, lines, results, step, until } from './e2e-helpers.mjs'

const work = mkdtempSync(join(tmpdir(), 'gitdesk-e2e-'))
const repo = join(work, 'sample')
const userData = join(work, 'userdata')
mkdirSync(repo)
mkdirSync(userData)

const git = gitIn(repo)

// --- fixture repository ----------------------------------------------------
git('init', '-q', '-b', 'main')
git('config', 'user.name', 'Test User')
git('config', 'user.email', 'test@example.com')
git('config', 'core.autocrlf', 'false')
writeFileSync(join(repo, 'app.js'), lines(30))
git('add', '-A')
git('commit', '-qm', 'Initial commit')
git('switch', '-qc', 'feature/x')
writeFileSync(join(repo, 'feature.js'), 'export const x = 1\n')
git('add', '-A')
git('commit', '-qm', 'Add feature x')
git('switch', '-q', 'main')
git('merge', '-q', '--no-ff', 'feature/x', '-m', "Merge branch 'feature/x'")
// A local "remote" and a second clone that pushes to it, to check Sync.
const remote = join(work, 'remote.git')
const other = join(work, 'other')
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
git('remote', 'add', 'origin', remote)
git('push', '-q', '-u', 'origin', 'main')
execFileSync('git', ['clone', '-q', remote, other])
const otherGit = (...args) => execFileSync('git', args, { cwd: other, encoding: 'utf8' })
otherGit('config', 'user.name', 'Test User')
otherGit('config', 'user.email', 'test@example.com')
otherGit('config', 'core.autocrlf', 'false')
const pushFromOther = (file) => {
  writeFileSync(join(other, file), 'from the other clone\n')
  otherGit('add', '-A')
  otherGit('commit', '-qm', `Add ${file}`)
  otherGit('push', '-q')
}
// Two separate hunks in app.js, plus an untracked file.
writeFileSync(join(repo, 'app.js'), lines(30, { 2: 'line 2 changed', 28: 'line 28 changed' }))
writeFileSync(join(repo, 'notes.txt'), 'todo\n')

writeFileSync(
  join(userData, 'gitdesk.json'),
  JSON.stringify({ repos: [repo], openTabs: [repo], activeTab: repo })
)

const {
  app,
  page,
  pageErrors,
  shot,
  modal,
  menuItem,
  sbItem,
  row,
  section,
  answerPrompt,
  confirmModal,
  goHome,
  blur
} = await launch(userData)
const read = (file) => readFileSync(join(repo, file), 'utf8')

try {
  await page.locator('.graph-row.wip').waitFor()
  step('repository opens with a WIP row')

  pushFromOther('remote1.txt')
  await page.getByRole('button', { name: 'Sync with remotes' }).click()
  await page.locator('.tool', { hasText: 'Pull ↓1' }).waitFor()
  step('sync icon in the repository view fetches the remote')

  const unstaged = section('Unstaged files')
  const staged = section('Staged files')
  await unstaged.locator('li', { hasText: 'app.js' }).click()
  await page.locator('.diff-view .hunk').nth(1).waitFor()
  assert.equal(await page.locator('.diff-view .hunk').count(), 2)
  await shot('1-diff-unified')
  step('diff shows two hunks')

  await page.locator('.hunk').first().getByRole('button', { name: 'Stage hunk' }).click()
  await staged.locator('li', { hasText: 'app.js' }).waitFor()
  assert.equal(git('status', '--porcelain', '--', 'app.js'), 'MM app.js')
  assert.match(git('diff', '--cached'), /line 2 changed/)
  assert.doesNotMatch(git('diff', '--cached'), /line 28 changed/)
  step('stage hunk stages only that hunk')

  await page.getByTitle('Split').click()
  await page.locator('.diff-lines.split').first().waitFor()
  await shot('2-diff-split')
  // Esc in another tab leaves this tab's diff alone.
  await goHome('Projects')
  await page.keyboard.press('Escape')
  await page.getByRole('tab', { name: /sample/ }).click()
  assert.equal(await page.locator('.diff-view').isVisible(), true)
  await page.keyboard.press('Escape')
  await page.locator('.graph').waitFor()
  step('split view and Esc to close (not from a hidden tab)')

  await page.getByPlaceholder('Summary').fill('Change line 2')
  await page.getByRole('button', { name: /Commit changes to 1 file/ }).click()
  await page.locator('.graph-row', { hasText: 'Change line 2' }).waitFor()
  assert.equal(git('log', '-1', '--format=%s'), 'Change line 2')
  assert.match(git('status', '--porcelain'), / M app\.js/)
  step('commit from the working copy panel')

  await page.locator('.graph-row', { hasText: "Merge branch 'feature/x'" }).click()
  await page.locator('.commit-subject', { hasText: "Merge branch 'feature/x'" }).waitFor()
  await page.locator('.side-panel li', { hasText: 'feature.js' }).waitFor()
  await shot('3-commit-details')
  step('commit details list the merged files')

  await page.locator('.graph-row', { hasText: 'Initial commit' }).click({ button: 'right' })
  await page.locator('.context-menu').waitFor()
  await shot('4-context-menu')
  await page.keyboard.press('Escape')
  step('commit context menu')

  await goHome('Projects')
  await page.locator('.card', { hasText: 'sample' }).locator('.status.warn').waitFor()
  await shot('5-dashboard')
  step('dashboard card shows uncommitted changes')

  pushFromOther('remote2.txt')
  await page.locator('.dash-header').getByRole('button', { name: 'Sync' }).click()
  await page.locator('.card', { hasText: 'sample' }).locator('.badge', { hasText: '↓2' }).waitFor()
  step('dashboard Sync fetches repositories not cloned through GitDesk')

  await goHome('Activity')
  const commitsTile = page
    .locator('.stat')
    .filter({ has: page.locator('.stat-label', { hasText: /^Commits$/ }) })
    .locator('.stat-value')
  await commitsTile.waitFor()
  // Initial commit, feature commit, merge, and the commit made earlier in this test.
  assert.equal(await commitsTile.innerText(), String(Number(git('rev-list', '--all', '--count'))))
  assert.equal(await page.locator('.data-table.people tbody tr').count(), 1)
  assert.equal(await page.locator('.viz-cell').count(), 7 * 24)
  await page.locator('.act-notice', { hasText: 'not on GitHub' }).waitFor()
  await shot('6-activity')
  step('activity dashboard counts commits, people and hours')

  // --- keyboard: tab switching and shortcuts help -----------------------------
  const tab = (name) => page.getByRole('tab', { name })
  await blur()
  const selected = async (name) => (await tab(name).getAttribute('aria-selected')) === 'true'
  await page.keyboard.press('Control+2')
  await until(() => selected(/sample/), 'Ctrl+2')
  await page.keyboard.press('Control+1')
  // Home comes back on the page shown last.
  await until(async () => (await selected('Home')) && (await selected('Activity')), 'Ctrl+1')
  await page.keyboard.press('Control+Shift+1')
  await until(() => selected('Projects'), 'Ctrl+Shift+1')
  await page.keyboard.press('Control+2')
  await until(() => selected(/sample/), 'Ctrl+2 again')
  await page.locator('.graph-row.wip').waitFor()
  step('Ctrl+1 shows Home on its last page, Ctrl+Shift+1 Projects, Ctrl+2 the first repository')

  await blur()
  await page.keyboard.press('Shift+?')
  await page.locator('.modal', { hasText: 'Keyboard shortcuts' }).waitFor()
  await page.locator('.shortcuts-help kbd', { hasText: 'F5' }).waitFor()
  await page.locator('.shortcuts-help dd', { hasText: 'Next tab' }).waitFor()
  await shot('7-shortcuts-help')
  await page.keyboard.press('Escape')
  await modal().waitFor({ state: 'detached' })
  step('? opens the keyboard shortcuts help')

  // --- theme -------------------------------------------------------------------
  await page.getByRole('button', { name: 'Settings' }).click()
  await modal().getByRole('radio', { name: /Light/ }).click()
  await until(
    () => page.evaluate(() => document.documentElement.dataset.theme === 'light'),
    'light theme'
  )
  await page.keyboard.press('Escape')
  await shot('8-light-theme')
  await page.getByRole('button', { name: 'Settings' }).click()
  await modal().getByRole('radio', { name: /Dark/ }).click()
  await until(
    () => page.evaluate(() => document.documentElement.dataset.theme === 'dark'),
    'dark theme'
  )
  await page.keyboard.press('Escape')
  await modal().waitFor({ state: 'detached' })
  step('Settings switches to the light theme and back')

  // --- commit search -----------------------------------------------------------
  const search = page.getByRole('combobox', { name: 'Search commits' })
  await blur()
  await page.keyboard.press('Control+f')
  await until(() => search.evaluate((el) => el === document.activeElement), 'search focused')
  await page.keyboard.type('feature x')
  const matchList = page.getByRole('listbox', { name: 'Matching commits' })
  await matchList.getByRole('option', { name: /Add feature x/ }).click()
  await page.locator('.commit-subject', { hasText: 'Add feature x' }).waitFor()
  await shot('9-search')
  const featureSha = git('rev-parse', 'feature/x')
  await search.fill(featureSha.slice(0, 7))
  await matchList.getByRole('option', { name: /Add feature x/ }).waitFor()
  assert.equal(await matchList.getByRole('option').count(), 1)
  await search.press('Escape') // closes the list
  await search.press('Escape') // clears the search
  assert.equal(await search.inputValue(), '')
  step('Ctrl+F searches commits by message and by 7-char SHA')

  // Back to the working copy.
  await row('// WIP').click()
  const unstagedNow = section('Unstaged files')

  // --- .gitignore from the file context menu -----------------------------------
  await unstagedNow.locator('li', { hasText: 'notes.txt' }).click({ button: 'right' })
  await menuItem('Add to .gitignore').click()
  await until(() => /^\/notes\.txt$/m.test(read('.gitignore')), '.gitignore has notes.txt')
  await unstagedNow.locator('li', { hasText: 'notes.txt' }).waitFor({ state: 'detached' })
  await unstagedNow.locator('li', { hasText: '.gitignore' }).waitFor()
  step('Add to .gitignore ignores an untracked file')

  // --- line-level staging --------------------------------------------------------
  writeFileSync(
    join(repo, 'feature.js'),
    'export const x = 1\nexport const y = 2\nexport const z = 3\n'
  )
  await unstagedNow.locator('li', { hasText: 'feature.js' }).click()
  await page.getByRole('checkbox', { name: 'Added line 2' }).click()
  await page.getByRole('button', { name: 'Stage selected lines' }).click()
  await until(
    () => /\+export const y = 2/.test(git('diff', '--cached', '--', 'feature.js')),
    'y staged'
  )
  const cached = git('diff', '--cached', '--', 'feature.js')
  assert.doesNotMatch(cached, /const z/)
  assert.equal(cached.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length, 1)
  assert.match(git('diff', '--', 'feature.js'), /\+export const z = 3/)
  await shot('10-line-staging')
  // Esc closes a context menu without closing the diff behind it.
  await unstagedNow.locator('li', { hasText: 'feature.js' }).click({ button: 'right' })
  await page.locator('.context-menu').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.context-menu').waitFor({ state: 'detached' })
  assert.equal(await page.locator('.diff-view').isVisible(), true)
  await page.keyboard.press('Escape')
  await page.locator('.diff-view').waitFor({ state: 'detached' })
  step('stage selected lines stages only that line')

  // --- commit, then undo ---------------------------------------------------------
  await page.getByPlaceholder('Summary').fill('Add y')
  await page.getByRole('button', { name: /Commit changes to 1 file/ }).click()
  await row('Add y').waitFor()
  const undoButton = page.locator('.toolbar .tool', { hasText: 'Undo' })
  await until(
    async () => /Undo commit “Add y”/.test(await undoButton.getAttribute('title')),
    'undo label'
  )
  assert.equal(await undoButton.isEnabled(), true)
  await blur()
  await page.keyboard.press('Control+z')
  await until(() => git('log', '-1', '--format=%s') === 'Change line 2', 'commit undone')
  assert.match(git('diff', '--cached', '--', 'feature.js'), /\+export const y = 2/)
  await row('Add y').waitFor({ state: 'detached' })
  await until(async () => !(await undoButton.isEnabled()), 'nothing left to undo')
  step('Ctrl+Z undoes a commit made in the UI (changes staged again)')

  // --- stash with a message ------------------------------------------------------
  await page.locator('.toolbar .tool', { hasText: 'Stash' }).click()
  await answerPrompt('my work in progress')
  await until(() => /On main: my work in progress/.test(git('stash', 'list')), 'stash listed')
  assert.equal(git('status', '--porcelain'), '?? notes.txt') // .gitignore went into the stash
  step('Stash asks for a message')

  // --- checkout by double-click, then undo it -------------------------------------
  await sbItem('feature/x').dblclick()
  await until(() => git('branch', '--show-current') === 'feature/x', 'on feature/x')
  await until(
    async () => /Undo checkout of feature\/x/.test(await undoButton.getAttribute('title')),
    'undo checkout label'
  )
  await undoButton.click()
  await until(() => git('branch', '--show-current') === 'main', 'back on main')
  step('Undo takes back a checkout')

  await page.locator('.sidebar .sb-item', { hasText: 'my work in progress' }).dblclick()
  await until(() => /M app\.js/.test(git('status', '--porcelain')), 'stash applied')
  assert.match(read('feature.js'), /const z = 3/)
  assert.match(git('stash', 'list'), /my work in progress/) // apply keeps the stash
  step('double-click on a stash applies it')

  // Keep the rest of the run on a clean working copy.
  git('add', '-A')
  git('commit', '-qm', 'Work from the stash')
  git('stash', 'drop', '-q')
  await row('Work from the stash').waitFor()

  // --- tags --------------------------------------------------------------------------
  await row('Initial commit').click({ button: 'right' })
  await menuItem('Create tag here…').click()
  await answerPrompt('v0.1')
  await until(() => git('tag') === 'v0.1', 'tag created')
  await sbItem('v0.1').click({ button: 'right' })
  await menuItem('Push tag to remote').click()
  const remoteTags = () =>
    execFileSync('git', ['ls-remote', '--tags', remote], { encoding: 'utf8' })
  await until(() => /refs\/tags\/v0\.1/.test(remoteTags()), 'tag on the remote')
  await sbItem('v0.1').click({ button: 'right' })
  await menuItem('Delete tag here and on remote…').click()
  await confirmModal('Delete')
  await until(() => git('tag') === '' && !/v0\.1/.test(remoteTags()), 'tag deleted everywhere')
  await sbItem('v0.1').waitFor({ state: 'detached' })
  step('create a tag, push it, delete it here and on the remote')

  // --- remote branch -------------------------------------------------------------------
  const remoteHeads = () =>
    execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' })
  await page.locator('.toolbar .tool', { hasText: 'Branch' }).click()
  await answerPrompt('topic')
  await until(() => git('branch', '--show-current') === 'topic', 'on topic')
  await page.locator('.toolbar .tool', { hasText: /^Push/ }).click()
  await until(() => /refs\/heads\/topic/.test(remoteHeads()), 'topic pushed')
  await sbItem('main').dblclick()
  await until(() => git('branch', '--show-current') === 'main', 'back on main')
  await sbItem('origin/topic').click({ button: 'right' })
  await menuItem('Delete on remote…').click()
  await confirmModal('Delete on remote')
  await until(() => !/refs\/heads\/topic/.test(remoteHeads()), 'topic deleted on the remote')
  await sbItem('origin/topic').waitFor({ state: 'detached' })
  step('push a branch, then delete it on the remote')

  // --- file history and blame ---------------------------------------------------------
  await row('Change line 2').click()
  await page.locator('.side-panel li', { hasText: 'app.js' }).click({ button: 'right' })
  await menuItem('File history').click()
  const historyRows = page.locator('.fh-row')
  const expected = git('log', '--follow', '--format=%s', '--', 'app.js').split('\n')
  await until(async () => (await historyRows.count()) === expected.length, 'history rows')
  assert.deepEqual(await page.locator('.fh-row .fh-subject').allInnerTexts(), expected)
  await shot('11-file-history')
  await page.getByRole('tab', { name: 'Blame' }).click()
  await page.locator('.bl-row').first().waitFor()
  assert.equal(await page.locator('.bl-row').count(), read('app.js').split('\n').length - 1)
  await page.locator('.bl-row .bl-author', { hasText: 'Test User' }).first().waitFor()
  await shot('12-blame')
  // One Esc closes the commit's diff inside the history, the next one the history.
  await page.getByRole('tab', { name: 'History', exact: true }).click()
  await page.locator('.fh-diff .diff-view').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.fh-diff .diff-view').waitFor({ state: 'detached' })
  assert.equal(await page.locator('.file-history').isVisible(), true)
  await page.keyboard.press('Escape')
  await page.locator('.file-history').waitFor({ state: 'detached' })
  step('file history lists the commits of a file, blame shows its lines')

  // --- merge conflict --------------------------------------------------------------------
  git('switch', '-qc', 'other-side')
  writeFileSync(join(repo, 'app.js'), read('app.js').replace('line 10\n', 'line 10 theirs\n'))
  git('commit', '-qam', 'Edit line 10 on other-side')
  git('switch', '-q', 'main')
  writeFileSync(join(repo, 'app.js'), read('app.js').replace('line 10\n', 'line 10 ours\n'))
  git('commit', '-qam', 'Edit line 10 on main')
  await row('Edit line 10 on main').waitFor()
  await sbItem('other-side').click({ button: 'right' })
  await menuItem('Merge other-side into main').click()
  await page.locator('.toast', { hasText: 'The merge stopped on conflicts in 1 file' }).waitFor()
  // The view switches to the working copy by itself.
  const conflicts = section('Conflicts')
  await conflicts.locator('li', { hasText: 'app.js' }).click()
  await page.locator('.conflict-block').waitFor()
  await shot('13-conflict')
  await page.getByRole('button', { name: 'Use both' }).click()
  await page.getByRole('button', { name: 'Mark resolved', exact: true }).click()
  await conflicts.waitFor({ state: 'detached' })
  await page.locator('.banner:not(.trust-banner)').getByRole('button', { name: 'Continue' }).click()
  await page.locator('.banner:not(.trust-banner)').waitFor({ state: 'detached' })
  await until(() => git('log', '-1', '--format=%P').split(' ').length === 2, 'merge commit')
  assert.match(read('app.js'), /line 10 ours\nline 10 theirs\nline 11\n/)
  assert.doesNotMatch(read('app.js'), /<<<<<<<|>>>>>>>|=======/)
  assert.equal(git('status', '--porcelain'), '')
  // The message is git's, without its "# Conflicts:" comment lines.
  assert.equal(git('log', '-1', '--format=%B'), "Merge branch 'other-side'")
  await until(
    async () => /Undo merge of other-side/.test(await undoButton.getAttribute('title')),
    'merge undoable once concluded'
  )
  step('resolve a merge conflict with "Use both", then Continue')

  // --- interactive rebase -------------------------------------------------------------------
  const base = git('rev-parse', 'HEAD')
  for (const n of [1, 2, 3]) {
    writeFileSync(join(repo, `r${n}.txt`), `${n}\n`)
    git('add', '-A', '--', `r${n}.txt`)
    git('commit', '-qm', `R${n}`)
  }
  await row('R3').waitFor()
  await row(git('log', '-1', '--format=%s', base)).click({ button: 'right' })
  await menuItem('Interactive rebase from here…').click()
  const rebaseRows = page.locator('.rebase-row')
  await until(async () => (await rebaseRows.count()) === 3, 'three commits to rebase')
  await rebaseRows.nth(1).getByLabel('Action').selectOption('reword')
  await rebaseRows.nth(1).locator('textarea').fill('R2 reworded')
  await rebaseRows.nth(2).getByLabel('Action').selectOption('squash')
  await rebaseRows.nth(2).locator('textarea').waitFor()
  await shot('14-rebase')
  await modal().getByRole('button', { name: 'Start rebase' }).click()
  await modal().waitFor({ state: 'detached' })
  await until(() => git('rev-list', '--count', `${base}..HEAD`) === '2', 'two commits left')
  assert.deepEqual(git('log', '--format=%s', `${base}..HEAD`).split('\n'), ['R2 reworded', 'R1'])
  assert.equal(git('show', '-s', '--format=%b', 'HEAD'), 'R3')
  assert.deepEqual(
    git('ls-tree', '--name-only', 'HEAD')
      .split('\n')
      .filter((f) => /^r\d/.test(f)),
    ['r1.txt', 'r2.txt', 'r3.txt']
  )
  await row('R2 reworded').waitFor()
  await until(
    async () => /Undo interactive rebase/.test(await undoButton.getAttribute('title')),
    'rebase undo label'
  )
  await undoButton.click()
  await until(() => git('log', '-1', '--format=%s') === 'R3', 'rebase undone')
  assert.equal(git('rev-list', '--count', `${base}..HEAD`), '3')
  await row('R3').waitFor()
  step('interactive rebase: reword one commit, squash another')

  // --- interactive rebase that stops on a conflict ------------------------------------------
  const base2 = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, 'app.js'), read('app.js').replace('line 5\n', 'line 5 a\n'))
  git('commit', '-qam', 'Line 5 a')
  writeFileSync(join(repo, 'app.js'), read('app.js').replace('line 5 a\n', 'line 5 b\n'))
  git('commit', '-qam', 'Line 5 b')
  await row('Line 5 b').waitFor()
  await row('R3').click({ button: 'right' })
  await menuItem('Interactive rebase from here…').click()
  await until(async () => (await rebaseRows.count()) === 2, 'two commits to rebase')
  await rebaseRows.nth(0).getByLabel('Action').selectOption('drop')
  await rebaseRows.nth(1).getByLabel('Action').selectOption('reword')
  await rebaseRows.nth(1).locator('textarea').fill('Line 5 b, reworded')
  await modal().getByRole('button', { name: 'Start rebase' }).click()
  await modal().waitFor({ state: 'detached' })
  await page.locator('.banner:not(.trust-banner)', { hasText: 'Rebase in progress' }).waitFor()
  await page.locator('.toast', { hasText: 'The rebase stopped on conflicts in 1 file' }).waitFor()
  await conflicts.locator('li', { hasText: 'app.js' }).click()
  await page.getByRole('button', { name: 'Use incoming' }).click()
  await page.getByRole('button', { name: 'Mark resolved', exact: true }).click()
  await conflicts.waitFor({ state: 'detached' })
  await page.locator('.banner:not(.trust-banner)').getByRole('button', { name: 'Continue' }).click()
  await page.locator('.banner:not(.trust-banner)').waitFor({ state: 'detached' })
  await until(() => git('rev-list', '--count', `${base2}..HEAD`) === '1', 'one commit left')
  assert.equal(git('log', '-1', '--format=%B'), 'Line 5 b, reworded')
  assert.match(read('app.js'), /\nline 5 b\nline 6\n/)
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(git('branch', '--show-current'), 'main')
  await row('Line 5 b, reworded').waitFor()
  step('interactive rebase stopped by a conflict: resolve, Continue, reword still applied')

  // --- drag a branch onto the checked-out one ---------------------------------------------------
  git('switch', '-qc', 'dnd')
  writeFileSync(join(repo, 'dnd.txt'), 'dropped\n')
  git('add', '-A')
  git('commit', '-qm', 'Add dnd.txt')
  git('switch', '-q', 'main')
  await sbItem('dnd').waitFor()
  await sbItem('dnd').dragTo(sbItem('main'))
  await menuItem('Merge dnd into main').click()
  await until(
    () => git('rev-parse', 'main') === git('rev-parse', 'dnd'),
    'dnd merged (fast-forward)'
  )
  step('drag a branch onto the checked-out branch and merge it')

  // --- interactive rebase onto a branch that moved on -------------------------------------------
  git('switch', '-qc', 'feat-rb')
  for (const n of [1, 2]) {
    writeFileSync(join(repo, `fr${n}.txt`), `${n}\n`)
    git('add', '-A')
    git('commit', '-qm', `FR${n}`)
  }
  // The same change on main too: git skips it, and so must the plan.
  const fr2 = git('rev-parse', 'HEAD')
  git('switch', '-q', 'main')
  writeFileSync(join(repo, 'main-moves.txt'), 'on\n')
  git('add', '-A')
  git('commit', '-qm', 'Main moves on')
  git('cherry-pick', fr2)
  git('switch', '-q', 'feat-rb')
  await page.locator('.sidebar .sb-item.current[title="feat-rb"]').waitFor()
  await row('Main moves on').waitFor()
  await sbItem('main').click({ button: 'right' })
  await menuItem('Interactive rebase onto main…').click()
  await until(async () => (await rebaseRows.count()) === 1, 'one commit to replay (FR2 is on main)')
  await rebaseRows.nth(0).getByLabel('Action').selectOption('reword')
  await rebaseRows.nth(0).locator('textarea').fill('FR1 reworded')
  await modal().getByRole('button', { name: 'Start rebase' }).click()
  await modal().waitFor({ state: 'detached' })
  await until(() => git('log', '-1', '--format=%s') === 'FR1 reworded', 'feat-rb rebased')
  assert.equal(git('rev-parse', 'HEAD~1'), git('rev-parse', 'main'))
  assert.equal(git('rev-list', '--merges', '--count', 'main..HEAD'), '0')
  assert.equal(git('branch', '--show-current'), 'feat-rb')
  assert.equal(git('status', '--porcelain'), '')
  git('switch', '-q', 'main')
  step('interactive rebase onto a diverged main: linear on top of it, reword applied')

  // --- file names with glob characters -------------------------------------------------------
  writeFileSync(join(repo, 'a[1].txt'), 'brackets\n')
  writeFileSync(join(repo, 'a1.txt'), 'plain\n')
  await row('// WIP').click()
  const globFile = section('Unstaged files').locator('li', { hasText: 'a[1].txt' })
  await globFile.hover()
  await globFile.getByRole('button', { name: 'Stage file' }).click()
  await until(() => git('diff', '--cached', '--name-only') === 'a[1].txt', 'a[1].txt staged')
  assert.match(git('status', '--porcelain'), /\?\? a1\.txt/)
  git('add', '-A')
  git('commit', '-qm', 'Glob names')
  step('staging a[1].txt does not stage a1.txt')

  // --- binary conflict -------------------------------------------------------------------------
  writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2]))
  git('add', '-A')
  git('commit', '-qm', 'Add logo')
  git('switch', '-qc', 'bin-side')
  writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 9, 9]))
  git('commit', '-qam', 'Logo theirs')
  git('switch', '-q', 'main')
  writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 5, 5]))
  git('commit', '-qam', 'Logo ours')
  await row('Logo ours').waitFor()
  await sbItem('bin-side').click({ button: 'right' })
  await menuItem('Merge bin-side into main').click()
  await page.locator('.toast', { hasText: 'The merge stopped on conflicts in 1 file' }).waitFor()
  await conflicts.locator('li', { hasText: 'logo.bin' }).click()
  await page.locator('.conflict-view', { hasText: 'is a binary file' }).waitFor()
  const conflictView = page.locator('.conflict-view')
  assert.equal(await conflictView.getByRole('button', { name: /Mark resolved/ }).count(), 0)
  assert.equal(await conflictView.getByRole('button', { name: /Open in editor/ }).count(), 0)
  await shot('15-binary-conflict')
  await conflictView.getByRole('button', { name: 'Take all incoming' }).click()
  await confirmModal('Take it')
  await conflicts.waitFor({ state: 'detached' })
  await page.locator('.banner:not(.trust-banner)').getByRole('button', { name: 'Continue' }).click()
  await page.locator('.banner:not(.trust-banner)').waitFor({ state: 'detached' })
  assert.deepEqual([...readFileSync(join(repo, 'logo.bin'))], [0, 9, 9])
  assert.equal(git('status', '--porcelain'), '')
  step('binary conflict: no line view, take a whole side')

  // --- panel resizer ---------------------------------------------------------------------------
  const sidebarWidth = () =>
    page.locator('.sidebar').evaluate((el) => Math.round(el.getBoundingClientRect().width))
  const before = await sidebarWidth()
  const box = await page.getByRole('separator', { name: 'Resize the sidebar' }).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  assert.equal(await sidebarWidth(), before + 80)
  await page.getByRole('separator', { name: 'Resize the sidebar' }).dblclick()
  await until(async () => (await sidebarWidth()) === before, 'sidebar width reset')
  step('drag the sidebar splitter, double-click resets it')

  assert.deepEqual(pageErrors, [])
  step('no renderer errors')

  console.log(`\nAll checks passed. Screenshots: ${results}`)
} catch (e) {
  await shot('failure').catch(() => {})
  throw e
} finally {
  await app.close()
  rmSync(work, { recursive: true, force: true })
}
