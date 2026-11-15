// End-to-end test of the GitHub features that work without signing in
// (needs network): clone a public repository from its link, profile pictures
// in the graph, the dashboard card, and the sign-in error for a bad Client ID.
//
//   npm run test:e2e:github      (screenshots land in test-results/)

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = join(root, 'test-results')
const electronPath = createRequire(import.meta.url)('electron')

const work = mkdtempSync(join(tmpdir(), 'gitdesk-gh-'))
const userData = join(work, 'userdata')
const cloneRoot = join(work, 'repos')
mkdirSync(userData)
mkdirSync(results, { recursive: true })
writeFileSync(
  join(userData, 'gitdesk.json'),
  JSON.stringify({
    repos: [],
    openTabs: [],
    activeTab: null,
    settings: { cloneRoot, githubClientId: 'Iv1.not-a-real-client-id' }
  })
)

const env = { ...process.env, GITDESK_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ executablePath: electronPath, args: [root], env })
const page = await app.firstWindow()
const shot = (name) => page.screenshot({ path: join(results, `${name}.png`) })
const step = (name) => console.log(`  ✓ ${name}`)

try {
  await page.getByRole('button', { name: 'Clone from GitHub' }).click()
  await page.getByPlaceholder(/owner\/repo/).fill('octocat/Hello-World')
  await page.locator('.clone-target', { hasText: join('octocat', 'Hello-World') }).waitFor()
  await shot('gh-1-clone-dialog')
  await page.getByRole('button', { name: 'Clone', exact: true }).click()
  await page.getByRole('tab', { name: /Hello-World/ }).waitFor({ timeout: 60_000 })
  assert.ok(existsSync(join(cloneRoot, 'octocat', 'Hello-World', '.git')))
  step('clone from a link into <clone folder>/owner/repo, tab opens')

  await page.locator('.graph-row').first().waitFor()
  await page.locator('.graph-avatar img.avatar').first().waitFor({ timeout: 30_000 })
  await shot('gh-2-graph-avatars')
  step('author profile pictures in the graph')

  await page.getByRole('tab', { name: 'Home', exact: true }).click()
  await page.locator('.home-nav').getByRole('tab', { name: 'Projects', exact: true }).click()
  await page.locator('.card-remote', { hasText: 'github.com/octocat/Hello-World' }).waitFor()
  await shot('gh-3-dashboard')
  step('dashboard card shows the GitHub repository')

  await page.getByRole('button', { name: 'Sign in with GitHub' }).click()
  await page.getByRole('button', { name: 'Get a code' }).click()
  await page.locator('.error-text', { hasText: /Client ID/ }).waitFor({ timeout: 20_000 })
  await shot('gh-4-signin-error')
  step('sign-in with an unknown Client ID explains what to fix')
  await page.keyboard.press('Escape')

  await page.getByTitle('Settings').click()
  await page.locator('.modal', { hasText: 'OAuth App Client ID' }).waitFor()
  await shot('gh-5-settings')
  step('settings dialog')

  console.log(`\nAll checks passed. Screenshots: ${results}`)
} catch (e) {
  await shot('gh-failure').catch(() => {})
  throw e
} finally {
  await app.close()
  rmSync(work, { recursive: true, force: true })
}
