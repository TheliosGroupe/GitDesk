import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  type ReactNode,
  type RefObject
} from 'react'
import { errorMessage } from '../lib/format'

// Kept apart from ui.tsx so that file only exports components (React fast refresh).

export interface PromptOptions {
  title: string
  label?: string
  initial?: string
  okLabel?: string
  placeholder?: string
}

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  okLabel?: string
  danger?: boolean
}

export interface Dialogs {
  prompt(options: PromptOptions): Promise<string | null>
  confirm(options: ConfirmOptions): Promise<boolean>
}

export interface Toasts {
  info(text: string): void
  error(text: string): void
}

export const DialogContext = createContext<Dialogs | null>(null)
export const ToastContext = createContext<Toasts | null>(null)

export function useDialogs(): Dialogs {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useDialogs outside DialogProvider')
  return ctx
}

export function useToasts(): Toasts {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToasts outside ToastProvider')
  return ctx
}

/** Opens a repository file in the editor; says so when it was shown in its folder instead. */
export function useOpenFile(): (repo: string, path: string) => void {
  const toasts = useToasts()
  return useCallback(
    (repo: string, path: string) => {
      window.api.openFile(repo, path).then(
        (notice) => notice && toasts.info(notice),
        (e) => toasts.error(errorMessage(e))
      )
    },
    [toasts]
  )
}

/**
 * Esc for a closable view (diff, file history). The view's root element carries
 * `data-escape`; only the innermost visible one reacts, so one Esc closes one view,
 * and views of hidden repository tabs never do.
 */
export function useEscape(ref: RefObject<HTMLElement | null>, onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = ref.current
      if (e.key !== 'Escape' || e.defaultPrevented || !el) return
      // A dialog or a menu takes this Esc for itself.
      if (document.querySelector('.modal, .context-menu')) return
      // Hidden (another tab is shown), or a view inside this one takes it.
      if (el.offsetParent === null || el.querySelector('[data-escape]')) return
      e.preventDefault()
      onEscape()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ref, onEscape])
}
