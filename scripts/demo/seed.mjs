// Builds the demo repositories (DEMO_ROOT), their "remotes" and a teammate's clone, and
// GitDesk's settings folder (in WORK). Every run starts again from scratch; a folder is only
// deleted if these scripts made it (it holds their MARK file).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEMO_ROOT, MARK, WORK } from './config.mjs'

const ROOT = DEMO_ROOT
const REMOTES = join(WORK, 'remotes')
const TEAM = join(WORK, 'team')
const USERDATA = join(WORK, 'userdata')

/** Refuses a folder these scripts did not make, unless it is empty; marks it as theirs. */
function claim(dir) {
  if (existsSync(dir) && !existsSync(join(dir, MARK)) && readdirSync(dir).length)
    throw new Error(`${dir} exists and was not made by the demo scripts: choose another folder`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MARK), "Made by GitDesk's scripts/demo. Safe to delete.\n")
}
/** An empty folder of these scripts. */
function fresh(dir) {
  claim(dir)
  rmSync(dir, { recursive: true, force: true })
  claim(dir)
}
claim(WORK)
for (const dir of [ROOT, REMOTES, TEAM, USERDATA]) fresh(dir)

const PEOPLE = {
  alice: ['Alice Martin', 'alice@example.com'],
  bob: ['Bob Chen', 'bob@example.com'],
  chloe: ['Chloé Dubois', 'chloe@example.com'],
  david: ['David Kim', 'david@example.com']
}
const NOW = Date.now()

function git(cwd, args, who = 'alice', ago = 0) {
  const [name, email] = PEOPLE[who]
  const date = new Date(NOW - ago * 3600e3).toISOString()
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date
    }
  }).trim()
}

function write(repo, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content.replace(/^\n/, ''))
  }
}

/** ago: hours before now. */
function commit(repo, who, ago, msg, files = {}) {
  write(repo, files)
  git(repo, ['add', '-A'], who, ago)
  git(repo, ['commit', '-q', '--allow-empty', '-m', msg], who, ago)
}
const merge = (repo, who, ago, branch) =>
  git(repo, ['merge', '-q', '--no-ff', '-m', `Merge branch '${branch}'`, branch], who, ago)

