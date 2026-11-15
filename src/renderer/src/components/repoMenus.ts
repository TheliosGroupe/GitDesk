// Context menus of the repository view (commits, branches, tags, stashes, pull, branch drops,
// the toolbar's "…" menu).

import type { Commit, PullMode, RefsInfo, Stash, WorkingStatus } from '../../../shared/types'
import type { DraggedBranch } from '../lib/branchDrag'
import { shortSha } from '../lib/format'
import type { RefLabel } from './CommitGraph'
import type { ExplainTarget } from './shell/RepoDialogs'
import type { Act } from './SidePanels'
import type { MenuItem } from './ui'
import type { Dialogs } from './ui-context'
import { isolateText } from '../lib/highlight'

/** What "Export as patch" saves: one commit, or the staged / unstaged changes. */
export type PatchSpec = { kind: 'commit'; sha: string } | { kind: 'working'; staged: boolean }

export interface MenuContext {
  repo: string
  refs: RefsInfo
  status: WorkingStatus
  /** "owner/repo" when origin is on GitHub. */
  github: string | null
  act: Act
  dialogs: Dialogs
  createBranch(startPoint: string | null): void
  checkoutLabel(label: RefLabel): void
  deleteBranch(name: string): void
  openRebase(base: string, baseLabel: string): void
  /** An AI provider is configured: show the AI entries. */
  ai: boolean
  hasChanges: boolean
  /** Opens the compare view (`from` → `to`). */
  compare(from: string, to: string): void
  explain(target: ExplainTarget): void
  /** Starts a coding agent in a new worktree, from `baseRef` (null = HEAD). */
  startAgent(baseRef: string | null): void
  createPullRequest(branch: string): void
  compose(): void
  exportPatch(spec: PatchSpec): void
  applyPatchFile(): void
}

/** "Compare with <current>", "Start agent from here…" and "Explain this branch (AI)" of a ref. */
function refExtras(ctx: MenuContext, label: RefLabel, branch: boolean): MenuItem[] {
  const current = ctx.status.branch
  const items: MenuItem[] = [
    {
      label: `Compare with ${isolateText(current ?? 'HEAD')}`,
      disabled: !!label.current,
      onClick: () => ctx.compare(current ?? 'HEAD', label.name)
    },
    { label: 'Start agent from here…', onClick: () => ctx.startAgent(label.name) }
  ]
  if (ctx.ai && branch)
    items.push({
      label: 'Explain this branch (AI)',
      onClick: () =>
        ctx.explain({
          kind: 'branch',
          branch: label.name,
          base: current && current !== label.name ? current : null
        })
    })
  return items
}

function pullRequestItem(ctx: MenuContext, branch: string | null): MenuItem[] {
  return branch && ctx.refs.remotes.length
    ? [{ label: 'Create pull request…', onClick: () => ctx.createPullRequest(branch) }]
    : []
}

/** "Rebase <current> onto <x>" and "Interactive rebase onto <x>…". */
function rebaseItems(
  ctx: MenuContext,
  onto: string,
  ontoLabel: string,
  disabled: boolean
): MenuItem[] {
  const current = ctx.status.branch
  return [
    {
      label: `Rebase ${isolateText(current ?? 'HEAD')} onto ${isolateText(ontoLabel)}`,
      disabled: disabled || !current,
      onClick: () =>
        ctx.act(
          'Rebasing',
          () => window.api.rebase(ctx.repo, onto),
          `Rebased ${isolateText(current ?? 'HEAD')} onto ${isolateText(ontoLabel)}`
        )
    },
    {
      label: `Interactive rebase onto ${isolateText(ontoLabel)}…`,
      disabled: disabled || !current,
      onClick: () => ctx.openRebase(onto, ontoLabel)
    }
  ]
}

