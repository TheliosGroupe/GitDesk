// Draws the still pictures of the demo videos into ASSETS: backgrounds with a hole where the
// app shows (square 1080 and landscape 1920 x 1080), one picture per caption, the opening and
// closing cards, and the "Sped up" badge. Runs in Electron: npx electron scripts/demo/cards.mjs
import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSETS, CAPTIONS, LAYOUTS } from './config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = ASSETS
app.on('window-all-closed', () => {})

async function main() {
  mkdirSync(OUT, { recursive: true })
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<!doctype html><html><body></body></html>')
  // The app icon's drawing.
  const tile = readFileSync(join(HERE, '..', '..', 'build', 'icon.svg')).toString('base64')
  const jobs = []
  for (const [name, L] of Object.entries(LAYOUTS)) {
    jobs.push({ out: `${name}-bg.png`, kind: 'bg', L })
    jobs.push({ out: `${name}-intro.png`, kind: 'intro', L })
    jobs.push({ out: `${name}-outro.png`, kind: 'outro', L })
    for (const [key, text] of Object.entries(CAPTIONS))
      jobs.push({ out: `${name}-cap-${key}.png`, kind: 'caption', L, text })
  }
  jobs.push({ out: 'badge.png', kind: 'badge' })
  for (const job of jobs) {
    const data = await win.webContents.executeJavaScript(
      `(${draw.toString()})(${JSON.stringify(job)}, '${tile}')`
    )
    writeFileSync(join(OUT, job.out), Buffer.from(data, 'base64'))
  }
  console.log(`${jobs.length} pictures in ${OUT}`)
  app.quit()
}

