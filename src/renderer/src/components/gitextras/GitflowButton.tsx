import { ChevronDown, Workflow } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { GitflowConfig, GitflowKind } from '../../../../shared/features/gitextras'
import '../../assets/gitextras.css'
import { errorMessage } from '../../lib/format'
import { ContextMenu, Modal, type MenuItem, type MenuState } from '../ui'
import { useToasts } from '../ui-context'

interface Props {
  repo: string
  currentBranch: string | null
  onChanged(): void
}

const KINDS: GitflowKind[] = ['feature', 'bugfix', 'release', 'hotfix']

const KIND_HELP: Record<GitflowKind, string> = {
  feature: 'New work, branched from develop and merged back into it.',
  bugfix: 'A fix for develop, branched from develop and merged back into it.',
  release:
    'Prepares a version: from develop, merged into the production branch, tagged, then back into develop.',
  hotfix:
    'An urgent fix: from the production branch, merged into it, tagged, then back into develop.'
}

const PREFIX_FIELDS: { key: keyof GitflowConfig['prefixes']; label: string }[] = [
  { key: 'feature', label: 'Feature branches' },
  { key: 'bugfix', label: 'Bugfix branches' },
  { key: 'release', label: 'Release branches' },
  { key: 'hotfix', label: 'Hotfix branches' },
  { key: 'support', label: 'Support branches' },
  { key: 'versiontag', label: 'Version tag prefix' }
]

function capitalized(s: string): string {
  return s[0].toUpperCase() + s.slice(1)
}

/** Kind and name of a flow branch, by the configured prefixes (longest first). */
function flowOf(
  config: GitflowConfig,
  branch: string | null
): { kind: GitflowKind; name: string } | null {
  if (!branch) return null
  const kinds = KINDS.filter((k) => config.prefixes[k]).sort(
    (a, b) => config.prefixes[b].length - config.prefixes[a].length
  )
  for (const kind of kinds) {
    const p = config.prefixes[kind]
    if (branch.startsWith(p) && branch.length > p.length)
      return { kind, name: branch.slice(p.length) }
  }
  return null
}

type Dialog =
  | { kind: 'init'; config: GitflowConfig; initialized: boolean }
  | { kind: 'start'; flow: GitflowKind; config: GitflowConfig }
  | { kind: 'finish'; flow: GitflowKind; name: string; config: GitflowConfig }

