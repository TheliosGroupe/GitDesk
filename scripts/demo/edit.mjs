// Cuts the recorded take into the demo videos with ffmpeg:
//   readme     1280 x 800 loop, no captions: readme.mp4 and an animated readme.webp
//   square     1080 x 1080 with captions and opening/closing cards (LinkedIn, X)
//   landscape  1920 x 1080 with captions and cards (YouTube, Product Hunt, X)
// Usage: node scripts/demo/edit.mjs [readme|square|landscape ...]   (default: all three)
// Needs ffmpeg (with libx264 and libwebp) on the PATH, a take (record.mjs) and the pictures
// (cards.mjs). See README.md in this folder.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ASSETS, LAUNCH, LAYOUTS, OUT, README, TAKE } from './config.mjs'

const TMP = join(TAKE, 'tmp')
const MASTER = join(TAKE, 'master.mp4')
const which = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['readme', 'square', 'landscape']
mkdirSync(OUT, { recursive: true })

const take = JSON.parse(readFileSync(join(TAKE, 'take.json'), 'utf8'))
const t0 = take.frames[0].t
const at = (name) => {
  const m = take.markers.find((x) => x.name === name)
  if (!m) throw new Error(`no marker ${name}`)
  return m.t - t0
}
const ff = (args) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: 'inherit'
  })
const H264 = [
  '-c:v',
  'libx264',
  '-crf',
  '17',
  '-preset',
  'medium',
  '-pix_fmt',
  'yuv420p',
  '-r',
  '30'
]

// 1. A constant 30 fps master, each frame held until the next one was painted.
if (!existsSync(MASTER)) {
  const f = take.frames
  const list = f
    .map(
      (x, i) =>
        `file 'frames/${x.file}'\nduration ${(i + 1 < f.length ? Math.max(0.001, f[i + 1].t - x.t) : 1).toFixed(4)}`
    )
    .join('\n')
  writeFileSync(join(TAKE, 'frames.txt'), `${list}\nfile 'frames/${f.at(-1).file}'\n`)
  ff([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    join(TAKE, 'frames.txt'),
    '-vf',
    'fps=30,format=yuv420p',
    '-c:v',
    'libx264',
    '-crf',
    '10',
    '-preset',
    'fast',
    MASTER
  ])
}

/** Where a cut starts in the master, how long it is there, and how fast it plays. */
function span(seg) {
  const a = Math.max(0, at(seg.from[0]) + seg.from[1])
  const len = at(seg.to[0]) + seg.to[1] - a
  if (len <= 0) throw new Error(`empty cut ${seg.from[0]} -> ${seg.to[0]}`)
  // Never slower than real time.
  const speed = seg.fit ? Math.max(1, len / seg.fit) : seg.speed
  return { a, len, speed, out: len / speed, badge: !!seg.badge && speed > 1.5 }
}

function card(png, seconds, file, fade) {
  const vf = ['fps=30', 'format=yuv420p']
  if (fade === 'in') vf.push('fade=t=in:st=0:d=0.45')
  if (fade === 'out') vf.push(`fade=t=out:st=${seconds - 0.4}:d=0.4`)
  ff([
    '-loop',
    '1',
    '-framerate',
    '30',
    '-t',
    String(seconds),
    '-i',
    png,
    '-vf',
    vf.join(','),
    ...H264,
    file
  ])
}

function join_(files, out) {
  const list = join(TMP, `${Date.now()}.txt`)
  writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'))
  ff(['-f', 'concat', '-safe', '0', '-i', list, ...H264, '-movflags', '+faststart', out])
}