function newRepo(name, branch = 'main') {
  const repo = join(ROOT, name)
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', branch])
  // The demo identity, so nothing made during the recording carries a real name.
  for (const [k, v] of [
    ['user.name', 'Alice Martin'],
    ['user.email', 'alice@example.com'],
    ['core.autocrlf', 'false'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false']
  ])
    git(repo, ['config', k, v])
  return repo
}

function addRemote(repo, name) {
  const bare = join(REMOTES, `${name}.git`)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  git(repo, ['remote', 'add', 'origin', bare])
  git(repo, ['push', '-q', '--all', 'origin'])
  git(repo, ['push', '-q', '--tags', 'origin'])
  for (const b of git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split(
    '\n'
  ))
    git(repo, ['branch', '-q', '--set-upstream-to', `origin/${b}`, b])
  return bare
}

function teammate(bare, name) {
  const clone = join(TEAM, name)
  execFileSync('git', ['clone', '-q', bare, clone])
  git(clone, ['config', 'core.autocrlf', 'false'])
  git(clone, ['config', 'commit.gpgsign', 'false'])
  return clone
}

// --- web-app: real code for the agents to work on --------------------------------------------
{
  const r = newRepo('web-app')
  commit(r, 'alice', 34 * 24, 'Initial project setup', {
    'package.json': `
{
  "name": "web-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
`,
    'index.html': `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Acme</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
    'tsconfig.json': `
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}
`,
    'README.md': `
# web-app

The Acme customer dashboard.

    npm install
    npm run dev
`,
    '.claude/settings.json': `
{
  "remoteControlAtStartup": false,
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": [
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(grep:*)"
    ],
    "deny": ["Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(pnpm:*)", "Bash(yarn:*)"]
  }
}
`,
    'src/main.ts': `
import './styles.css'

const root = document.getElementById('app')!
root.textContent = 'Acme'
`,
    'src/styles.css': `
:root {
  font-family: Inter, system-ui, sans-serif;
  color: #1f2328;
  background: #f6f8fa;
}

body {
  margin: 0;
}
`
  })
  commit(r, 'alice', 33 * 24, 'Add routing and layout', {
    'src/main.ts': `
import { renderDashboard } from './pages/dashboard'
import './styles.css'

const routes: Record<string, (root: HTMLElement) => void> = {
  '/': renderDashboard,
}

function render(): void {
  const root = document.getElementById('app')!
  root.innerHTML = ''
  ;(routes[location.pathname] ?? renderDashboard)(root)
}

window.addEventListener('popstate', render)
render()
`,
    'src/pages/dashboard.ts': `
export function renderDashboard(root: HTMLElement): void {
  root.innerHTML = '<header class="page-header"><h1>Dashboard</h1></header>'
}
`,
    'src/styles.css': `
:root {
  font-family: Inter, system-ui, sans-serif;
  color: #1f2328;
  background: #f6f8fa;
}

body {
  margin: 0;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid #d1d9e0;
}

.card {
  max-width: 420px;
  margin: 48px auto;
  padding: 24px;
  border-radius: 12px;
  background: #fff;
  display: grid;
  gap: 12px;
}
`
  })
  commit(r, 'david', 31 * 24, 'Configure CI pipeline', {
    '.github/workflows/ci.yml': `
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm test
`
  })
  git(r, ['tag', 'v0.1.0'], 'david', 31 * 24)

  git(r, ['switch', '-qc', 'feature/login'])
  commit(r, 'bob', 29 * 24, 'Add login form', {
    'src/pages/login.ts': `
export function renderLogin(root: HTMLElement): void {
  root.innerHTML = \`
    <form class="card" id="login">
      <h1>Sign in</h1>
      <label>Email <input name="email" type="email" required /></label>
      <label>Password <input name="password" type="password" required /></label>
      <button type="submit">Sign in</button>
    </form>\`
}
`
  })
  git(r, ['switch', '-q', 'main'])
  commit(r, 'chloe', 28 * 24, 'Fix header alignment on mobile', {
    'src/styles.css': `
:root {
  font-family: Inter, system-ui, sans-serif;
  color: #1f2328;
  background: #f6f8fa;
}

body {
  margin: 0;
}

.page-header {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid #d1d9e0;
}

.card {
  max-width: 420px;
  margin: 48px auto;
  padding: 24px;
  border-radius: 12px;
  background: #fff;
  display: grid;
  gap: 12px;
}

.error {
  color: #d1242f;
  font-size: 13px;
}
`
  })
  git(r, ['switch', '-q', 'feature/login'])
  commit(r, 'bob', 27 * 24, 'Validate credentials on submit', {
    'src/pages/login.ts': `
import { signIn } from '../api'

export function renderLogin(root: HTMLElement): void {
  root.innerHTML = \`
    <form class="card" id="login">
      <h1>Sign in</h1>
      <label>Email <input name="email" type="email" required /></label>
      <label>Password <input name="password" type="password" required /></label>
      <p class="error" hidden></p>
      <button type="submit">Sign in</button>
    </form>\`
  const form = root.querySelector<HTMLFormElement>('#login')!
  const error = form.querySelector<HTMLElement>('.error')!
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const ok = await signIn(String(data.get('email')), String(data.get('password')))
    if (ok) location.assign('/')
    else {
      error.textContent = 'Wrong email or password.'
      error.hidden = false
    }
  })
}
`,
    'src/api.ts': `
export async function signIn(email: string, password: string): Promise<boolean> {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return res.ok
}
`
  })
  commit(r, 'bob', 26 * 24, 'Remember me checkbox', {
    'src/pages/login.ts': `
import { signIn } from '../api'

export function renderLogin(root: HTMLElement): void {
  root.innerHTML = \`
    <form class="card" id="login">
      <h1>Sign in</h1>
      <label>Email <input name="email" type="email" required /></label>
      <label>Password <input name="password" type="password" required /></label>
      <label><input name="remember" type="checkbox" /> Remember me</label>
      <p class="error" hidden></p>
      <button type="submit">Sign in</button>
    </form>\`
  const form = root.querySelector<HTMLFormElement>('#login')!
  const error = form.querySelector<HTMLElement>('.error')!
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const ok = await signIn(String(data.get('email')), String(data.get('password')), data.has('remember'))
    if (ok) location.assign('/')
    else {
      error.textContent = 'Wrong email or password.'
      error.hidden = false
    }
  })
}
`,
    'src/api.ts': `
export async function signIn(email: string, password: string, remember = false): Promise<boolean> {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, remember }),
  })
  return res.ok
}
`
  })
  git(r, ['switch', '-q', 'main'])
  merge(r, 'alice', 25 * 24, 'feature/login')
  commit(r, 'alice', 25 * 24 - 1, 'Route the login page', {
    'src/main.ts': `
import { renderDashboard } from './pages/dashboard'
import { renderLogin } from './pages/login'
import './styles.css'

const routes: Record<string, (root: HTMLElement) => void> = {
  '/': renderDashboard,
  '/login': renderLogin,
}

function render(): void {
  const root = document.getElementById('app')!
  root.innerHTML = ''
  ;(routes[location.pathname] ?? renderDashboard)(root)
}

window.addEventListener('popstate', render)
render()
`
  })
  commit(r, 'david', 24 * 24, 'Update dependencies', {
    'package.json': `
{
  "name": "web-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
`
  })
  commit(r, 'alice', 23 * 24, 'Add dashboard data', {
    'src/api.ts': `
export interface Stat {
  label: string
  value: number
}

export async function signIn(email: string, password: string, remember = false): Promise<boolean> {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, remember }),
  })
  return res.ok
}

export async function fetchStats(): Promise<Stat[]> {
  const res = await fetch('/api/stats')
  return res.json()
}
`,
    'src/pages/dashboard.ts': `
import { fetchStats } from '../api'

export async function renderDashboard(root: HTMLElement): Promise<void> {
  root.innerHTML = \`
    <header class="page-header"><h1>Dashboard</h1></header>
    <section id="stats" class="stats"></section>\`
  const stats = await fetchStats()
  const list = root.querySelector('#stats')!
  for (const s of stats) {
    list.insertAdjacentHTML('beforeend', \`<div class="stat"><span>\${s.label}</span><strong>\${s.value}</strong></div>\`)
  }
}
`
  })

  git(r, ['switch', '-qc', 'feature/dashboard'])
  commit(r, 'bob', 20 * 24, 'Charts for weekly stats', {
    'src/charts.ts': `
import type { Stat } from './api'

/** A bar chart of the stats, as an SVG string. */
export function barChart(stats: Stat[], width = 480, height = 160): string {
  const max = Math.max(1, ...stats.map((s) => s.value))
  const w = width / Math.max(1, stats.length)
  const bars = stats
    .map((s, i) => {
      const h = (s.value / max) * (height - 20)
      return \`<rect x="\${i * w + 4}" y="\${height - h}" width="\${w - 8}" height="\${h}" rx="3" />\`
    })
    .join('')
  return \`<svg class="chart" viewBox="0 0 \${width} \${height}">\${bars}</svg>\`
}
`
  })
  git(r, ['switch', '-q', 'main'])
  commit(r, 'chloe', 21 * 24, 'Add signup page', {
    'src/pages/signup.ts': `
export function renderSignup(root: HTMLElement): void {
  root.innerHTML = \`
    <form class="card" id="signup">
      <h1>Create your account</h1>
      <label>Name <input name="name" required /></label>
      <label>Email <input name="email" type="text" required /></label>
      <label>Password <input name="password" type="password" minlength="8" required /></label>
      <button type="submit">Sign up</button>
    </form>\`
  const form = root.querySelector<HTMLFormElement>('#signup')!
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = Object.fromEntries(new FormData(form))
    await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    location.assign('/')
  })
}
`,
    'src/main.ts': `
import { renderDashboard } from './pages/dashboard'
import { renderLogin } from './pages/login'
import { renderSignup } from './pages/signup'
import './styles.css'

const routes: Record<string, (root: HTMLElement) => void> = {
  '/': renderDashboard,
  '/login': renderLogin,
  '/signup': renderSignup,
}

function render(): void {
  const root = document.getElementById('app')!
  root.innerHTML = ''
  ;(routes[location.pathname] ?? renderDashboard)(root)
}

window.addEventListener('popstate', render)
render()
`
  })
  commit(r, 'alice', 19 * 24, 'Add settings page', {
    'src/pages/settings.ts': `
import { getUser, saveUser } from '../api'

export async function renderSettings(root: HTMLElement): Promise<void> {
  const user = await getUser()
  root.innerHTML = \`
    <form class="card" id="settings">
      <h1>Settings</h1>
      <label>Display name <input name="name" value="\${user.name}" /></label>
      <label>Email <input name="email" type="email" value="\${user.email}" /></label>
      <label><input name="digest" type="checkbox" \${user.digest ? 'checked' : ''} /> Weekly digest</label>
      <button type="submit">Save</button>
    </form>\`
  const form = root.querySelector<HTMLFormElement>('#settings')!
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    await saveUser({ name: String(data.get('name')), email: String(data.get('email')), digest: data.has('digest') })
  })
}
`,
    'src/api.ts': `
export interface Stat {
  label: string
  value: number
}

export interface User {
  name: string
  email: string
  digest: boolean
}

export async function signIn(email: string, password: string, remember = false): Promise<boolean> {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, remember }),
  })
  return res.ok
}

export async function fetchStats(): Promise<Stat[]> {
  const res = await fetch('/api/stats')
  return res.json()
}

export async function getUser(): Promise<User> {
  const res = await fetch('/api/me')
  return res.json()
}

export async function saveUser(user: User): Promise<void> {
  await fetch('/api/me', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user),
  })
}
`,
    'src/main.ts': `
import { renderDashboard } from './pages/dashboard'
import { renderLogin } from './pages/login'
import { renderSettings } from './pages/settings'
import { renderSignup } from './pages/signup'
import './styles.css'

const routes: Record<string, (root: HTMLElement) => void> = {
  '/': renderDashboard,
  '/login': renderLogin,
  '/signup': renderSignup,
  '/settings': renderSettings,
}

function render(): void {
  const root = document.getElementById('app')!
  root.innerHTML = ''
  ;(routes[location.pathname] ?? renderDashboard)(root)
}

window.addEventListener('popstate', render)
render()
`
  })
  commit(r, 'david', 17 * 24, 'Improve error messages', {
    'src/pages/login.ts': `
import { signIn } from '../api'

export function renderLogin(root: HTMLElement): void {
  root.innerHTML = \`
    <form class="card" id="login">
      <h1>Sign in</h1>
      <label>Email <input name="email" type="email" required /></label>
      <label>Password <input name="password" type="password" required /></label>
      <label><input name="remember" type="checkbox" /> Remember me</label>
      <p class="error" hidden></p>
      <button type="submit">Sign in</button>
    </form>\`
  const form = root.querySelector<HTMLFormElement>('#login')!
  const error = form.querySelector<HTMLElement>('.error')!
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    try {
      const ok = await signIn(String(data.get('email')), String(data.get('password')), data.has('remember'))
      if (ok) return location.assign('/')
      error.textContent = 'That email and password do not match. Try again or reset your password.'
    } catch {
      error.textContent = 'We could not reach the server. Check your connection and try again.'
    }
    error.hidden = false
  })
}
`
  })
  commit(r, 'chloe', 15 * 24, 'Empty states', {
    'src/pages/dashboard.ts': `
import { fetchStats } from '../api'

export async function renderDashboard(root: HTMLElement): Promise<void> {
  root.innerHTML = \`
    <header class="page-header"><h1>Dashboard</h1></header>
    <section id="stats" class="stats"></section>\`
  const stats = await fetchStats()
  const list = root.querySelector('#stats')!
  if (!stats.length) {
    list.innerHTML = '<p class="empty">No data yet. Stats appear after your first week.</p>'
    return
  }
  for (const s of stats) {
    list.insertAdjacentHTML('beforeend', \`<div class="stat"><span>\${s.label}</span><strong>\${s.value}</strong></div>\`)
  }
}
`
  })
  commit(r, 'alice', 12 * 24, 'Release 1.0', {
    'package.json': `
{
  "name": "web-app",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
`
  })
  git(r, ['tag', 'v1.0.0'], 'alice', 12 * 24)

  git(r, ['switch', '-qc', 'fix/session-timeout'])
  commit(r, 'david', 4 * 24, 'Refresh session before expiry', {
    'src/session.ts': `
const REFRESH_BEFORE_MS = 60_000

/** Refreshes the session a minute before it expires, while the tab is open. */
export function keepSessionAlive(expiresAt: number): void {
  const wait = Math.max(0, expiresAt - Date.now() - REFRESH_BEFORE_MS)
  setTimeout(async () => {
    const res = await fetch('/api/session/refresh', { method: 'POST' })
    if (res.ok) keepSessionAlive((await res.json()).expiresAt)
  }, wait)
}
`
  })
  git(r, ['switch', '-q', 'feature/dashboard'])
  commit(r, 'bob', 3 * 24, 'Empty state for charts', {
    'src/charts.ts': `
import type { Stat } from './api'

/** A bar chart of the stats, as an SVG string, or a short note when there is nothing to draw. */
export function barChart(stats: Stat[], width = 480, height = 160): string {
  if (!stats.length) return '<p class="empty">Nothing to chart yet.</p>'
  const max = Math.max(1, ...stats.map((s) => s.value))
  const w = width / stats.length
  const bars = stats
    .map((s, i) => {
      const h = (s.value / max) * (height - 20)
      return \`<rect x="\${i * w + 4}" y="\${height - h}" width="\${w - 8}" height="\${h}" rx="3" />\`
    })
    .join('')
  return \`<svg class="chart" viewBox="0 0 \${width} \${height}">\${bars}</svg>\`
}
`
  })
  git(r, ['switch', '-q', 'main'])
  commit(r, 'bob', 6 * 24, 'Polish settings copy', {
    'src/pages/settings.ts': `
import { getUser, saveUser } from '../api'

export async function renderSettings(root: HTMLElement): Promise<void> {
  const user = await getUser()
  root.innerHTML = \`
    <form class="card" id="settings">
      <h1>Account settings</h1>
      <label>Display name <input name="name" value="\${user.name}" /></label>
      <label>Email <input name="email" type="email" value="\${user.email}" /></label>
      <label><input name="digest" type="checkbox" \${user.digest ? 'checked' : ''} /> Send me a weekly summary</label>
      <button type="submit">Save</button>
    </form>\`
  const form = root.querySelector<HTMLFormElement>('#settings')!
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    await saveUser({ name: String(data.get('name')), email: String(data.get('email')), digest: data.has('digest') })
  })
}
`
  })
  commit(r, 'alice', 11, 'Keyboard shortcuts for tabs', {
    'src/shortcuts.ts': `
/** Ctrl+1 to Ctrl+9 switch between the app's main pages. */
export function installShortcuts(pages: string[]): void {
  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.key < '1' || event.key > '9') return
    const page = pages[Number(event.key) - 1]
    if (!page) return
    event.preventDefault()
    history.pushState(null, '', page)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}
`
  })
  addRemote(r, 'web-app')
  // Work in progress: two files, the settings page in two separate places.
  write(r, {
    'src/pages/settings.ts': `
import { getUser, saveUser } from '../api'

export async function renderSettings(root: HTMLElement): Promise<void> {
  const user = await getUser()
  root.innerHTML = \`
    <form class="card" id="settings">
      <h1>Account settings</h1>
      <label>Display name <input name="name" value="\${user.name}" /></label>
      <label>Email <input name="email" type="email" value="\${user.email}" /></label>
      <label>Time zone <select name="timezone">\${timeZones(user.timezone)}</select></label>
      <label><input name="digest" type="checkbox" \${user.digest ? 'checked' : ''} /> Send me a weekly summary</label>
      <button type="submit">Save changes</button>
    </form>\`
  const form = root.querySelector<HTMLFormElement>('#settings')!
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    await saveUser({ name: String(data.get('name')), email: String(data.get('email')), digest: data.has('digest') })
  })
}

function timeZones(current = 'UTC'): string {
  return ['UTC', 'Europe/Paris', 'America/New_York', 'Asia/Tokyo']
    .map((tz) => \`<option \${tz === current ? 'selected' : ''}>\${tz}</option>\`)
    .join('')
}
`,
    'README.md': `
# web-app

The Acme customer dashboard.

    npm install
    npm run dev

Pages: dashboard, sign in, sign up and account settings.
`
  })
}

