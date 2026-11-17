// Records one take of the demo: rebuilds the demo repositories, starts the built app on its
// own settings folder, drives it like a person (a visible pointer, typed text) while two
// Claude Code agents work, and saves every rendered frame plus scene markers in TAKE.
// See README.md in this folder.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { DEMO_ROOT, TAKE, WORK } from './config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')
const REPO = join(DEMO_ROOT, 'web-app')
const FRAMES = join(TAKE, 'frames')
const USERDATA = join(WORK, 'userdata')
const electronPath = createRequire(import.meta.url)('electron')
if (!existsSync(join(APP, 'out', 'main')))
  throw new Error('Build the app first: npx electron-vite build')

const TASKS = [
  {
    text: 'Validate the email in the signup form and show an error under the field. Commit when done.',
    branch: 'agent/email-validation',
    file: 'signup.ts'
  },
  {
    text: 'Show when the dashboard data was last updated, in the dashboard header. Commit when done.',
    branch: 'agent/last-updated',
    file: 'dashboard.ts'
  }
]

// DRY=1: a stand-in agent instead of Claude Code, to check the script without using tokens.
const DRY = process.env.DRY === '1'
execFileSync(process.execPath, [join(HERE, 'seed.mjs')], { stdio: 'inherit' })
if (DRY) {
  const stateFile = join(USERDATA, 'gitdesk.json')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  state.settings.agentCommands = { custom: `node "${join(HERE, 'fake-agent.mjs')}"` }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
}
rmSync(TAKE, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })

// The line numbers of the save-button change in the work in progress (for line staging).
const diff = execFileSync('git', ['diff', '-U0', '--', 'src/pages/settings.ts'], {
  cwd: REPO,
  encoding: 'utf8'
})
let oldLine = 0
let newLine = 0
let removedButton = 0
let addedButton = 0
for (const l of diff.split('\n')) {
  const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)
  if (h) {
    oldLine = Number(h[1])
    newLine = Number(h[2])
  } else if (l.startsWith('-') && !l.startsWith('---')) {
    if (l.includes('>Save</button>')) removedButton = oldLine
    oldLine++
  } else if (l.startsWith('+') && !l.startsWith('+++')) {
    if (l.includes('>Save changes</button>')) addedButton = newLine
    newLine++
  }
}
if (!removedButton || !addedButton) throw new Error('save-button lines not found in the diff')

// Same environment as a person's, minus the variables of a Claude Code session this script
// may run from (the agents would take them for their own session).
const env = { ...process.env, GITDESK_USER_DATA: USERDATA }
for (const k of Object.keys(env))
  if (/^CLAUDE(CODE|_CODE_|_PID|_AGENT|_EFFORT)/.test(k)) delete env[k]
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: electronPath,
  args: [
    APP,
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows'
  ],
  env
})
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setPosition(120, 40)
  w.setContentSize(1440, 900)
  w.webContents.setBackgroundThrottling(false)
})
const wait = (ms) => page.waitForTimeout(ms)
const markers = []
const mark = (name) => {
  markers.push({ name, t: Date.now() / 1000 })
  console.log(`  [${markers.length}] ${name}`)
}

