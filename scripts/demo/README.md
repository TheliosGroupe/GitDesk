# Demo video

The animation at the top of the [README](../../README.md) (`docs/demo.webp`) and the launch videos are recorded from the real app. `record.mjs` builds demo repositories, starts GitDesk and drives it with a visible pointer while two Claude Code agents work, and saves every frame. `edit.mjs` then cuts the videos with ffmpeg.

## What you need

- The app built: `npx electron-vite build`.
- [ffmpeg](https://ffmpeg.org/download.html) on the `PATH`, with `libx264` and `libwebp`.
- [Claude Code](https://code.claude.com/docs/en/setup) installed and signed in, and opened once in a terminal so its first-run questions are answered. The recording gives it two small tasks, which count against your Claude plan. With `DRY=1`, a stand-in agent does the work instead, for checking the script.
- A screen of at least 1440 × 900: the window is recorded at that size.

## Steps

```sh
npx electron-vite build
node scripts/demo/record.mjs           # about 2 minutes; DRY=1 for the stand-in agent
npx electron scripts/demo/cards.mjs    # captions, cards and backgrounds
node scripts/demo/edit.mjs             # the README loop and both launch videos
```

GitDesk opens a window and drives itself during `record.mjs`: don't click in it. `npx electron` starts Node instead of Electron if `ELECTRON_RUN_AS_NODE` is set (VS Code's terminal sets it): unset it first.

The videos land in `gitdesk-demo/out` in your temporary folder:

| File                         | Use                                                     |
| ---------------------------- | ------------------------------------------------------- |
| `gitdesk-demo-readme.webp`   | The README loop: copy it to `docs/demo.webp`            |
| `gitdesk-demo-readme.mp4`    | The same loop as a video, 1280 × 800                    |
| `gitdesk-demo-square.mp4`    | 1080 × 1080 with captions and opening and closing cards |
| `gitdesk-demo-landscape.mp4` | 1920 × 1080 with captions and opening and closing cards |

## Settings

- `GITDESK_DEMO_ROOT`: the folder for the demo repositories. Their path shows in the video, so pick a short one: the README demo used `C:\dev\projects`.
- `GITDESK_DEMO_WORK`: the folder for the recording, the pictures and the videos (several hundred MB). By default, `gitdesk-demo` in your temporary folder.
- [`config.mjs`](config.mjs): the captions, the cuts (which scenes, how fast, where to zoom) and the frame layouts. The scene markers come from `record.mjs`.

The scripts rebuild everything from scratch on each run. They only delete a folder they made, which holds a `.gitdesk-demo` file.

## What the video shows

The team, the code and the commits are fictional, and the demo repositories commit as "Alice Martin" so no real name appears. Their Claude Code settings turn off Remote Control, which would otherwise show a link to your claude.ai session in the agent's terminal and commits. One personal detail remains: the agent dialog shows the path of your `claude` command, which includes your user folder.
