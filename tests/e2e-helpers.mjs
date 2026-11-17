// Shared by the end-to-end tests (tests/e2e.mjs, tests/e2e-features.mjs): starts the built
// app on its own settings folder and gives the small helpers the steps are written with.

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const results = join(root, 'test-results')
mkdirSync(results, { recursive: true })
const electronPath = createRequire(import.meta.url)('electron')

/** git in `cwd`; only trailing whitespace is trimmed (`status --porcelain` starts with a space). */
export const gitIn =
  (cwd) =>
  (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).replace(/\s+$/, '')

/** A file of `n` lines "line 1"…, with some lines replaced: lines(30, { 2: 'changed' }). */
export const lines = (n, edit = {}) =>
  Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

export const step = (name) => console.log(`  ✓ ${name}`)

/** Polls `check` (sync or async) until it returns true. */
export const until = async (check, what, timeout = 8000) => {
  const end = Date.now() + timeout
  for (;;) {
    try {
      if (await check()) return
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/**
 * Fills a text field and waits until it holds `value`, typing it again if it does not: on CI,
 * a fill once left a color's hex field empty, so the change it should have made never came.
 */
export const fillField = (field, value) =>
  until(async () => {
    if ((await field.inputValue()) !== value) await field.fill(value)
    return (await field.inputValue()) === value
  }, `"${value}" in the field`)

/**
 * Starts the app with GITDESK_USER_DATA = `userData` (plus `env`). Any uncaught renderer
 * error, or console.error, lands in `pageErrors` (the tests fail on them at the end).
 */
export async function launch(userData, env = {}) {
  // VS Code's terminal sets ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
  const fullEnv = { ...process.env, GITDESK_USER_DATA: userData, ...env }
  delete fullEnv.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: electronPath, args: [root], env: fullEnv })
  const page = await app.firstWindow()
  // The screen of a CI runner (1024 × 768): a local run lays the app out as CI does, and a
  // control pushed out of reach by a narrow window fails here too.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 768))
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`)
  })
  return { app, page, pageErrors, ...helpers(page) }
}

function helpers(page) {
  const modal = () => page.locator('.modal')
  return {
    shot: (name) => page.screenshot({ path: join(results, `${name}.png`) }),
    modal,
    menuItem: (name) => page.locator('.context-menu [role=menuitem]', { hasText: name }).first(),
    sbItem: (name) => page.locator(`.sidebar .sb-item[title="${name}"]`),
    row: (subject) => page.locator('.graph-row', { hasText: subject }).first(),
    toast: (text) => page.locator('.toast', { hasText: text }).first(),
    // hasText is a case-insensitive substring match ("Staged" is inside "Unstaged"), so anchor it.
    section: (title) =>
      page
        .locator('section')
        .filter({ has: page.locator('.section-title', { hasText: new RegExp(`^${title}`) }) }),
    answerPrompt: async (value) => {
      await modal().locator('input.input').fill(value)
      await modal().locator('input.input').press('Enter')
      await modal().waitFor({ state: 'detached' })
    },
    confirmModal: async (label) => {
      await modal().getByRole('button', { name: label, exact: true }).click()
      await modal().waitFor({ state: 'detached' })
    },
    /** Shows the Home tab, on one of its pages ('Projects', 'Launchpad', 'Agents', 'Activity'). */
    goHome: async (pageName) => {
      await page.getByRole('tab', { name: 'Home', exact: true }).click()
      if (pageName)
        await page.locator('.home-nav').getByRole('tab', { name: pageName, exact: true }).click()
    },
    /** Names of the repository tabs, in strip order. */
    repoTabs: () =>
      page.locator('.tabbar-tabs [role=tab]').evaluateAll((tabs) => tabs.map((t) => t.innerText)),
    /** Takes keyboard focus away from text fields, so repository shortcuts apply. */
    blur: () => page.evaluate(() => document.activeElement?.blur())
  }
}
