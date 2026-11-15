# Contributing to GitDesk

Thanks for helping. Bug reports and small, focused pull requests are welcome. GitDesk is MIT-licensed: by contributing, you agree that your contribution is published under the same [license](LICENSE).

## Set up

You need:

- **Node.js 22.12 or later** (`.nvmrc` names Node 22: `nvm use` or `fnm use` picks it; Electron and Vite need 22.12 at least);
- **git 2.30 or later**, with `user.name` and `user.email` configured (the tests commit in throwaway repositories);
- on **Linux**, the build tools of `node-pty`, the terminal's native module: `python3`, `make` and a C++ compiler (`sudo apt install build-essential python3` on Debian and Ubuntu). Windows and macOS use the prebuilt binaries `node-pty` ships.

```sh
git clone https://github.com/TheliosGroupe/GitDesk.git
cd GitDesk
npm ci        # also downloads the Electron binary (postinstall)
npm run dev   # app with hot reload; F12 opens DevTools
```

On Windows, run `git config --global core.autocrlf false` before cloning (see [Code style](#code-style)).

## Check your change

```sh
npm run typecheck          # TypeScript, main + renderer
npm run lint               # ESLint (Prettier formatting of the code included)
npm run format:check       # Prettier on every file (code, Markdown, YAML, JSON); `npm run format` fixes it
npm test                   # unit tests (Vitest), tests/unit/
npm run notices            # writes build/THIRD_PARTY_NOTICES.txt, the licenses shipped with the app (gitignored; also part of `npm run build`)
npm run test:e2e           # builds the app and drives it with Playwright, tests/e2e*.mjs
npm run test:e2e:github    # needs network: clones octocat/Hello-World, checks avatars and the sign-in error path
```

**CI** ([`ci.yml`](.github/workflows/ci.yml)) runs on every pull request and every push to `main`, on **Windows, macOS and Linux**: `npm ci`, a check that the terminal's native module loads and starts a shell, then the Prettier check, typecheck, lint, the unit tests and `npm run notices`. The end-to-end suites need a desktop session, so they run on the Windows runner only; run them yourself on macOS or Linux when you change something specific to those systems. On failure, the e2e screenshots are attached to the run.

- **Unit tests** cover the pure libraries (`src/renderer/src/lib/*`: commit graph layout, diff parsing, formatting, activity charts) and much of the main process, on temporary repositories (git operations, refresh, sync, the watcher, repository trust, hosting clients against a local fake server). Add one to `tests/unit/*.test.ts` when you change them; they never touch anything outside a temp folder and never use the network.
- **The e2e test** creates a throwaway repository and runs the real app with its own settings folder (`GITDESK_USER_DATA`), so it never touches your repository list. `tests/e2e.mjs` covers the core flows, `tests/e2e-features.mjs` Home and the tab bar, the terminal, worktrees, agent sessions, git extras, AI and hosting features (AI and GitLab are answered by a fake server in the test, so no network or key is needed), `tests/e2e-layout.mjs` the panels and splitters, and `tests/e2e-security.mjs` repository trust, the window's hardening and how hidden Unicode characters are shown (its fixtures only append to a marker file in the test's temp folder). `tests/e2e-features.mjs` also checks that very large changes stay usable (a 60,000-line diff, 5,000 new files, a conflicted file over 5 MB). It needs `git` with a configured `user.name` and `user.email`, and `node` on `PATH` (the fake coding agent). Screenshots land in `test-results/`.

## How it is built

The renderer is sandboxed (`contextIsolation`, `sandbox`, no Node access); it can only call the functions listed in `src/shared/api.ts`. Git always runs through `spawn` with an argument array (no shell), and every path or ref coming from the UI is validated in the main process.

| Folder                                            | Role                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/git.ts`                                 | Runs `git` (found once by its full path), with read-only commands set to never take locks, idle timeouts and cancel for network commands, and each repository's trust policy                                                                                                                                          |
| `src/main/repo.ts`                                | Every git operation and its output parser (`log`, `status --porcelain=v2`, `blame --porcelain`, interactive rebase…)                                                                                                                                                                                                  |
| `src/main/ipc.ts`                                 | Exposes those operations to the UI; only registered repositories are accepted, and writes to the same repository are queued. Pushes follow your push settings (`pushRemote`, `push.default`, `remote.<name>.push`); force pushes and remote deletes are leased on what you saw                                        |
| `src/main/paths.ts`                               | Checks paths from the UI (in the working copy and out of .git, also through symlinks, junctions and Windows short names) before git reads, writes or deletes them; binary and encoding detection; the system editor opens only documents (programs, executables, bundles and links to them are shown in their folder) |
| `src/main/undo.ts`                                | Records the last undoable action per repository and reverts it safely                                                                                                                                                                                                                                                 |
| `src/main/sync.ts`                                | Fetching: background sync of followed repositories, and _Sync_                                                                                                                                                                                                                                                        |
| `src/main/updater.ts`                             | Updates from GitHub Releases, installed only when you click Restart to install                                                                                                                                                                                                                                        |
| `src/main/trust/`                                 | Repository trust: inspection of a repository's own settings, the overrides git gets until you trust it, the trust records                                                                                                                                                                                             |
| `src/main/store.ts`                               | Repository list, open tabs, settings, in the app's user-data folder (`gitdesk.json`), written atomically; a damaged file is kept aside                                                                                                                                                                                |
| `src/main/github.ts`, `accounts.ts`, `avatars.ts` | GitHub device flow and REST calls, encrypted tokens, profile pictures                                                                                                                                                                                                                                                 |
| `src/main/hosting/`                               | GitHub, GitLab, Bitbucket and Azure DevOps clients, pull requests, issues (incl. Jira, Linear), Launchpad, organization clones                                                                                                                                                                                        |
| `src/main/terminal/`                              | Built-in terminal (node-pty), worktrees, coding-agent sessions (safe command lines on every OS)                                                                                                                                                                                                                       |
| `src/main/gitextras/`                             | Compare, line history, Gitflow, conflict warnings, patches                                                                                                                                                                                                                                                            |
| `src/main/ai/`                                    | AI providers, prompts with size limits, commit composer                                                                                                                                                                                                                                                               |
| `src/main/activity.ts`                            | Activity dashboard data                                                                                                                                                                                                                                                                                               |
| `src/main/watcher.ts`                             | Watches open repositories in a worker thread (also the git folders of linked worktrees), skips what git ignores, and notifies the UI                                                                                                                                                                                  |
| `src/shared/api.ts`, `src/shared/features/`       | The typed API shared by main, preload and renderer: the core, plus one contract per feature area                                                                                                                                                                                                                      |
| `src/renderer/src/components/`                    | Dashboard, repository view, commit graph, diff and conflict views, dialogs                                                                                                                                                                                                                                            |
| `src/renderer/src/lib/`                           | Pure helpers: graph layout, diff parsing and line patches, conflict parsing, syntax highlighting, rebase plans, activity stats, .gitignore escaping                                                                                                                                                                   |

The main process (`src/main`) runs git and owns all state, the renderer (`src/renderer`) is the React UI, and `src/shared/api.ts` is the typed bridge between them. Any new git operation goes in `src/main/repo.ts`, gets an IPC method in `src/shared/api.ts` + `src/main/ipc.ts`, and is called from the UI through `window.api`.

## Security-sensitive areas

Some code decides what a repository, a server or the renderer can make GitDesk do. A change there needs a test that shows the protection still holds, and a mention in the pull request. Vulnerabilities themselves are reported privately: see [SECURITY.md](SECURITY.md).

| Area                                                                                                                                 | Code                                                                                                                                       | Tests                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Repository trust: which settings are risky, the overrides git gets, repositories git must not run in                                 | `src/main/trust/` (`rules.ts`, `inspect.ts`, `policy.ts`), `src/main/git.ts`                                                               | `tests/unit/trust-*.test.ts`, `tests/e2e-security.mjs`                                                       |
| Running git: found by its full path, argument arrays only, literal pathspecs, no locks for reads, timeouts                           | `src/main/git.ts`, `src/main/repo.ts`                                                                                                      | `trust-git.test.ts`, `repo-ops-git.test.ts`, `refresh-repo.test.ts`                                          |
| Paths and refs from the UI: inside the working copy, out of `.git`, through symlinks and junctions; files that would run when opened | `src/main/paths.ts`, `src/main/ipc.ts`, `src/main/trust/worktree.ts`, `src/main/terminal/worktrees.ts`                                     | `paths.test.ts`, `repo-ops-paths.test.ts`, `repo-ops-git.test.ts`                                            |
| The window: navigation, new windows, permissions, which pages the IPC bridge answers, CSP and Electron fuses                         | `src/main/index.ts`, `src/main/ipcGuard.ts`, `src/preload/`, `electron-builder.yml`, `src/renderer/index.html`                             | `shell-guard.test.ts`, `shell-config.test.ts`, `tests/e2e-security.mjs`                                      |
| Credentials: encrypted tokens, the one-shot credential helper, which host gets which token                                           | `src/main/accounts.ts`, `src/main/git.ts`, `src/main/hosting/context.ts`                                                                   | `hosting-credentials.test.ts`, `hosting-stores.test.ts`, `hosting-remote.test.ts`                            |
| Network answers: redirects, public addresses for pictures, time and size limits, type checks of every hosting, tracker and AI answer | `src/main/safeFetch.ts`, `src/main/netFetch.ts`, `src/main/hosting/http.ts`, `src/main/hosting/validate.ts`, `src/main/hosting/providers/` | `safe-fetch.test.ts`, `hosting-validate.test.ts`, `hosting-clients.test.ts`                                  |
| AI: keys bound to their base URL, secret files never sent, prompt size limits, model output parsed defensively                       | `src/main/ai/` (`keyBinding.ts`, `secrets.ts`, `prompts.ts`, `providers.ts`)                                                               | `ai-keys.test.ts`, `ai-secrets.test.ts`, `ai-prompts.test.ts`, `ai-providers.test.ts`, `ai-markdown.test.ts` |
| Terminal and agents: command lines quoted for each OS, no shell strings                                                              | `src/main/terminal/argv.ts`, `src/main/terminal/agents.ts`                                                                                 | `terminal-argv.test.ts`, `tests/e2e-features.mjs`                                                            |
| Showing repository text: bidi controls and invisible characters as markers, isolated names, no HTML from repositories                | `src/renderer/src/lib/highlight.ts`, `CodeText` in `DiffView.tsx`, `UiText` in `ui.tsx`                                                    | `rendering-hidden.test.ts`, `tests/e2e-security.mjs`                                                         |
| Updates and releases: nothing installs without the user, unsigned macOS builds do not self-install, least-privilege release workflow | `src/main/updater.ts`, `.github/workflows/release.yml`                                                                                     | `shell-updater.test.ts`, `shell-config.test.ts`                                                              |

The fixtures in these tests stay harmless: a setting or hook that "runs a program" only appends a line to a marker file in the test's own temp folder, and the only network is `127.0.0.1` or a `.invalid` name that never resolves. Keep it that way.

## Code style

- [Prettier](.prettierrc.yaml) formats everything, [ESLint](eslint.config.mjs) checks the rest. Run `npm run format` before committing, or let your editor format on save.
- LF line endings everywhere (see `.editorconfig`). On Windows, run `git config --global core.autocrlf false` before cloning, or git may convert files to CRLF and Prettier will complain.
- Keep main-process code free of shell strings: git runs through `spawn` with an argument array.

## Releases (maintainers)

1. Bump the version without tagging: `npm version 1.2.3 --no-git-tag-version` (updates `package.json` and `package-lock.json`). Commit it (`Release 1.2.3`) to `main`, directly or through a pull request, and wait until CI is green for that commit.
2. Check that the README and [SECURITY.md](SECURITY.md) describe this version (new settings, changed requirements, new network calls).
3. Tag that commit and push the tag: `git tag v1.2.3 && git push origin v1.2.3`.
4. The [_Release_ workflow](.github/workflows/release.yml) then runs:
   - **version**: checks that the tag matches the version in `package.json` (fails in seconds on a mistyped tag);
   - **verify**, on Windows, macOS and Linux: runs the Prettier check, typecheck, lint and the unit tests on the tagged commit. Nothing is drafted, built or published if it fails;
   - **draft**: creates a draft GitHub release with generated notes (a re-run reuses the draft, and stops if that version is already published);
   - **build**: builds Windows, macOS and Linux, unsigned and without any write access;
   - **publish**, in the protected `release` environment: waits for a required reviewer's approval, checks the release is still a draft, adds `SHA256SUMS.txt` and build-provenance attestations, uploads every file to the draft and publishes it.
5. While **publish** waits for approval, open the draft on the Releases page, edit its notes (what changed, known issues), then approve the deployment.
6. Install the published version on a clean machine (or ask a colleague) before announcing it. Installed copies on Windows and Linux find it at their next check (at start, then every 6 hours) and install it when the user clicks _Restart to install_; macOS users are pointed to the download page.

A release that failed before **publish** can be retried: delete its draft on the Releases page and the tag (`git push --delete origin v1.2.3 && git tag -d v1.2.3`), fix, and tag again. Never move the tag of a published release: make a new version instead.

### One-time repository setup

- **Settings → Environments → `release`**: add required reviewers, so every release needs an approval.
- **Settings → Rules → Rulesets**: a tag ruleset on `v*` that restricts who can create, update or delete those tags, and a branch ruleset on `main` that blocks force pushes and requires the three CI checks to pass.
- **Settings → Code security → Private vulnerability reporting**: enable it, so the [security policy](SECURITY.md) works.
- **Settings → Actions → General**: keep the default `GITHUB_TOKEN` permission read-only (the workflows ask for what they need).