// --- api-server: on a feature branch; teammates pushed two commits to it ---------------------
{
  const r = newRepo('api-server')
  commit(r, 'david', 30 * 24, 'Initial API server', {
    'package.json': '{\n  "name": "api-server",\n  "version": "0.1.0",\n  "type": "module"\n}\n',
    'src/server.ts': "import { createServer } from 'node:http'\n\ncreateServer().listen(3000)\n"
  })
  commit(r, 'david', 26 * 24, 'Add users endpoint', {
    'src/routes/users.ts': 'export const users = []\n'
  })
  commit(r, 'bob', 22 * 24, 'Add session endpoint', {
    'src/routes/session.ts': 'export const sessions = new Map()\n'
  })
  commit(r, 'david', 16 * 24, 'Log requests', { 'src/log.ts': 'export const log = console.log\n' })
  commit(r, 'bob', 9 * 24, 'Health check', {
    'src/routes/health.ts': "export const health = () => 'ok'\n"
  })
  git(r, ['switch', '-qc', 'feature/rate-limit'])
  commit(r, 'david', 2 * 24, 'Rate limit skeleton', {
    'src/middleware/rateLimit.ts': 'export const limit = 100\n'
  })
  commit(r, 'david', 26, 'Add rate limiter', {
    'src/middleware/rateLimit.ts': 'export const limit = 100\nexport const windowMs = 60_000\n'
  })
  const bare = addRemote(r, 'api-server')
  const t = teammate(bare, 'api-server')
  git(t, ['switch', '-q', 'feature/rate-limit'])
  commit(t, 'bob', 3, 'Tests for the rate limiter', {
    'test/rateLimit.test.ts': "import { limit } from '../src/middleware/rateLimit'\n"
  })
  commit(t, 'bob', 2, 'Return Retry-After on 429', {
    'src/middleware/rateLimit.ts':
      "export const limit = 100\nexport const windowMs = 60_000\nexport const retryAfter = 'Retry-After'\n"
  })
  git(t, ['push', '-q'], 'bob', 2)
}

