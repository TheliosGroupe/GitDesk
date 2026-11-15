// End-to-end test of the repository view's layout: graph columns (resize, fit, hide, persisted
// across a relaunch), the collapsible sidebar and details panel, the working copy sections,
// focus mode, the maximized terminal and a narrow window. Screenshots land in test-results/.
//
//   npm run test:e2e

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitIn, launch, lines, results, step, until } from './e2e-helpers.mjs'

const work = mkdtempSync(join(tmpdir(), 'gitdesk-e2e-layout-'))
const repo = join(work, 'layout')
const userData = join(work, 'userdata')
mkdirSync(repo)
mkdirSync(userData)
const git = gitIn(repo)

// --- fixture repository: two lanes, a long branch name, a tag, a stash, a busy working copy ---
git('init', '-q', '-b', 'main')
git('config', 'user.name', 'Layout Tester')
git('config', 'user.email', 'layout@example.com')
git('config', 'core.autocrlf', 'false')
writeFileSync(join(repo, 'app.js'), lines(20))
git('add', '-A')
git('commit', '-qm', 'Initial commit')
git('tag', 'v1.0')
git('switch', '-qc', 'feature/a-rather-long-branch-name-to-fit')
writeFileSync(join(repo, 'feature.js'), 'export const feature = 1\n')
git('add', '-A')
git('commit', '-qm', 'Feature work')
git('switch', '-q', 'main')
writeFileSync(join(repo, 'main.js'), 'export const main = 1\n')
git('add', '-A')
git('commit', '-qm', 'Main work')
git('merge', '-q', '--no-ff', 'feature/a-rather-long-branch-name-to-fit', '-m', 'Merge feature')
git('switch', '-qc', 'topic')
writeFileSync(join(repo, 'topic.js'), 'export const topic = 1\n')
git('add', '-A')
git('commit', '-qm', 'Topic work')
git('switch', '-q', 'main')
writeFileSync(join(repo, 'app.js'), lines(20, { 3: 'stashed' }))
git('stash', 'push', '-qm', 'Saved for later')
writeFileSync(join(repo, 'app.js'), lines(20, { 5: 'line 5 changed' }))
for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) writeFileSync(join(repo, `${n}.txt`), `${n}\n`)
writeFileSync(join(repo, 'staged.txt'), 'staged\n')
git('add', 'staged.txt')

writeFileSync(
  join(userData, 'gitdesk.json'),
  JSON.stringify({ repos: [repo], openTabs: [repo], activeTab: repo })
)

const widthOf = (locator) => locator.evaluate((el) => Math.round(el.getBoundingClientRect().width))
const heightOf = (locator) =>
  locator.evaluate((el) => Math.round(el.getBoundingClientRect().height))

let session = await launch(userData)
const allErrors = []
const keepErrors = (s) => allErrors.push(...s.pageErrors)

/** Drags the middle of `locator` by (dx, dy). */
const drag = async (page, locator, dx, dy = 0) => {
  const box = await locator.boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 5 })
  await page.mouse.up()
}

