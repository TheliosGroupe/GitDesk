// Shared by the demo scripts: where they work, the captions, the frame layouts and the cuts.
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Recordings, pictures and videos (hundreds of MB): outside the repository by default. */
export const WORK = process.env.GITDESK_DEMO_WORK || join(tmpdir(), 'gitdesk-demo')
/**
 * The demo repositories. Their path shows in the video (cards, dialogs, the agent's terminal):
 * the README demo was recorded with GITDESK_DEMO_ROOT=C:\dev\projects.
 */
export const DEMO_ROOT = process.env.GITDESK_DEMO_ROOT || join(WORK, 'projects')
/** Frames and scene markers of the last recording (record.mjs). */
export const TAKE = join(WORK, 'take')
/** Captions, cards and backgrounds (cards.mjs). */
export const ASSETS = join(WORK, 'assets')
/** The finished videos (edit.mjs). */
export const OUT = join(WORK, 'out')
/** File that marks a folder as made by these scripts: they delete no folder without it. */
export const MARK = '.gitdesk-demo'

export const CAPTIONS = {
  repos: 'Every repository on one page. Sync fetches them all.',
  task: 'Give a task to a coding agent.',
  worktree: 'Each agent works on its own branch, in its own worktree.',
  meanwhile: 'Keep working meanwhile: stage line by line, commit.',
  merge: 'Drag a branch to merge it. Undo anything.',
  finish: 'The agents finish on their own.',
  review: 'Review what each agent did…',
  keep: '…and merge what you keep.'
}

// The app is recorded at 1440 x 900 and shown in `video` (a 16:10 box).
export const LAYOUTS = {
  square: {
    w: 1080,
    h: 1080,
    video: { x: 40, y: 236, w: 1000, h: 625, r: 14 },
    capH: 236,
    capY: 0,
    capSize: 44,
    capWidth: 960,
    footer: { y: 968, size: 30 },
    cardScale: 1,
    cardWidth: 900
  },
  landscape: {
    w: 1920,
    h: 1080,
    video: { x: 192, y: 24, w: 1536, h: 960, r: 16 },
    capH: 96,
    capY: 984,
    capSize: 40,
    capWidth: 1800,
    footer: null,
    cardScale: 1.15,
    cardWidth: 1500
  }
}

// A cut: the recording between two scene markers (record.mjs names them; plus offsets in
// seconds), played `speed` times faster, or squeezed into `fit` seconds (never slowed down).
// `badge` shows "Sped up". `zoom`: the part of the 1440 x 900 recording to show (16:10), for
// scenes whose action is small.
const DIALOG = { x: 296, y: 182, w: 848, h: 530 }
const AGENTS = { x: 184, y: 150, w: 1200, h: 750 }
const CARDS = { x: 184, y: 40, w: 960, h: 600 }

/** The launch videos (square and landscape), each cut under its caption. */
export const LAUNCH = [
  { cap: 'repos', from: ['dashboard', -0.2], to: ['synced', 1.2], speed: 1.15 },
  {
    cap: 'task',
    from: ['agent1-dialog', -0.3],
    to: ['agent1-started', -0.2],
    speed: 1.9,
    zoom: DIALOG
  },
  {
    cap: 'task',
    from: ['agent1-started', -0.2],
    to: ['agent1-working', 0],
    fit: 2.6,
    badge: true,
    zoom: AGENTS
  },
  {
    cap: 'worktree',
    from: ['agent2-dialog', -0.3],
    to: ['agent2-started', -0.2],
    speed: 2.4,
    zoom: DIALOG
  },
  {
    cap: 'worktree',
    from: ['agent2-started', -0.2],
    to: ['agents-watch-end', 0],
    fit: 3.8,
    badge: true,
    zoom: AGENTS
  },
  { cap: 'meanwhile', from: ['repo', -0.6], to: ['committed', 0.9], speed: 1.45 },
  { cap: 'merge', from: ['committed', 0.9], to: ['undone', 1.0], speed: 1.3 },
  {
    cap: 'finish',
    from: ['agents-back', 0],
    to: ['agents-done', 2.6],
    fit: 3,
    badge: true,
    zoom: CARDS
  },
  { cap: 'review', from: ['agent1-terminal', -0.3], to: ['agent-diff', 2.6], speed: 1.35 },
  { cap: 'keep', from: ['merged-agent/email-validation', -4.6], to: ['end', 0.4], speed: 1.35 }
]

/** The README loop: no captions, the whole window. */
export const README = [
  { from: ['dashboard', -0.2], to: ['synced', 0.8], speed: 1.4 },
  { from: ['agent1-dialog', -0.3], to: ['agent1-started', 0.6], speed: 2.4 },
  { from: ['agent1-started', 0.6], to: ['agent2-dialog', 0], fit: 1.6, badge: true },
  { from: ['agent2-started', 0.3], to: ['agents-watch-end', 0], fit: 2.2, badge: true },
  { from: ['repo', -0.6], to: ['committed', 0.6], speed: 2.4 },
  { from: ['committed', 0.6], to: ['undone', 0.6], speed: 2.0 },
  { from: ['agents-back', 0], to: ['agents-done', 0.8], fit: 1.6, badge: true },
  { from: ['agent1-terminal', 1.2], to: ['agent-diff', 2.0], speed: 2.0 },
  { from: ['merged-agent/email-validation', -4.6], to: ['end', 0.3], speed: 2.0 }
]