export function commitMenu(ctx: MenuContext, c: Commit): MenuItem[] {
  const { repo, act, dialogs } = ctx
  const target = ctx.status.branch ?? 'HEAD'
  const isHead = c.sha === ctx.status.headSha
  const reset = (mode: 'soft' | 'mixed' | 'hard') => () =>
    act(
      'Resetting',
      () => window.api.reset(repo, c.sha, mode),
      `${isolateText(target)} reset to ${shortSha(c.sha)}`
    )
  return [
    { label: 'Create branch here…', onClick: () => ctx.createBranch(c.sha) },
    {
      label: 'Check out this commit',
      hint: 'detached HEAD',
      onClick: () => act('Checking out', () => window.api.checkout(repo, c.sha))
    },
    'separator',
    {
      label: 'Cherry-pick onto current branch',
      disabled: isHead,
      onClick: () =>
        act('Cherry-picking', () => window.api.cherryPick(repo, c.sha), 'Cherry-picked')
    },
    {
      label: 'Revert this commit',
      onClick: () => act('Reverting', () => window.api.revert(repo, c.sha), 'Reverted')
    },
    'separator',
    {
      label: `Rebase ${isolateText(target)} onto this commit`,
      disabled: isHead || !ctx.status.branch,
      onClick: () =>
        act(
          'Rebasing',
          () => window.api.rebase(repo, c.sha),
          `Rebased ${isolateText(target)} onto ${shortSha(c.sha)}`
        )
    },
    {
      label: 'Interactive rebase from here…',
      hint: 'edit the commits after this one',
      disabled: isHead || !ctx.status.branch,
      onClick: () => ctx.openRebase(c.sha, `commit ${shortSha(c.sha)}`)
    },
    'separator',
    {
      label: `Reset ${isolateText(target)} here — soft`,
      hint: 'keep changes staged',
      onClick: reset('soft')
    },
    {
      label: `Reset ${isolateText(target)} here — mixed`,
      hint: 'keep changes unstaged',
      onClick: reset('mixed')
    },
    {
      label: `Reset ${isolateText(target)} here — hard`,
      hint: 'discard changes',
      danger: true,
      onClick: async () => {
        const ok = await dialogs.confirm({
          title: `Hard reset ${isolateText(target)} to ${shortSha(c.sha)}?`,
          message: 'All uncommitted changes will be lost.',
          okLabel: 'Reset hard',
          danger: true
        })
        if (ok) reset('hard')()
      }
    },
    'separator',
    {
      label: 'Compare with HEAD',
      disabled: isHead,
      onClick: () => ctx.compare(c.sha, 'HEAD')
    },
    { label: 'Export as patch…', onClick: () => ctx.exportPatch({ kind: 'commit', sha: c.sha }) },
    { label: 'Start agent from here…', onClick: () => ctx.startAgent(c.sha) },
    ...(ctx.ai
      ? [
          {
            label: 'Explain this commit (AI)',
            onClick: () => ctx.explain({ kind: 'commit', sha: c.sha })
          }
        ]
      : []),
    'separator',
    {
      label: 'Create tag here…',
      onClick: async () => {
        const name = await dialogs.prompt({
          title: 'Create a tag',
          label: `On commit ${shortSha(c.sha)}`,
          placeholder: 'v1.0.0',
          okLabel: 'Create tag'
        })
        if (name) act('Tagging', () => window.api.createTag(repo, name, c.sha), `Tagged ${name}`)
      }
    },
    { label: 'Copy commit SHA', onClick: () => navigator.clipboard.writeText(c.sha) },
    {
      label: 'Copy commit message',
      onClick: async () => {
        try {
          const d = await window.api.commitDetails(repo, c.sha)
          await navigator.clipboard.writeText(d.body ? `${d.subject}\n\n${d.body}` : d.subject)
        } catch {
          await navigator.clipboard.writeText(c.subject)
        }
      }
    }
  ]
}