try {
  let { page, shot, blur, section } = session
  const th = (col) => page.locator(`.graph-th[data-col="${col}"]`)
  const resizer = (label) => page.getByRole('separator', { name: `Resize the ${label} column` })
  const openColumnMenu = async () => {
    await page.locator('.graph-header').click({ button: 'right' })
    await page.locator('.col-menu').waitFor()
  }
  const columnItem = (name) =>
    page.locator('.col-menu').getByRole('menuitemcheckbox', { name: new RegExp(`^${name}`) })

  await page.locator('.graph-row.wip').waitFor()
  await page.locator('.graph-row', { hasText: 'Topic work' }).waitFor()
  await shot('l01-default-dark')
  step('repository opens with the default layout')

  // --- graph columns ----------------------------------------------------------------------------
  // In focus mode (no side panels): in a window the size of a CI runner's screen the graph is
  // otherwise too narrow for every column, and they step aside (see "narrow window" below).
  // The mode is kept across the relaunch, and left before the sidebar steps.
  await page.getByRole('button', { name: 'Focus mode' }).click()
  await page.locator('.repo-view.sidebar-hidden.right-hidden').waitFor()
  await th('sha').waitFor()
  await openColumnMenu()
  assert.equal(await columnItem('Commit message').isDisabled(), true)
  assert.equal(await columnItem('SHA').getAttribute('aria-checked'), 'true')
  await columnItem('SHA').click()
  await columnItem('Date').click()
  // The menu stays open while toggling, so several columns can be changed at once.
  assert.equal(await columnItem('SHA').getAttribute('aria-checked'), 'false')
  await page.keyboard.press('Escape')
  await page.locator('.col-menu').waitFor({ state: 'detached' })
  assert.equal(await th('sha').count(), 0)
  assert.equal(await page.locator('.graph-row .cell.sha').count(), 0)
  assert.equal(await page.locator('.graph-row .cell.date').count(), 0)
  await openColumnMenu()
  await columnItem('Date').click()
  await page.keyboard.press('Escape')
  await th('date').waitFor()
  await shot('l02-columns-dark')
  step('right-click the header: hide and show columns (Commit message always shown)')

  const authorBefore = await widthOf(th('author'))
  assert.equal(authorBefore, 140)
  await drag(page, resizer('Author'), 60)
  assert.equal(await widthOf(th('author')), authorBefore + 60)
  assert.equal(
    await widthOf(page.locator('.graph-row', { hasText: 'Main work' }).locator('.cell.author')),
    authorBefore + 60
  )
  step('drag the Author header border: the header and the rows widen together')

  const graphBefore = await widthOf(th('graph'))
  await drag(page, resizer('Graph'), 50)
  assert.equal(await widthOf(th('graph')), graphBefore + 50)
  await drag(page, resizer('Graph'), -(graphBefore + 50 - 30))
  assert.equal(await widthOf(th('graph')), 30)
  await page.locator('.graph.lanes-clipped').waitFor()
  await resizer('Graph').dblclick()
  await until(async () => (await widthOf(th('graph'))) === graphBefore, 'graph width back to lanes')
  assert.equal(await page.locator('.graph.lanes-clipped').count(), 0)
  step('the graph column widens, narrows (clipped lanes fade) and double-click fits its lanes')

  const longName = page
    .locator('.graph-row', { hasText: 'Feature work' })
    .locator('.ref-name', { hasText: 'feature/a-rather' })
  const truncated = () => longName.evaluate((el) => el.scrollWidth > el.clientWidth)
  assert.equal(await truncated(), true)
  await resizer('Branch / Tag').dblclick()
  await until(async () => !(await truncated()), 'branch label fully shown after auto-fit')
  assert.ok((await widthOf(th('refs'))) > 160)
  step('double-click the Branch / Tag border fits the column to the labels on screen')

  const msgBefore = await widthOf(th('msg'))
  await drag(page, resizer('Commit message'), -80)
  assert.equal(await widthOf(th('msg')), Math.max(120, msgBefore - 80)) // 120px at least
  await resizer('Commit message').dblclick()
  await until(async () => (await widthOf(th('msg'))) === msgBefore, 'message fills again')
  step('the message column can be sized, double-click makes it fill the space again')

  // Keyboard: arrows on a focused border.
  await resizer('Author').focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await widthOf(th('author')), authorBefore + 68)
  await page.keyboard.press('ArrowLeft')
  assert.equal(await widthOf(th('author')), authorBefore + 60)
  step('column borders are keyboard resizable')
  await shot('l02-columns-dark')

  // --- relaunch: the columns are kept --------------------------------------------------------------
  keepErrors(session)
  await session.app.close()
  // Light theme for the second half (screenshots of both themes).
  const saved = JSON.parse(readFileSync(join(userData, 'gitdesk.json'), 'utf8'))
  writeFileSync(
    join(userData, 'gitdesk.json'),
    JSON.stringify({ ...saved, settings: { ...saved.settings, theme: 'light' } })
  )
  session = await launch(userData)
  ;({ page, shot, blur, section } = session)
  await page.locator('.graph-row.wip').waitFor()
  await page.locator('.repo-view.sidebar-hidden.right-hidden').waitFor() // focus mode kept
  assert.equal(await widthOf(th('author')), authorBefore + 60)
  assert.equal(await th('sha').count(), 0)
  await shot('l03-columns-light')
  await openColumnMenu()
  await page.locator('.col-menu').getByRole('menuitem', { name: 'Reset columns' }).click()
  await th('sha').waitFor()
  assert.equal(await widthOf(th('author')), authorBefore)
  assert.equal(await widthOf(th('refs')), 160)
  step('column widths and hidden columns survive a relaunch; "Reset columns" restores them')
  await page.getByRole('button', { name: 'Focus mode' }).click()
  await page.locator('.repo-view.sidebar-open.right-open').waitFor()

  // --- sidebar ------------------------------------------------------------------------------------
  const sidebar = page.locator('.sidebar')
  const sidebarWidth = await widthOf(sidebar)
  const stashesTitle = page.locator('.sidebar .sb-section-title', { hasText: 'Stashes' })
  await stashesTitle.click()
  assert.equal(await stashesTitle.getAttribute('aria-expanded'), 'false')
  await blur()
  await page.keyboard.press('Control+Shift+B')
  await page.locator('.sidebar.is-rail').waitFor()
  assert.equal(await widthOf(sidebar), 40)
  assert.equal(await page.getByRole('separator', { name: 'Resize the sidebar' }).count(), 0)
  await shot('l04-sidebar-rail-light')
  // A section closed by hand is opened when its rail icon is clicked.
  await page.locator('.sb-rail').getByRole('button', { name: 'Stashes' }).click()
  await page.locator('.sidebar:not(.is-rail)').waitFor()
  assert.equal(await widthOf(sidebar), sidebarWidth)
  await page.locator('.sidebar .sb-item', { hasText: 'Saved for later' }).waitFor()
  step('Ctrl+Shift+B collapses the sidebar to an icon rail; a rail icon expands it at that section')

  await page.getByRole('button', { name: 'Collapse all sections' }).click()
  assert.equal(await page.locator('.sidebar .sb-items').count(), 0)
  await page.getByRole('button', { name: 'Expand all sections' }).click()
  await page.locator('.sidebar .sb-item[title="topic"]').waitFor()
  await page.getByRole('button', { name: 'Collapse the sidebar' }).click()
  await page.locator('.sidebar.is-rail').waitFor()
  await page.locator('.sb-rail').getByRole('button', { name: 'Expand the sidebar' }).click()
  await page.locator('.sidebar:not(.is-rail)').waitFor()
  step('collapse / expand all sidebar sections; collapse and expand buttons')

  // --- details panel --------------------------------------------------------------------------------
  const right = page.locator('aside.right')
  const rightWidth = await widthOf(right)
  const detailsButton = page.getByRole('button', { name: 'Show the details panel' })
  assert.equal(await detailsButton.getAttribute('aria-pressed'), 'true')
  await detailsButton.click()
  await page.locator('.details-rail').waitFor()
  assert.equal(await widthOf(right), 40)
  assert.equal(await detailsButton.getAttribute('aria-pressed'), 'false')
  await shot('l05-right-rail-light')
  await page.getByRole('button', { name: 'Expand the details panel' }).click()
  await page.locator('.details-rail').waitFor({ state: 'detached' })
  assert.equal(await widthOf(right), rightWidth)
  await blur()
  await page.keyboard.press('Control+Shift+J')
  await page.locator('.details-rail').waitFor()
  await page.keyboard.press('Control+Shift+J')
  await page.locator('.details-rail').waitFor({ state: 'detached' })
  step('the details panel collapses to a rail (toolbar button, Ctrl+Shift+J) and expands back')

  // --- working copy sections ------------------------------------------------------------------------
  const unstaged = section('Unstaged files')
  const staged = section('Staged files')
  const toggle = (s) => s.locator('.section-toggle')
  await unstaged.locator('li', { hasText: 'a.txt' }).waitFor()
  await toggle(unstaged).click()
  assert.equal(await toggle(unstaged).getAttribute('aria-expanded'), 'false')
  assert.equal(await unstaged.locator('li').count(), 0)
  await toggle(unstaged).click()
  await unstaged.locator('li', { hasText: 'a.txt' }).waitFor()
  step('click a working copy section title to collapse or expand it')

  const unstagedHeight = await heightOf(unstaged)
  await drag(
    page,
    page.getByRole('separator', { name: 'Resize the unstaged and staged file lists' }),
    0,
    60
  )
  assert.ok(Math.abs((await heightOf(unstaged)) - (unstagedHeight + 60)) <= 2)
  const commitBox = page.locator('.commit-box')
  const commitHeight = await heightOf(commitBox)
  await drag(page, page.getByRole('separator', { name: 'Resize the commit box' }), 0, -50)
  assert.ok(Math.abs((await heightOf(commitBox)) - (commitHeight + 50)) <= 2)
  step('splitters between the unstaged list, the staged list and the commit box')

  await unstaged.getByRole('button', { name: 'Maximize the unstaged files list' }).click()
  assert.equal(await staged.locator('li').count(), 0)
  await page.locator('.commit-box.collapsed').waitFor()
  await shot('l06-unstaged-maximized-light')
  await unstaged.getByRole('button', { name: 'Restore the unstaged files list' }).click()
  await staged.locator('li', { hasText: 'staged.txt' }).waitFor()
  await page.locator('.commit-box:not(.collapsed)').waitFor()
  step('maximize the unstaged list (the other sections fold), then restore')

  await page.getByPlaceholder('Description (optional)').fill('Why it is staged\nMore details')
  await toggle(page.locator('.commit-box')).click()
  await page.locator('.commit-box.collapsed').waitFor()
  assert.equal(await page.locator('.commit-box textarea').count(), 0)
  // The hidden description is still committed: the collapsed row says so.
  const descHint = page.locator('.commit-box .desc-indicator')
  assert.equal(await descHint.getAttribute('title'), 'Why it is staged')
  await page.getByPlaceholder('Summary').fill('Add staged.txt')
  await page.getByRole('button', { name: 'Commit changes to 1 file' }).click()
  await until(() => git('log', '-1', '--format=%s') === 'Add staged.txt', 'commit')
  assert.equal(git('log', '-1', '--format=%b'), 'Why it is staged\nMore details')
  await descHint.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Expand the commit box' }).click()
  await page.locator('.commit-box textarea').waitFor()
  step('the commit box collapses to its summary line (+ description shown) and still commits')

  // --- focus mode -----------------------------------------------------------------------------------
  await page.keyboard.press('Control+Shift+B') // sidebar collapsed before focus mode
  await page.locator('.sidebar.is-rail').waitFor()
  await blur()
  await page.keyboard.press('Control+Shift+F')
  await page.locator('.repo-view.sidebar-hidden.right-hidden').waitFor()
  const view = page.locator('.repo-view')
  assert.equal(await widthOf(page.locator('.center-column')), await widthOf(view))
  assert.equal(await sidebar.isVisible(), false)
  assert.equal(await right.isVisible(), false)
  await shot('l07-focus-light')
  await page.getByRole('button', { name: 'Focus mode' }).click()
  await page.locator('.sidebar.is-rail').waitFor()
  await page.locator('.details-rail').waitFor({ state: 'detached' })
  assert.equal(await right.isVisible(), true)
  step('focus mode hides both panels; leaving it restores the previous state (rail + panel)')

  await page.keyboard.press('Control+Shift+F')
  await page.locator('.repo-view.right-hidden').waitFor()
  await page.getByRole('button', { name: 'Show the sidebar' }).click()
  await page.locator('.repo-view.sidebar-open.right-rail').waitFor()
  await page.getByRole('button', { name: 'Expand the details panel' }).click()
  await page.locator('.repo-view.sidebar-open.right-open').waitFor()
  step('showing a panel in focus mode leaves it with the other panel collapsed')

  // --- terminal -----------------------------------------------------------------------------------
  await blur()
  await page.keyboard.press('Control+Backquote')
  const dock = page.locator('.terminal-dock')
  await dock.locator('.xterm').waitFor({ timeout: 20000 })
  const dockHeight = await heightOf(dock)
  await page.getByRole('button', { name: 'Maximize the terminal' }).click()
  await page.locator('.center-column.terminal-maximized').waitFor()
  assert.equal(await page.locator('.center-column > .center').isVisible(), false)
  assert.ok(
    Math.abs((await heightOf(dock)) - (await heightOf(page.locator('.center-column')))) <= 1
  )
  await shot('l08-terminal-maximized-light')
  await page.getByRole('button', { name: 'Restore the terminal' }).click()
  await page.locator('.center-column:not(.terminal-maximized)').waitFor()
  assert.equal(await heightOf(dock), dockHeight)
  assert.equal(await page.locator('.center-column > .center').isVisible(), true)
  await page.keyboard.press('Control+Backquote')
  await dock.waitFor({ state: 'hidden' })
  step('the terminal maximizes over the center column and restores its height')

  // --- branch colors -------------------------------------------------------------------------------
  const featureName = 'feature/a-rather-long-branch-name-to-fit'
  const featureRow = page.locator('.graph-row', { hasText: 'Feature work' })
  const featurePill = featureRow.locator('.ref', { hasText: 'feature/a-rather' })
  const featureIcon = page.locator(`.sidebar .sb-item[title="${featureName}"] svg`)
  const wipNode = page.locator('.graph-row.wip circle')
  const borderOf = (locator) => locator.evaluate((el) => getComputedStyle(el).borderTopColor)
  const strokes = (locator) =>
    locator.locator('svg path').evaluateAll((paths) => paths.map((p) => p.getAttribute('stroke')))
  const rootLane0 = () =>
    page.evaluate(() => document.documentElement.style.getPropertyValue('--lane-0'))
  const settingsModal = page.locator('.modal')
  const openAppearance = async () => {
    await blur()
    await page.keyboard.press('Control+Comma')
    await settingsModal.locator('.settings-nav-item', { hasText: /^Appearance$/ }).click()
  }
  const closeSettings = async () => {
    await settingsModal.getByRole('button', { name: 'Done' }).click()
    await settingsModal.waitFor({ state: 'detached' })
  }
  const defaultPill = await borderOf(featurePill)
  await openAppearance()
  await settingsModal.getByRole('button', { name: 'Add rule' }).click()
  await settingsModal.getByLabel('Rule 1 branch pattern').fill('feature/*')
  await settingsModal.getByLabel('Rule 1 color, hex').fill('#e0115f')
  await settingsModal.getByRole('button', { name: 'Add common rules' }).click()
  assert.equal(await settingsModal.locator('.branch-rule').count(), 7) // feature/* is there
  // Reorder with the buttons: "main" (rule 2) goes first, then back.
  await settingsModal.getByRole('button', { name: 'Move rule 2 up' }).click()
  assert.equal(await settingsModal.getByLabel('Rule 1 branch pattern').inputValue(), 'main')
  await settingsModal.getByRole('button', { name: 'Move rule 1 down' }).click()
  assert.equal(await settingsModal.getByLabel('Rule 1 branch pattern').inputValue(), 'feature/*')
  // A faint lane color gets a contrast warning.
  const lane2 = settingsModal.getByLabel('Lane 2 color, light theme, hex')
  await lane2.fill('#fafafa')
  await settingsModal.getByText(/Lane 2 has less than 3:1 contrast/).waitFor()
  await lane2.fill('#c4501a')
  await settingsModal.getByLabel('Lane 1 color, light theme, hex').fill('#123456')
  await settingsModal.locator('.branch-rules').scrollIntoViewIfNeeded()
  await shot('l10-branch-colors-settings-light')
  await closeSettings()
  const ruleRgb = 'rgb(224, 17, 95)'
  await until(async () => (await borderOf(featurePill)) === ruleRgb, 'feature pill in rule color')
  assert.ok((await strokes(featureRow)).includes('#e0115f'), 'feature lane in the rule color')
  assert.equal(await featureRow.evaluate((el) => el.style.getPropertyValue('--lane')), '#e0115f')
  assert.equal(await featureIcon.getAttribute('stroke'), '#e0115f')
  // The palette edit: --lane-0 on <html>, used by the first palette lane (the WIP row).
  assert.equal(await rootLane0(), '#123456')
  assert.equal(await wipNode.getAttribute('stroke'), 'var(--lane-0)')
  assert.equal(await wipNode.evaluate((el) => getComputedStyle(el).stroke), 'rgb(18, 52, 86)')
  await shot('l11-branch-colors-light')
  step('a feature/* rule colors its lane, label and sidebar icon; palette edits apply live')

  await openAppearance()
  await settingsModal.getByRole('radio', { name: /Dark/ }).click()
  await closeSettings()
  await until(
    () => page.evaluate(() => document.documentElement.dataset.theme === 'dark'),
    'dark theme'
  )
  // The dark theme keeps its own (default) palette; the rule color carries over.
  await until(async () => (await rootLane0()) === '', 'dark palette is the default one')
  await until(async () => (await borderOf(featurePill)) === ruleRgb, 'rule color in dark theme')
  await shot('l12-branch-colors-dark')
  await openAppearance()
  await settingsModal.getByRole('button', { name: 'Light theme', exact: true }).click()
  await settingsModal.getByRole('button', { name: 'Reset to defaults' }).click()
  await settingsModal.getByRole('button', { name: 'Remove all' }).click()
  await settingsModal.getByRole('radio', { name: /Light/ }).click()
  await closeSettings()
  await until(async () => (await borderOf(featurePill)) === defaultPill, 'default pill color')
  assert.equal(await rootLane0(), '')
  assert.equal(await featureIcon.getAttribute('stroke'), 'currentColor')
  await until(
    () =>
      JSON.stringify(
        JSON.parse(readFileSync(join(userData, 'gitdesk.json'), 'utf8')).settings.branchColors
      ) === JSON.stringify({ dark: [], light: [], rules: [] }),
    'branch colors saved as defaults'
  )
  step('the dark theme has its own palette; "Reset to defaults" and "Remove all" restore them')

  // --- narrow window ----------------------------------------------------------------------------------
  await session.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.unmaximize()
    w.setSize(1000, 720)
  })
  await until(() => page.evaluate(() => window.innerWidth <= 1000), 'narrow window')
  const overflow = await page.evaluate(() => {
    const view = [...document.querySelectorAll('.repo-view')].find((v) => v.offsetParent)
    const toolbar = view.querySelector('.toolbar')
    const out = [...toolbar.querySelectorAll('button')].filter((b) => {
      const r = b.getBoundingClientRect()
      return r.width > 0 && (r.right > window.innerWidth || r.left < 0)
    })
    // The three toolbar groups side by side, without overlapping.
    const [repo, actions, right] = ['.toolbar-repo', '.toolbar-actions', '.toolbar-right'].map(
      (sel) => toolbar.querySelector(sel).getBoundingClientRect()
    )
    const groups = [...toolbar.querySelector('.toolbar-right').children].map((el) =>
      el.getBoundingClientRect()
    )
    const scroll = view.querySelector('.graph-scroll')
    return {
      view: view.scrollWidth - view.clientWidth,
      toolbar: toolbar.scrollWidth - toolbar.clientWidth,
      buttonsOutside: out.length,
      overlap:
        repo.right > actions.left + 1 ||
        actions.right > right.left + 1 ||
        groups.some((r, i) => i > 0 && r.left < groups[i - 1].right - 1),
      graphSideways: scroll.scrollWidth - scroll.clientWidth,
      center: view.querySelector('.center-column').getBoundingClientRect().width
    }
  })
  assert.deepEqual(
    { ...overflow, center: overflow.center >= 300 },
    { view: 0, toolbar: 0, buttonsOutside: 0, overlap: false, graphSideways: 0, center: true }
  )
  // Columns step aside (SHA first) instead of squeezing everything; the menu says why.
  assert.equal(await th('sha').count(), 0)
  await openColumnMenu()
  await columnItem('SHA').locator('.menu-hint', { hasText: 'narrow view' }).waitFor()
  await page.keyboard.press('Escape')
  await shot('l09-narrow-light')
  step('a 1000px window: no overflow, the toolbar fits, the graph keeps room')

  keepErrors(session)
  assert.deepEqual(allErrors, [])
  step('no renderer errors')
  console.log(`\nAll layout checks passed. Screenshots: ${results}`)
} catch (e) {
  await session.shot('l-failure').catch(() => {})
  throw e
} finally {
  await session.app.close().catch(() => {})
  rmSync(work, { recursive: true, force: true })
}