function InitDialog({
  config: initial,
  initialized,
  onCancel,
  onSubmit
}: {
  config: GitflowConfig
  initialized: boolean
  onCancel(): void
  onSubmit(config: GitflowConfig): void
}): React.JSX.Element {
  const [config, setConfig] = useState(initial)
  const valid =
    config.main.trim() && config.develop.trim() && config.main.trim() !== config.develop.trim()
  return (
    <Modal title={initialized ? 'Gitflow settings' : 'Initialize Gitflow'} onClose={onCancel}>
      <form
        className="gf-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onSubmit(config)
        }}
      >
        <p className="modal-message">
          Stored in this repository&apos;s git config with the same keys as git-flow, so the
          git-flow command line works with it too.
          {!initialized && ' The develop branch is created from the production branch if needed.'}
        </p>
        <div className="gf-grid">
          <label htmlFor="gf-main">Production branch</label>
          <input
            id="gf-main"
            className="input"
            autoFocus
            value={config.main}
            onChange={(e) => setConfig({ ...config, main: e.target.value })}
          />
          <label htmlFor="gf-develop">Develop branch</label>
          <input
            id="gf-develop"
            className="input"
            value={config.develop}
            onChange={(e) => setConfig({ ...config, develop: e.target.value })}
          />
          {PREFIX_FIELDS.map(({ key, label }) => (
            <PrefixField
              key={key}
              id={`gf-${key}`}
              label={label}
              value={config.prefixes[key]}
              onChange={(value) =>
                setConfig({ ...config, prefixes: { ...config.prefixes, [key]: value } })
              }
            />
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!valid}>
            {initialized ? 'Save' : 'Initialize'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function PrefixField({
  id,
  label,
  value,
  onChange
}: {
  id: string
  label: string
  value: string
  onChange(value: string): void
}): React.JSX.Element {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input mono"
        value={value}
        placeholder="(none)"
        onChange={(e) => onChange(e.target.value)}
      />
    </>
  )
}

function StartDialog({
  flow,
  config,
  onCancel,
  onSubmit
}: {
  flow: GitflowKind
  config: GitflowConfig
  onCancel(): void
  onSubmit(name: string, base: string): void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const defaultBase = flow === 'hotfix' ? config.main : config.develop
  const [base, setBase] = useState(defaultBase)
  const clean = name.trim().replace(/\s+/g, '-')
  return (
    <Modal title={`Start a ${flow}`} onClose={onCancel}>
      <form
        className="gf-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (clean) onSubmit(clean, base.trim() || defaultBase)
        }}
      >
        <p className="modal-message">{KIND_HELP[flow]}</p>
        <label className="modal-label" htmlFor="gf-name">
          {flow === 'release' || flow === 'hotfix' ? 'Version' : 'Name'}
        </label>
        <input
          id="gf-name"
          className="input"
          autoFocus
          value={name}
          placeholder={flow === 'release' ? '1.2.0' : flow === 'hotfix' ? '1.2.1' : 'login-page'}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="gf-preview muted">
          Branch <span className="mono">{config.prefixes[flow] + (clean || '…')}</span>
        </div>
        <label className="modal-label gf-gap" htmlFor="gf-base">
          Start from
        </label>
        <input
          id="gf-base"
          className="input mono"
          value={base}
          onChange={(e) => setBase(e.target.value)}
        />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!clean}>
            Start {flow}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function FinishDialog({
  flow,
  name,
  config,
  onCancel,
  onSubmit
}: {
  flow: GitflowKind
  name: string
  config: GitflowConfig
  onCancel(): void
  onSubmit(opts: { tagMessage: string; noTag: boolean; deleteBranch: boolean }): void
}): React.JSX.Element {
  const tagged = flow === 'release' || flow === 'hotfix'
  const tag = config.prefixes.versiontag + name
  const [tagMessage, setTagMessage] = useState(
    `${flow === 'release' ? 'Release' : 'Hotfix'} ${name}`
  )
  const [makeTag, setMakeTag] = useState(true)
  const [deleteBranch, setDeleteBranch] = useState(true)
  const branch = config.prefixes[flow] + name
  const steps = tagged
    ? [
        `Merge ${branch} into ${config.main} (--no-ff)`,
        ...(makeTag ? [`Tag ${config.main} as ${tag}`] : []),
        `Merge ${makeTag ? `the tag ${tag}` : branch} back into ${config.develop}${
          flow === 'hotfix' ? ' (or into the open release branch)' : ''
        }`
      ]
    : [`Merge ${branch} into ${config.develop} (--no-ff)`]
  if (deleteBranch) steps.push(`Delete ${branch}`)
  return (
    <Modal title={`Finish ${flow} ${name}`} onClose={onCancel}>
      <form
        className="gf-form"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit({ tagMessage: tagMessage.trim(), noTag: tagged && !makeTag, deleteBranch })
        }}
      >
        <ol className="gf-steps">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {tagged && (
          <>
            <label className="checkbox gf-gap">
              <input
                type="checkbox"
                checked={makeTag}
                onChange={(e) => setMakeTag(e.target.checked)}
              />
              Create the tag <span className="mono">{tag}</span>
            </label>
            {makeTag && (
              <>
                <label className="modal-label gf-gap" htmlFor="gf-tagmsg">
                  Tag message
                </label>
                <input
                  id="gf-tagmsg"
                  className="input"
                  value={tagMessage}
                  onChange={(e) => setTagMessage(e.target.value)}
                />
              </>
            )}
          </>
        )}
        <label className="checkbox gf-gap">
          <input
            type="checkbox"
            checked={deleteBranch}
            onChange={(e) => setDeleteBranch(e.target.checked)}
          />
          Delete the branch {branch} (local only)
        </label>
        <p className="gf-note muted">
          If a merge stops on conflicts, resolve them and Continue, then finish again: the steps
          already done are skipped. Undo takes the whole finish back.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" autoFocus>
            Finish {flow}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Toolbar button with the Gitflow actions (native, no git-flow extension needed). */
export function GitflowButton({ repo, currentBranch, onChanged }: Props): React.JSX.Element {
  const toasts = useToasts()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)
  const closeMenu = useCallback(() => setMenu(null), [])
  const cancel = useCallback(() => setDialog(null), [])

  const run = async (what: () => Promise<string | null>): Promise<void> => {
    setDialog(null)
    setBusy(true)
    try {
      const notice = await what()
      if (notice) toasts.info(notice)
    } catch (e) {
      toasts.error(errorMessage(e))
    } finally {
      setBusy(false)
      onChanged()
    }
  }

  const open = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    const rect = e.currentTarget.getBoundingClientRect()
    let config: GitflowConfig | null
    try {
      config = await window.api.gitflowConfig(repo)
    } catch (err) {
      toasts.error(errorMessage(err))
      return
    }
    const items: MenuItem[] = []
    if (!config) {
      items.push({
        label: 'Initialize Gitflow…',
        onClick: () =>
          void window.api.gitflowDefaults(repo).then(
            (defaults) => setDialog({ kind: 'init', config: defaults, initialized: false }),
            (err) => toasts.error(errorMessage(err))
          )
      })
    } else {
      const cfg = config
      const flow = flowOf(cfg, currentBranch)
      if (flow) {
        items.push(
          {
            label: `Finish ${flow.kind} ${flow.name}…`,
            onClick: () =>
              setDialog({ kind: 'finish', flow: flow.kind, name: flow.name, config: cfg })
          },
          'separator'
        )
      }
      for (const kind of KINDS) {
        items.push({
          label: `Start ${kind}…`,
          hint: cfg.prefixes[kind],
          onClick: () => setDialog({ kind: 'start', flow: kind, config: cfg })
        })
      }
      items.push('separator', {
        label: 'Gitflow settings…',
        onClick: () => setDialog({ kind: 'init', config: cfg, initialized: true })
      })
    }
    setMenu({ x: rect.left, y: rect.bottom + 4, items })
  }

  return (
    <>
      <button
        className="tool gf-tool"
        onClick={(e) => void open(e)}
        disabled={busy}
        title="Gitflow: feature, release and hotfix branches"
        aria-haspopup="menu"
      >
        <Workflow size={18} />
        <span>
          Gitflow <ChevronDown size={10} className="gf-caret" />
        </span>
      </button>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {dialog?.kind === 'init' && (
        <InitDialog
          config={dialog.config}
          initialized={dialog.initialized}
          onCancel={cancel}
          onSubmit={(config) =>
            void run(async () => {
              await window.api.gitflowInit(repo, {
                ...config,
                main: config.main.trim(),
                develop: config.develop.trim()
              })
              return dialog.initialized
                ? 'Gitflow settings saved.'
                : `Gitflow initialized: ${config.main.trim()} / ${config.develop.trim()}.`
            })
          }
        />
      )}
      {dialog?.kind === 'start' && (
        <StartDialog
          flow={dialog.flow}
          config={dialog.config}
          onCancel={cancel}
          onSubmit={(name, base) =>
            void run(async () => {
              const branch = await window.api.gitflowStart(repo, dialog.flow, name, base)
              return `${capitalized(dialog.flow)} started: now on ${branch}.`
            })
          }
        />
      )}
      {dialog?.kind === 'finish' && (
        <FinishDialog
          flow={dialog.flow}
          name={dialog.name}
          config={dialog.config}
          onCancel={cancel}
          onSubmit={(opts) =>
            void run(async () => {
              const result = await window.api.gitflowFinish(repo, dialog.flow, dialog.name, opts)
              // A stop on conflicts stays on screen longer (error toasts do).
              if (!result.done) {
                toasts.error(result.message)
                return null
              }
              return result.message
            })
          }
        />
      )}
    </>
  )
}