export function refMenu(ctx: MenuContext, label: RefLabel): MenuItem[] {
  const { repo, act, dialogs, refs } = ctx
  const current = ctx.status.branch
  const copy: MenuItem = {
    label: 'Copy name',
    onClick: () => navigator.clipboard.writeText(label.name)
  }
  const mergeItem: MenuItem = {
    label: `Merge ${isolateText(label.name)} into ${isolateText(current ?? 'HEAD')}`,
    disabled: label.current || !current,
    onClick: () => act('Merging', () => window.api.merge(repo, label.name), `Merged ${label.name}`)
  }

  if (label.kind === 'local') {
    return [
      {
        label: `Check out ${isolateText(label.name)}`,
        disabled: label.current,
        onClick: () => ctx.checkoutLabel(label)
      },
      mergeItem,
      ...rebaseItems(ctx, label.name, label.name, !!label.current),
      'separator',
      ...(label.current
        ? [
            {
              label: 'Push',
              onClick: () => act('Pushing', () => window.api.push(repo, false), 'Pushed')
            }
          ]
        : []),
      ...pullRequestItem(ctx, label.name),
      {
        label: 'Rename…',
        onClick: async () => {
          const to = await dialogs.prompt({
            title: `Rename ${isolateText(label.name)}`,
            initial: label.name,
            okLabel: 'Rename'
          })
          if (to && to !== label.name)
            act('Renaming', () => window.api.renameBranch(repo, label.name, to))
        }
      },
      {
        label: 'Delete branch…',
        danger: true,
        disabled: label.current,
        onClick: () => ctx.deleteBranch(label.name)
      },
      'separator',
      ...refExtras(ctx, label, true),
      'separator',
      copy
    ]
  }

  if (label.kind === 'remote') {
    const remoteBranch = refs.remoteBranches.find((rb) => rb.fullName === label.name)
    return [
      { label: `Check out ${isolateText(label.name)}`, onClick: () => ctx.checkoutLabel(label) },
      mergeItem,
      ...rebaseItems(ctx, label.name, label.name, false),
      'separator',
      ...pullRequestItem(ctx, remoteBranch?.name ?? null),
      {
        label: 'Delete on remote…',
        danger: true,
        onClick: async () => {
          const ok = await dialogs.confirm({
            title: `Delete ${isolateText(label.name)} on the remote?`,
            message: 'The branch is removed from the remote for everyone. Local branches are kept.',
            okLabel: 'Delete on remote',
            danger: true
          })
          if (ok)
            act(
              'Deleting remote branch',
              // Only while it still holds what the user sees here.
              () => window.api.deleteRemoteBranch(repo, label.name, remoteBranch?.sha),
              `Deleted ${isolateText(label.name)}`
            )
        }
      },
      'separator',
      ...refExtras(ctx, label, true),
      'separator',
      copy
    ]
  }

  if (label.kind === 'tag') {
    const hasRemote = refs.remotes.length > 0
    const deleteTag = (remoteToo: boolean) => async () => {
      const ok = await dialogs.confirm({
        title: remoteToo
          ? `Delete tag ${isolateText(label.name)} here and on the remote?`
          : `Delete tag ${isolateText(label.name)}?`,
        message: remoteToo
          ? 'The tag is removed from your repository and from the remote, for everyone.'
          : hasRemote
            ? 'Only your local tag is deleted; the remote keeps its copy.'
            : undefined,
        okLabel: 'Delete',
        danger: true
      })
      if (!ok) return
      act(
        'Deleting tag',
        async () => {
          await window.api.deleteTag(repo, label.name)
          if (remoteToo) await window.api.deleteRemoteTag(repo, label.name)
        },
        remoteToo
          ? `Deleted ${isolateText(label.name)} here and on the remote`
          : `Deleted ${isolateText(label.name)}`
      )
    }
    return [
      {
        label: `Check out tag ${isolateText(label.name)}`,
        onClick: () => ctx.checkoutLabel(label)
      },
      {
        label: 'Push tag to remote',
        disabled: !hasRemote,
        onClick: () =>
          act('Pushing tag', () => window.api.pushTag(repo, label.name), `Pushed ${label.name}`)
      },
      'separator',
      {
        label: 'Delete tag…',
        hint: hasRemote ? 'local only' : undefined,
        danger: true,
        onClick: deleteTag(false)
      },
      ...(hasRemote
        ? [{ label: 'Delete tag here and on remote…', danger: true, onClick: deleteTag(true) }]
        : []),
      'separator',
      ...refExtras(ctx, label, false),
      'separator',
      copy
    ]
  }
  return [copy]
}

