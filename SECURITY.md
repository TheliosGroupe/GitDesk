# Security policy

GitDesk runs `git` on folders you add, holds tokens for your hosting accounts and, if you set it up, an AI API key. Security reports are very welcome.

## Reporting a vulnerability

Please report vulnerabilities **privately**, through GitHub Security Advisories:

1. Open <https://github.com/TheliosGroupe/GitDesk/security/advisories/new> (or the repository's **Security** tab → **Report a vulnerability**).
2. Describe what an attacker controls (a repository you clone or open, a remote, a hosting service answer, a file name…), what happens, and the steps or a small fixture that shows it. Say which GitDesk version, operating system and `git --version` you used: **Settings → Updates → Copy diagnostics** copies all three.

Do not open a public issue, pull request or discussion for a vulnerability, and do not include working exploits against other people's repositories or accounts. If the advisory form is not available, open an issue that only asks for a private contact, with no details.

What to expect:

- an acknowledgement of your report, usually within a week;
- a fix in a new release when the report is confirmed, then a published advisory that credits you (unless you prefer not to be named);
- if the report is not considered a vulnerability, an explanation of why.

Please give us a reasonable time to ship a fix before you disclose anything publicly.

## Supported versions

| Version                                                                        | Security fixes |
| ------------------------------------------------------------------------------ | -------------- |
| The [latest release](https://github.com/TheliosGroupe/GitDesk/releases/latest) | Yes            |
| Older releases                                                                 | No: update     |
| Unreleased code on `main` (built from source)                                  | Best effort    |

GitDesk updates itself on Windows and Linux (see [Builds and updates](#builds-and-updates)). On macOS it cannot yet: when GitDesk says a new version is available, download its `.dmg` from the release page and replace the app in Applications (your settings and accounts are kept).

## Security model

What GitDesk protects, in short. The [README](README.md#security) has the user-facing details, and [CONTRIBUTING.md](CONTRIBUTING.md#security-sensitive-areas) lists the code and the tests for each part.

### The window

- The renderer is sandboxed: `contextIsolation`, `sandbox`, no Node.js integration. It is served from `app://gitdesk` with a strict Content Security Policy, cannot navigate anywhere else (https links open in your browser) and cannot open other windows.
- Web permissions (camera, microphone, location, notifications…) are denied; only the clipboard is allowed.
- Packaged builds have hardened Electron fuses: `NODE_OPTIONS` and inspector flags are ignored, the app only loads from its `app.asar` (whose integrity is checked on Windows and macOS), and `file://` gets no extra rights. (`ELECTRON_RUN_AS_NODE` stays available: the terminal library needs it on Windows.)
- Text that comes from repositories (file contents, names, branch names, commit messages, AI answers) is never interpreted as HTML: it is rendered as text, and syntax highlighting escapes it. Bidirectional controls and invisible characters (Trojan Source) are shown as visible markers, with a warning above code that contains them.

### The IPC bridge

- The renderer can only call the functions listed in `src/shared/api.ts` and `src/shared/features/*.ts`, and the bridge only answers GitDesk's own top-level page.
- The main process checks every argument: only registered repositories are accepted; paths must stay inside the working copy and out of `.git` (also through symlinks, junctions and Windows short names); refs, shas and branch names are validated before git sees them.
- git always runs through `spawn` with an argument array (no shell), found once by its full path (a `git.exe` inside a repository is never run). Paths from the UI are passed as literal pathspecs.
- Answers from hosting services, issue trackers and AI providers are type-checked and size-limited before they reach the UI.

### Repository trust

A repository's own configuration can run programs (hooks, `core.fsmonitor`, filters, diff and merge drivers, `core.sshCommand`, credential helpers…) or send git elsewhere (proxies, `insteadOf`, TLS settings, a remote's `uploadpack`). GitDesk trusts the repositories it cloned or created. Any other repository is first inspected by reading its files, without running git, and until you trust it:

- settings that would run a program are replaced, on every git command, by your own (system and global) value or a harmless one;
- settings that change how git connects make fetch, pull and push refuse to run, and no credentials are given;
- a repository whose files point to another computer (UNC paths in `.git` files, `alternates`, includes, worktrees) or that cannot be fully checked is not opened at all.

Whatever the trust, diffs, logs and blame never run textconv or external diff programs, and `core.worktree` cannot move the working copy outside the folder you added.

### Credentials

- Account tokens and AI API keys are encrypted with the operating system's key store (Electron `safeStorage`) and never reach the renderer. On Linux this needs a running keyring (GNOME Keyring, KWallet…): without one, Electron falls back to a built-in key that only hides them, so GitDesk refuses to save tokens and keys.
- git gets an account's token through a one-shot credential helper that reads it from an environment variable and answers only over https, only for that account's host. The token never appears on a command line, in a remote URL or in a config file. Commits run without it, so hooks do not see it.
- An AI key is only sent to the base URL it was saved for. Files that look like secrets (`.env`, private keys, credential files, token-shaped content) are never sent to an AI provider.
- API calls and picture downloads never follow redirects outside the service's own address, have time and size limits, and pictures from other hosts are only fetched over https from public addresses.

### Builds and updates

- **Release builds are not code-signed yet.** Windows SmartScreen and macOS Gatekeeper warn on first launch; the README's [First launch](README.md#first-launch) section shows how to open GitDesk anyway (on macOS 15 and later: System Settings → Privacy & Security → **Open Anyway**). Do that only for files from this repository's releases. Each release lists the SHA-256 of every file in `SHA256SUMS.txt` and carries a build-provenance attestation: `gh attestation verify <file> --repo TheliosGroupe/GitDesk` proves a file was built by this repository's release workflow from the tagged commit.
- Releases are built by GitHub Actions from a tag, only after formatting, typecheck, lint and the unit tests pass on that commit on Windows, macOS and Linux: the jobs that install dependencies and build get a read-only token, actions are pinned to commit SHAs, and only the publishing job, which runs no project code and waits for the protected `release` environment, can write to the release.
- On Windows and Linux, an update is downloaded in the background and installed only when you click **Restart to install**. Without a code signature, the only check on the download is the SHA-512 listed in the same GitHub release, so the update is as trustworthy as this repository's releases. macOS cannot install unsigned updates: GitDesk opens the release page instead. Settings → Updates turns update checks off.
- Signed builds (Authenticode on Windows, Developer ID and notarization on macOS) are planned. With them, the updater can also check the publisher's signature of each update.

## Out of scope

- What you choose to run: commands typed in the built-in terminal, coding agents you start, the programs of a repository after you click **Trust this repository…**, and your own git hooks and global git configuration.
- A compromised computer, user account, `git` installation or `PATH`.
- The behaviour of the hosting services, issue trackers and AI providers you connect, and the data you choose to send them.
- Builds that were not downloaded from this repository's releases, or that were changed after download.