// --- pointer drawn in the page (screen recordings of a page show no system cursor) -----------
await page.locator('.dash-header').waitFor({ timeout: 30000 })
await page.evaluate(() => {
  const el = document.createElement('div')
  el.innerHTML =
    '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M5 3 L5 22 L10 17.2 L13.4 24.6 L16.5 23.3 L13.2 16 L20 16 Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>'
  el.style.cssText =
    'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))'
  document.body.appendChild(el)
  const cur = { x: 760, y: 470 }
  const place = () => (el.style.transform = `translate(${cur.x - 5}px, ${cur.y - 3}px)`)
  place()
  window.__setCursor = (x, y) => {
    cur.x = x
    cur.y = y
    place()
  }
  window.__moveCursor = (tx, ty, ms) =>
    new Promise((done) => {
      const sx = cur.x
      const sy = cur.y
      const t0 = performance.now()
      const step = (t) => {
        const k = Math.min(1, (t - t0) / ms)
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
        cur.x = sx + (tx - sx) * e
        cur.y = sy + (ty - sy) * e
        place()
        if (k < 1) requestAnimationFrame(step)
        else done()
      }
      requestAnimationFrame(step)
    })
  window.__ripple = () => {
    const r = document.createElement('div')
    r.style.cssText = `position:fixed;left:${cur.x - 18}px;top:${cur.y - 18}px;width:36px;height:36px;border-radius:50%;
      background:rgba(88,166,255,.35);border:2px solid rgba(88,166,255,.9);z-index:2147483646;pointer-events:none;
      transform:scale(.3);opacity:1;transition:transform .45s ease-out,opacity .45s ease-out`
    document.body.appendChild(r)
    requestAnimationFrame(() => {
      r.style.transform = 'scale(1.4)'
      r.style.opacity = '0'
    })
    setTimeout(() => r.remove(), 600)
  }
  // Terminal output by terminal id, to answer Claude Code's prompts.
  window.__term = {}
  window.api.on('terminal:data', (e) => {
    window.__term[e.id] = ((window.__term[e.id] || '') + e.data).slice(-30000)
  })
})

const center = async (loc) => {
  await loc.waitFor({ state: 'visible', timeout: 20000 })
  await loc.scrollIntoViewIfNeeded()
  const b = await loc.boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
const moveTo = async (loc, ms = 650) => {
  const p = await center(loc)
  await page.evaluate(([x, y, ms]) => window.__moveCursor(x, y, ms), [p.x, p.y, ms])
  await page.mouse.move(p.x, p.y)
  return p
}
const click = async (loc, ms) => {
  await moveTo(loc, ms)
  await wait(140)
  await page.evaluate(() => window.__ripple())
  await loc.click()
  await wait(300)
}
const type = async (loc, text, delay = 32) => {
  await click(loc)
  await loc.pressSequentially(text, { delay })
}
const drag = async (from, to) => {
  const a = await moveTo(from)
  await wait(200)
  await page.mouse.down()
  const b = await center(to)
  const steps = 28
  for (let i = 1; i <= steps; i++) {
    const k = i / steps
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    const x = a.x + (b.x - a.x) * e
    const y = a.y + (b.y - a.y) * e
    await page.mouse.move(x, y)
    await page.evaluate(([x, y]) => window.__setCursor(x, y), [x, y])
    await wait(18)
  }
  await wait(150)
  await page.mouse.up()
}

const modal = () => page.locator('.modal')
const homeTab = (name) => page.locator('.home-nav').getByRole('tab', { name, exact: true })
// Every repository tab keeps its view in the page (hidden when not active): match visible ones.
const sbItem = (name) => page.locator(`.sidebar .sb-item[title="${name}"]:visible`)
const menuItem = (name) => page.locator('.context-menu [role=menuitem]', { hasText: name }).first()
const row = (text) => page.locator('.graph-row:visible', { hasText: text }).first()
const tool = (text) => page.locator('.toolbar .tool:visible', { hasText: text })
const sessions = () => page.evaluate(() => window.api.agentSessions())

// Answers Claude Code's trust question (Down, Enter) and approval prompts (Enter = yes).
const handled = {}
const watchdog = setInterval(async () => {
  try {
    const out = await page.evaluate(() => window.__term)
    for (const [id, text] of Object.entries(out)) {
      const fresh = text.slice(handled[id] ?? 0)
      if (/Yes, I trust this folder/.test(fresh)) {
        handled[id] = text.length
        await wait(500)
        await page.evaluate(([id]) => window.api.terminalWrite(id, '\x1b[B'), [id])
        await wait(300)
        await page.evaluate(([id]) => window.api.terminalWrite(id, '\r'), [id])
        console.log(`    answered the trust question in ${id}`)
      } else if (/Do you want to proceed\?|Do you want to make this edit/.test(fresh)) {
        handled[id] = text.length
        await wait(400)
        await page.evaluate(([id]) => window.api.terminalWrite(id, '\r'), [id])
        console.log(`    approved a prompt in ${id}`)
      }
    }
  } catch {
    /* page busy */
  }
}, 700)

// --- frames -------------------------------------------------------------------------------------
const cdp = await page.context().newCDPSession(page)
const frames = []
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = `f${String(frames.length).padStart(6, '0')}.jpg`
  writeFileSync(join(FRAMES, file), Buffer.from(data, 'base64'))
  frames.push({ file, t: metadata.timestamp })
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})
await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 90,
  maxWidth: 1440,
  maxHeight: 900
})

