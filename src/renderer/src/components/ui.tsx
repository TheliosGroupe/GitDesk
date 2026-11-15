import { X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { hueFor, initials } from '../lib/format'
import { hasHiddenChars, hiddenCharInfo, splitUiText, uiLabel } from '../lib/highlight'
import {
  DialogContext,
  ToastContext,
  type ConfirmOptions,
  type Dialogs,
  type PromptOptions,
  type Toasts
} from './ui-context'

// ---------------------------------------------------------------------------
// Text from repositories in dialog titles, toasts and menus
// ---------------------------------------------------------------------------

/**
 * A UI string that may hold repository names (branch, tag, file): a run that isolateText
 * wrapped is drawn isolated (<bdi>), any other bidi control or invisible character as a
 * marker. A name can then never reorder the sentence around it (Trojan Source), and the
 * text reads the same as the plain string when it holds none of them.
 */
export function UiText({ text }: { text: string }): React.ReactNode {
  if (!hasHiddenChars(text)) return text
  return splitUiText(text).map((part, i) => {
    if (typeof part === 'string') return part
    if ('isolated' in part) return <bdi key={i}>{part.isolated}</bdi>
    const { code, name } = hiddenCharInfo(part.hidden)
    return (
      <span key={i} className="hidden-char" title={`${code} ${name}`}>
        {code}
      </span>
    )
  })
}

// ---------------------------------------------------------------------------
// Dialogs (Electron has no window.prompt)
// ---------------------------------------------------------------------------

type OpenDialog =
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void }
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }

export function DialogProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState<OpenDialog | null>(null)
  const dialogs = useMemo<Dialogs>(
    () => ({
      prompt: (options) => new Promise((resolve) => setOpen({ kind: 'prompt', options, resolve })),
      confirm: (options) => new Promise((resolve) => setOpen({ kind: 'confirm', options, resolve }))
    }),
    []
  )
  return (
    <DialogContext.Provider value={dialogs}>
      {children}
      {open?.kind === 'prompt' && (
        <PromptDialog
          options={open.options}
          onDone={(value) => {
            setOpen(null)
            open.resolve(value)
          }}
        />
      )}
      {open?.kind === 'confirm' && (
        <ConfirmDialog
          options={open.options}
          onDone={(value) => {
            setOpen(null)
            open.resolve(value)
          }}
        />
      )}
    </DialogContext.Provider>
  )
}

export function Modal({
  title,
  onClose,
  children,
  wide = false
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}): React.JSX.Element {
  const backdrop = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // A dialog opened from another dialog: only the topmost one closes.
      const all = document.querySelectorAll('.modal-backdrop')
      if (all[all.length - 1] === backdrop.current) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" ref={backdrop} onMouseDown={onClose}>
      <div
        className={wide ? 'modal wide' : 'modal'}
        role="dialog"
        aria-label={uiLabel(title)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title">
          <UiText text={title} />
        </div>
        {children}
      </div>
    </div>
  )
}

function PromptDialog({
  options,
  onDone
}: {
  options: PromptOptions
  onDone: (v: string | null) => void
}): React.JSX.Element {
  const [value, setValue] = useState(options.initial ?? '')
  const cancel = useCallback(() => onDone(null), [onDone])
  return (
    <Modal title={options.title} onClose={cancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onDone(value.trim())
        }}
      >
        {options.label && (
          <label className="modal-label">
            <UiText text={options.label} />
          </label>
        )}
        <input
          className="input"
          autoFocus
          value={value}
          placeholder={options.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!value.trim()}>
            {options.okLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ConfirmDialog({
  options,
  onDone
}: {
  options: ConfirmOptions
  onDone: (v: boolean) => void
}): React.JSX.Element {
  const cancel = useCallback(() => onDone(false), [onDone])
  return (
    <Modal title={options.title} onClose={cancel}>
      {options.message && (
        <div className="modal-message">
          {typeof options.message === 'string' ? (
            <UiText text={options.message} />
          ) : (
            options.message
          )}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={cancel}>
          Cancel
        </button>
        <button
          className={options.danger ? 'btn danger' : 'btn primary'}
          autoFocus
          onClick={() => onDone(true)}
        >
          {options.okLabel ?? 'OK'}
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast {
  id: number
  kind: 'info' | 'error'
  text: string
  /** The same message shown this many times in a row. */
  count: number
}

/** Older toasts are dismissed first beyond this. */
const MAX_TOASTS = 3

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  // The list as last set, so pushes in a row see each other before React renders.
  const current = useRef<Toast[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const nextId = useRef(1)
  const update = useCallback((next: Toast[]) => {
    current.current = next
    setToasts(next)
  }, [])
  const forgetTimer = useCallback((id: number) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
  }, [])
  const dismiss = useCallback(
    (id: number) => {
      forgetTimer(id)
      update(current.current.filter((x) => x.id !== id))
    },
    [forgetTimer, update]
  )
  const api = useMemo<Toasts>(() => {
    const push = (kind: Toast['kind'], text: string): void => {
      const list = current.current
      const last = list[list.length - 1]
      let id: number
      if (last && last.kind === kind && last.text === text) {
        // The same message again: count it instead of stacking a copy.
        id = last.id
        update([...list.slice(0, -1), { ...last, count: last.count + 1 }])
      } else {
        id = nextId.current++
        const next = [...list, { id, kind, text, count: 1 }]
        for (const old of next.slice(0, -MAX_TOASTS)) forgetTimer(old.id)
        update(next.slice(-MAX_TOASTS))
      }
      forgetTimer(id)
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), kind === 'error' ? 12000 : 4000)
      )
    }
    return { info: (t) => push('info', t), error: (t) => push('error', t) }
  }, [dismiss, forgetTimer, update])
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <pre>
              <UiText text={t.text} />
            </pre>
            {t.count > 1 && <span className="toast-count">×{t.count}</span>}
            <button className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | 'separator'

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

export function ContextMenu({
  menu,
  onClose
}: {
  menu: MenuState
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.min(menu.x, window.innerWidth - width - 8),
      top: Math.min(menu.y, window.innerHeight - height - 8)
    })
  }, [menu])

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      className="context-menu"
      ref={ref}
      style={pos}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={item.danger ? 'menu-item danger' : 'menu-item'}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onClick()
            }}
          >
            <span>
              <UiText text={item.label} />
            </span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
          </button>
        )
      )}
    </div>
  )
}

/** Profile picture when one is known, otherwise initials on a color stable per person. */
export function Avatar({
  name,
  src,
  size = 22,
  className = ''
}: {
  name: string
  src?: string | null
  size?: number
  className?: string
}): React.JSX.Element {
  const style = { width: size, height: size, fontSize: size * 0.42 }
  if (src) {
    return (
      <img
        className={`avatar ${className}`}
        src={src}
        alt={name}
        title={name}
        style={style}
        draggable={false}
      />
    )
  }
  return (
    <span
      className={`avatar ${className}`}
      title={name}
      style={{ ...style, background: `hsl(${hueFor(name)} 45% 38%)` }}
    >
      {initials(name)}
    </span>
  )
}

export function KindBadge({ kind }: { kind: string }): React.JSX.Element {
  const label = kind === '?' ? 'A' : kind
  const title =
    {
      A: 'Added',
      M: 'Modified',
      D: 'Deleted',
      R: 'Renamed',
      C: 'Copied',
      T: 'Type changed',
      U: 'Conflict',
      '?': 'New file (untracked)'
    }[kind] ?? kind
  return (
    <span className={`kind kind-${kind === '?' ? 'A' : kind}`} title={title}>
      {label}
    </span>
  )
}