// --- docs-site: clean, up to date ---------------------------------------------------------------
{
  const r = newRepo('docs-site')
  for (let i = 1; i <= 7; i++)
    commit(r, i % 3 ? 'chloe' : 'alice', (30 - i * 4) * 24 + 3, `Docs: section ${i}`, {
      [`docs/section-${i}.md`]: `# Section ${i}\n\nWork in progress.\n`
    })
  addRemote(r, 'docs-site')
}

// --- mobile-app: two commits not pushed yet ------------------------------------------------------
{
  const r = newRepo('mobile-app')
  commit(r, 'bob', 28 * 24, 'Initial mobile app', {
    'App.tsx': 'export default function App() {}\n'
  })
  commit(r, 'bob', 20 * 24, 'Navigation', { 'src/navigation.tsx': 'export const routes = []\n' })
  commit(r, 'chloe', 13 * 24, 'Login screen', {
    'src/screens/Login.tsx': 'export function Login() {}\n'
  })
  commit(r, 'bob', 7 * 24, 'Push notifications', {
    'src/push.ts': 'export function register() {}\n'
  })
  addRemote(r, 'mobile-app')
  commit(r, 'bob', 30, 'Offline mode', { 'src/offline.ts': 'export const cache = new Map()\n' })
  commit(r, 'bob', 5, 'Sync on reconnect', {
    'src/offline.ts': 'export const cache = new Map()\nexport function sync() {}\n'
  })
}

// --- design-system: clean ------------------------------------------------------------------------
{
  const r = newRepo('design-system')
  const parts = ['Button', 'Input', 'Select', 'Modal', 'Tabs', 'Toast']
  parts.forEach((p, i) =>
    commit(r, i % 2 ? 'alice' : 'chloe', (27 - i * 4) * 24 + 5, `Add ${p} component`, {
      [`src/${p}.tsx`]: `export function ${p}() {}\n`
    })
  )
  addRemote(r, 'design-system')
}

// --- GitDesk's settings folder: these five repositories, dark theme, nothing fetched in the background.
const repos = ['web-app', 'api-server', 'docs-site', 'mobile-app', 'design-system'].map((n) =>
  join(ROOT, n)
)
writeFileSync(
  join(USERDATA, 'gitdesk.json'),
  JSON.stringify(
    {
      repos,
      openTabs: [],
      activeTab: null,
      settings: {
        theme: 'dark',
        showAvatars: true,
        useGravatar: false,
        autoUpdate: false,
        fetchIntervalMinutes: 0
      }
    },
    null,
    2
  )
)
console.log('demo ready:', repos.join(', '))