// Runs in the page.
async function draw(job, tileB64) {
  const FONT = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif'
  const INK = '#f0f3f6'
  const MUTED = '#a3acbb'
  const ACCENT = '#58a6ff'
  const tile = new Image()
  tile.src = 'data:image/svg+xml;base64,' + tileB64
  await tile.decode()
  await document.fonts.load(`700 40px ${FONT}`)

  const canvas = (w, h) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return [c, c.getContext('2d')]
  }
  const rounded = (g, x, y, w, h, r) => {
    g.beginPath()
    g.moveTo(x + r, y)
    g.arcTo(x + w, y, x + w, y + h, r)
    g.arcTo(x + w, y + h, x, y + h, r)
    g.arcTo(x, y + h, x, y, r)
    g.arcTo(x, y, x + w, y, r)
    g.closePath()
  }
  const background = (g, w, h) => {
    g.fillStyle = '#0d1015'
    g.fillRect(0, 0, w, h)
    const m = Math.max(w, h)
    for (const [cx, cy, r, color] of [
      [0.12 * w, 0.18 * h, 0.42 * m, 'rgba(61, 139, 253, 0.30)'],
      [0.68 * w, 1.0 * h, 0.45 * m, 'rgba(137, 87, 229, 0.26)'],
      [0.96 * w, 0.0 * h, 0.35 * m, 'rgba(26, 166, 140, 0.16)']
    ]) {
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r)
      grad.addColorStop(0, color)
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
      g.fillStyle = grad
      g.fillRect(0, 0, w, h)
    }
  }
  const lines = (g, text, maxWidth) => {
    const out = []
    let line = ''
    for (const word of text.split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (g.measureText(next).width > maxWidth && line) {
        out.push(line)
        line = word
      } else line = next
    }
    if (line) out.push(line)
    return out
  }
  const text = (g, s, x, y, size, weight, color, maxWidth, lineHeight = 1.25) => {
    g.font = `${weight} ${size}px ${FONT}`
    g.fillStyle = color
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const ls = s.split('\n').flatMap((p) => lines(g, p, maxWidth))
    const top = y - ((ls.length - 1) * size * lineHeight) / 2
    ls.forEach((l, i) => g.fillText(l, x, top + i * size * lineHeight))
    return ls.length
  }
  const done = (c) => c.toDataURL('image/png').split(',')[1]

  if (job.kind === 'badge') {
    const [c, g] = canvas(176, 46)
    rounded(g, 1, 1, 174, 44, 22)
    g.fillStyle = 'rgba(13, 16, 21, 0.82)'
    g.fill()
    g.strokeStyle = 'rgba(255, 255, 255, 0.22)'
    g.lineWidth = 1.5
    g.stroke()
    g.fillStyle = INK
    for (const dx of [0, 13]) {
      g.beginPath()
      g.moveTo(24 + dx, 14)
      g.lineTo(36 + dx, 23)
      g.lineTo(24 + dx, 32)
      g.closePath()
      g.fill()
    }
    g.font = `600 20px ${FONT}`
    g.textBaseline = 'middle'
    g.fillText('Sped up', 64, 24)
    return done(c)
  }

  const L = job.L
  const [c, g] = canvas(L.w, L.h)

  if (job.kind === 'caption') {
    const [cc, cg] = canvas(L.w, L.capH)
    text(cg, job.text, L.w / 2, L.capH / 2, L.capSize, 650, INK, L.capWidth)
    return done(cc)
  }

  background(g, L.w, L.h)

  if (job.kind === 'bg') {
    const v = L.video
    // Soft shadow under the app, then a hole the app shows through, then its border.
    g.save()
    g.shadowColor = 'rgba(0, 0, 0, 0.6)'
    g.shadowBlur = 50
    g.shadowOffsetY = 18
    rounded(g, v.x, v.y, v.w, v.h, v.r)
    g.fillStyle = '#000'
    g.fill()
    g.restore()
    // restore() brought back the last gradient as fill style: cut with an opaque one.
    g.globalCompositeOperation = 'destination-out'
    g.fillStyle = '#000'
    rounded(g, v.x, v.y, v.w, v.h, v.r)
    g.fill()
    g.globalCompositeOperation = 'source-over'
    rounded(g, v.x - 0.5, v.y - 0.5, v.w + 1, v.h + 1, v.r)
    g.strokeStyle = 'rgba(255, 255, 255, 0.14)'
    g.lineWidth = 1.5
    g.stroke()
    if (L.footer) {
      // The icon, "GitDesk" in bold, then the rest in a lighter tone, centred as one line.
      const { y, size } = L.footer
      const name = 'GitDesk'
      const rest = '  ·  free and open source'
      const width = (text, font) => {
        g.font = font
        return g.measureText(text).width
      }
      const nameW = width(name, `700 ${size}px ${FONT}`)
      const restW = width(rest, `400 ${size * 0.8}px ${FONT}`)
      const t = size * 1.5
      const total = t + 14 + nameW + restW
      let x = (L.w - total) / 2
      g.drawImage(tile, x, y - t / 2, t, t)
      x += t + 14
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      g.font = `700 ${size}px ${FONT}`
      g.fillStyle = INK
      g.fillText(name, x, y + 1)
      g.font = `400 ${size * 0.8}px ${FONT}`
      g.fillStyle = MUTED
      g.fillText(rest, x + nameW, y + 2)
    }
    return done(c)
  }

  const s = L.cardScale
  const cx = L.w / 2
  if (job.kind === 'intro') {
    const t = 168 * s
    g.drawImage(tile, cx - t / 2, L.h * 0.5 - 250 * s, t, t)
    text(g, 'GitDesk', cx, L.h * 0.5 + 40 * s, 118 * s, 700, INK, L.w)
    const tagline =
      L.w < 1200
        ? 'Every repository, branch and\ncoding agent in one window.'
        : 'Every repository, branch and coding agent in one window.'
    text(g, tagline, cx, L.h * 0.5 + 150 * s, 38 * s, 400, MUTED, L.cardWidth)
    return done(c)
  }
  // outro
  const t = 140 * s
  g.drawImage(tile, cx - t / 2, L.h * 0.5 - 300 * s, t, t)
  text(g, 'GitDesk', cx, L.h * 0.5 - 50 * s, 104 * s, 700, INK, L.w)
  text(g, 'Free and open source', cx, L.h * 0.5 + 45 * s, 44 * s, 600, INK, L.cardWidth)
  text(g, 'Windows · macOS · Linux', cx, L.h * 0.5 + 110 * s, 32 * s, 400, MUTED, L.cardWidth)
  text(g, 'github.com/TheliosGroupe/GitDesk', cx, L.h * 0.5 + 200 * s, 36 * s, 600, ACCENT, L.w)
  return done(c)
}

app
  .whenReady()
  .then(main)
  .catch((e) => {
    console.error(e)
    app.exit(1)
  })