function launchCut(name) {
  const L = LAYOUTS[name]
  const v = L.video
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const files = []
  const intro = join(TMP, '00-intro.mp4')
  card(join(ASSETS, `${name}-intro.png`), 2.6, intro, 'out')
  files.push(intro)
  let total = 2.6
  LAUNCH.forEach((seg, i) => {
    const s = span(seg)
    const file = join(TMP, `${String(i + 1).padStart(2, '0')}.mp4`)
    const inputs = ['-ss', s.a.toFixed(3), '-t', s.len.toFixed(3), '-i', MASTER]
    inputs.push(
      '-i',
      join(ASSETS, `${name}-bg.png`),
      '-i',
      join(ASSETS, `${name}-cap-${seg.cap}.png`)
    )
    const z = seg.zoom ? `crop=${seg.zoom.w}:${seg.zoom.h}:${seg.zoom.x}:${seg.zoom.y},` : ''
    let fc =
      `[0:v]setpts=(PTS-STARTPTS)/${s.speed.toFixed(4)},fps=30,${z}scale=${v.w}:${v.h}:flags=lanczos,` +
      `pad=${L.w}:${L.h}:${v.x}:${v.y}:color=black[a];[a][1:v]overlay=0:0[b];[b][2:v]overlay=0:${L.capY}[c]`
    let last = '[c]'
    if (s.badge) {
      inputs.push('-i', join(ASSETS, 'badge.png'))
      fc += `;[c][3:v]overlay=${v.x + v.w - 176 - 18}:${v.y + v.h - 46 - 18}[d]`
      last = '[d]'
    }
    ff([...inputs, '-filter_complex', fc, '-map', last, '-t', s.out.toFixed(3), ...H264, file])
    files.push(file)
    total += s.out
    console.log(
      `  ${name} ${String(i + 1).padStart(2)}  ${seg.cap.padEnd(10)} ${s.len.toFixed(1).padStart(5)}s at ${s.speed.toFixed(2)}x = ${s.out.toFixed(1)}s`
    )
  })
  const outro = join(TMP, '99-outro.mp4')
  card(join(ASSETS, `${name}-outro.png`), 4.2, outro, 'in')
  files.push(outro)
  total += 4.2
  const out = join(OUT, `gitdesk-demo-${name}.mp4`)
  join_(files, out)
  console.log(`${out}  ${total.toFixed(1)}s  ${(statSync(out).size / 1e6).toFixed(1)} MB`)
}

function readmeCut() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const files = []
  let total = 0
  README.forEach((seg, i) => {
    const s = span(seg)
    const file = join(TMP, `${String(i + 1).padStart(2, '0')}.mp4`)
    const inputs = ['-ss', s.a.toFixed(3), '-t', s.len.toFixed(3), '-i', MASTER]
    let fc = `[0:v]setpts=(PTS-STARTPTS)/${s.speed.toFixed(4)},fps=30,scale=1280:800:flags=lanczos[a]`
    let last = '[a]'
    if (s.badge) {
      inputs.push('-i', join(ASSETS, 'badge.png'))
      fc += `;[a][1:v]overlay=${1280 - 176 - 20}:${800 - 46 - 20}[b]`
      last = '[b]'
    }
    ff([...inputs, '-filter_complex', fc, '-map', last, '-t', s.out.toFixed(3), ...H264, file])
    files.push(file)
    total += s.out
    console.log(
      `  readme ${String(i + 1).padStart(2)} ${s.len.toFixed(1).padStart(5)}s at ${s.speed.toFixed(2)}x = ${s.out.toFixed(1)}s`
    )
  })
  const mp4 = join(OUT, 'gitdesk-demo-readme.mp4')
  join_(files, mp4)
  const webp = join(OUT, 'gitdesk-demo-readme.webp')
  ff([
    '-i',
    mp4,
    '-vf',
    'fps=12,scale=1100:-1:flags=lanczos',
    '-c:v',
    'libwebp_anim',
    '-loop',
    '0',
    '-lossless',
    '0',
    '-quality',
    '68',
    '-compression_level',
    '6',
    webp
  ])
  console.log(`${mp4}  ${total.toFixed(1)}s  ${(statSync(mp4).size / 1e6).toFixed(1)} MB`)
  console.log(`${webp}  ${(statSync(webp).size / 1e6).toFixed(1)} MB`)
}

for (const w of which) {
  if (w === 'readme') readmeCut()
  else launchCut(w)
}