let failed = null
try {
  // 1. Every repository on one page; Sync fetches them all.
  await wait(1500)
  mark('dashboard')
  await moveTo(page.locator('.card', { hasText: 'web-app' }).first(), 900)
  await wait(500)
  await click(page.locator('.dash-header').getByRole('button', { name: 'Sync' }))
  await page
    .locator('.card', { hasText: 'api-server' })
    .locator('.badge', { hasText: '↓2' })
    .waitFor({ timeout: 30000 })
  await moveTo(
    page.locator('.card', { hasText: 'api-server' }).locator('.badge', { hasText: '↓2' }),
    700
  )
  mark('synced')
  await wait(1600)

  // 2. Two agents, each on its own branch and worktree.
  await click(homeTab('Agents'))
  mark('agents-page')
  await wait(900)
  for (const [i, task] of TASKS.entries()) {
    await click(page.getByRole('button', { name: 'New agent session' }).first())
    await modal().locator('#agent-task').waitFor()
    await modal().locator('#agent-repo').selectOption(REPO)
    await modal()
      .locator('#agent-kind')
      .selectOption(DRY ? 'custom' : 'claude')
    mark(`agent${i + 1}-dialog`)
    await type(modal().locator('#agent-task'), task.text, 24)
    await type(modal().locator('#agent-branch'), task.branch, 40)
    await wait(500)
    await click(modal().getByRole('button', { name: 'Start agent' }))
    await modal().waitFor({ state: 'detached', timeout: 30000 })
    await page.locator('.agent-card', { hasText: task.text.slice(0, 40) }).waitFor()
    mark(`agent${i + 1}-started`)
    await wait(DRY ? 2500 : 9000)
    mark(`agent${i + 1}-working`)
  }
  await wait(5000)
  mark('agents-watch-end')

  // 3. Meanwhile: the repository, line-by-line staging, a commit.
  await click(homeTab('Projects'))
  await click(
    page
      .locator('.card', { hasText: 'web-app' })
      .first()
      .getByText('web-app', { exact: true })
      .first()
  )
  await page.locator('.graph-row.wip:visible').waitFor({ timeout: 30000 })
  mark('repo')
  await wait(800)
  await moveTo(row('Merge branch'), 900)
  await wait(500)
  await moveTo(row('Configure CI pipeline'), 700)
  await wait(400)
  await click(page.locator('.graph-row.wip:visible'))
  mark('wip')
  const unstaged = page
    .locator('section')
    .filter({ has: page.locator('.section-title', { hasText: /^Unstaged/ }) })
  await click(unstaged.locator('li', { hasText: 'settings.ts' }))
  await page.locator('.diff-view .hunk:visible').first().waitFor()
  mark('diff')
  await wait(1200)
  await click(page.getByRole('checkbox', { name: `Removed line ${removedButton}`, exact: true }))
  await click(page.getByRole('checkbox', { name: `Added line ${addedButton}`, exact: true }), 400)
  await click(page.getByRole('button', { name: 'Stage selected lines' }))
  await page
    .locator('section')
    .filter({ has: page.locator('.section-title', { hasText: /^Staged/ }) })
    .locator('li', { hasText: 'settings.ts' })
    .waitFor()
  mark('staged')
  await wait(900)
  await type(page.getByPlaceholder('Summary'), 'Clearer label on the save button', 38)
  await wait(300)
  await click(page.getByRole('button', { name: /Commit changes to 1 file/ }))
  await tool('Push ↑1').waitFor({ timeout: 20000 })
  await wait(700)
  // The diff stays open over the graph while other files are unstaged: Esc closes it.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Escape')
  await row('Clearer label on the save button').waitFor()
  mark('committed')
  await wait(1200)

  // 4. Merge by dragging a branch; Undo puts it back.
  await drag(sbItem('feature/dashboard'), sbItem('main'))
  await click(menuItem('Merge feature/dashboard into main'))
  await row("Merge branch 'feature/dashboard'").waitFor({ timeout: 20000 })
  mark('merged')
  await wait(1500)
  await click(tool('Undo'))
  await row("Merge branch 'feature/dashboard'").waitFor({ state: 'detached', timeout: 20000 })
  mark('undone')
  await wait(1200)

  // 5. Back to the agents once both have committed.
  await click(page.getByRole('tab', { name: 'Home', exact: true }))
  await click(homeTab('Agents'))
  mark('agents-back')
  const end = Date.now() + 8 * 60e3
  for (;;) {
    const list = await sessions()
    if (list.length === 2 && list.every((s) => s.ahead >= 1 && !s.changes)) break
    if (Date.now() > end) throw new Error('the agents did not both commit within 8 minutes')
    await wait(2000)
  }
  await page.locator('.agent-card .agent-last').nth(1).waitFor({ timeout: 20000 })
  mark('agents-done')
  await wait(1500)
  const done = await sessions()
  const first = done.find((s) => s.branch === TASKS[0].branch)
  const card1 = page.locator('.agent-card', { hasText: TASKS[0].text.slice(0, 40) })
  await click(card1.getByRole('button', { name: /Terminal/ }))
  mark('agent1-terminal')
  await wait(3500)

  // 6. Review the agent's commit, then merge both branches.
  await click(card1.getByRole('button', { name: 'Open' }))
  await row(first.lastCommit).waitFor({ timeout: 30000 })
  mark('agent-tab')
  await wait(700)
  await click(row(first.lastCommit))
  await page.locator('.side-panel li:visible', { hasText: TASKS[0].file }).first().waitFor()
  await click(page.locator('.side-panel li:visible', { hasText: TASKS[0].file }).first())
  await page.locator('.diff-view .hunk:visible').first().waitFor()
  mark('agent-diff')
  await wait(3500)
  await click(page.locator('.tabbar-tabs [role=tab]', { hasText: /^\s*web-app/ }).first())
  await page.locator('.graph-row.wip:visible').waitFor()
  await wait(600)
  for (const task of TASKS) {
    await drag(sbItem(task.branch), sbItem('main'))
    await click(menuItem(`Merge ${task.branch} into main`))
    await row(`Merge branch '${task.branch}'`).waitFor({ timeout: 20000 })
    mark(`merged-${task.branch}`)
    await wait(1200)
  }
  await moveTo(row(`Merge branch '${TASKS[1].branch}'`), 600)
  await wait(1500)
  mark('end')
} catch (e) {
  failed = e
  console.error('FAILED:', e.message)
  await page.screenshot({ path: join(TAKE, 'failure.png') }).catch(() => {})
} finally {
  clearInterval(watchdog)
  await cdp.send('Page.stopScreencast').catch(() => {})
  writeFileSync(
    join(TAKE, 'take.json'),
    JSON.stringify({ frames, markers, failed: failed?.message ?? null }, null, 1)
  )
  console.log(`frames: ${frames.length}, markers: ${markers.length}`)
  await app.close().catch(() => {})
}
if (failed) process.exit(1)