export function stashMenu(ctx: MenuContext, s: Stash): MenuItem[] {
  const { repo, act, dialogs } = ctx
  return [
    {
      label: 'Apply stash',
      hint: 'double-click',
      onClick: () =>
        act(
          'Applying stash',
          () => window.api.stashApply(repo, s.index, false, s.sha),
          'Stash applied'
        )
    },
    {
      label: 'Pop stash',
      hint: 'apply and delete',
      onClick: () =>
        act(
          'Popping stash',
          () => window.api.stashApply(repo, s.index, true, s.sha),
          'Stash popped'
        )
    },
    {
      label: 'Delete stash…',
      danger: true,
      onClick: async () => {
        if (
          await dialogs.confirm({
            title: `Delete ${isolateText(s.ref)}?`,
            message: s.message,
            okLabel: 'Delete',
            danger: true
          })
        )
          act('Deleting stash', () => window.api.stashDrop(repo, s.index, s.sha))
      }
    }
  ]
}

export function pullMenu(ctx: MenuContext): MenuItem[] {
  const { repo, act, dialogs } = ctx
  const pull = (mode: PullMode, text: string) => () =>
    act('Pulling', () => window.api.pull(repo, mode), text)
  return [
    { label: 'Pull (fast-forward only)', hint: 'default', onClick: pull('ff-only', 'Pulled') },
    { label: 'Pull (merge if needed)', onClick: pull('merge', 'Pulled') },
    { label: 'Pull (rebase)', onClick: pull('rebase', 'Pulled with rebase') },
    'separator',
    {
      label: 'Force push…',
      danger: true,
      hint: 'with lease',
      onClick: async () => {
        // The remote branches as shown now: the push is refused if its target holds
        // anything else (main finds the target from the push settings).
        const seen = Object.fromEntries(ctx.refs.remoteBranches.map((rb) => [rb.fullName, rb.sha]))
        const ok = await dialogs.confirm({
          title: `Force push ${isolateText(ctx.status.branch ?? 'HEAD')}?`,
          message:
            'This overwrites the branch it pushes to on the remote. It is refused if that ' +
            'branch changed since GitDesk last showed it (fetch first to see the latest).',
          okLabel: 'Force push',
          danger: true
        })
        if (ok) act('Force pushing', () => window.api.push(repo, true, seen), 'Force pushed')
      }
    }
  ]
}

/** A branch was dropped on the checked-out branch. */
export function dropMenu(ctx: MenuContext, dragged: DraggedBranch): MenuItem[] {
  const current = ctx.status.branch ?? 'HEAD'
  return [
    {
      label: `Merge ${isolateText(dragged.name)} into ${isolateText(current)}`,
      onClick: () =>
        ctx.act('Merging', () => window.api.merge(ctx.repo, dragged.name), `Merged ${dragged.name}`)
    },
    ...rebaseItems(ctx, dragged.name, dragged.name, false).map((item, i) =>
      i === 1 && item !== 'separator' ? { ...item, label: 'Interactive rebase…' } : item
    )
  ]
}

/** The toolbar's "…" menu. */
export function moreMenu(ctx: MenuContext): MenuItem[] {
  const { staged, unstaged } = ctx.status
  return [
    { label: 'Start agent session…', hint: 'new worktree', onClick: () => ctx.startAgent(null) },
    ...(ctx.ai
      ? [
          {
            label: 'Compose commits with AI…',
            disabled: !ctx.hasChanges,
            onClick: ctx.compose
          }
        ]
      : []),
    'separator',
    { label: 'Apply patch…', onClick: ctx.applyPatchFile },
    {
      label: 'Export staged changes as patch…',
      disabled: !staged.length,
      onClick: () => ctx.exportPatch({ kind: 'working', staged: true })
    },
    {
      label: 'Export unstaged changes as patch…',
      disabled: !unstaged.length,
      onClick: () => ctx.exportPatch({ kind: 'working', staged: false })
    }
  ]
}
