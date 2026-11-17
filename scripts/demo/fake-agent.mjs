// Stand-in coding agent for dry runs of record.mjs (DRY=1): prints progress for a few seconds,
// edits one file, commits it, then keeps running like an interactive agent. Uses no tokens.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const task = process.argv.at(-1) || ''
const email = /email/i.test(task)
console.log(`stand-in agent: ${task}`)
let n = 0
const tick = setInterval(() => console.log(`working${'.'.repeat(++n % 4)}`), 700)
setTimeout(() => {
  clearInterval(tick)
  appendFileSync(email ? 'src/pages/signup.ts' : 'src/pages/dashboard.ts', `\n// ${task}\n`)
  execFileSync('git', ['add', '-A'])
  const subject = email ? 'Validate the signup email' : 'Show when the dashboard was last updated'
  execFileSync('git', ['commit', '-qm', subject])
  console.log('committed')
  setInterval(() => {}, 1000)
}, 7000)
