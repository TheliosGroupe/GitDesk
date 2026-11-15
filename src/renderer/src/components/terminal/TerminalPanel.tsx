// Bottom panel of a repository tab: terminals running in the repository folder.

import { Bot, ChevronDown, Maximize2, Minimize2, Plus, SquareTerminal, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalInfo } from '../../../../shared/features/terminal'
import { errorMessage } from '../../lib/format'
import { useToasts } from '../ui-context'
import { samePath } from './util'
import { XtermView } from './XtermView'
import '../../assets/terminal.css'

const HEIGHT_KEY = 'gitdesk.terminal.height'
const MIN_HEIGHT = 120
const DEFAULT_HEIGHT = 280

function savedHeight(): number {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY))
    return Number.isFinite(n) && n >= MIN_HEIGHT ? n : DEFAULT_HEIGHT
  } catch {
    return DEFAULT_HEIGHT
  }
}

export function TerminalPanel({
  cwd,
  active,
  onClose,
  maximized = false,
  onToggleMaximized
}: {
  cwd: string
  active: boolean
  onClose(): void
  /** Fills the center column; the saved height comes back when restored. */
  maximized?: boolean
  onToggleMaximized?(): void
}): React.JSX.Element {
  const toasts = useToasts()
  const [terms, setTerms] = useState<TerminalInfo[] | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [height, setHeight] = useState(savedHeight)
  const creating = useRef(false)
  // After the last terminal is closed, don't start a new one until the panel is shown again.
  const suppressAuto = useRef(false)

  const refresh = useCallback(
    (): Promise<void> =>
      window.api.terminalList(cwd).then((list) => {
        setTerms(list)
        setCurrent((c) =>
          c && list.some((t) => t.id === c) ? c : (list[list.length - 1]?.id ?? null)
        )
      }),
    [cwd]
  )

  useEffect(() => {
    window.api.terminalList(cwd).then(
      (list) => {
        setTerms(list)
        setCurrent(list[list.length - 1]?.id ?? null)
      },
      () => setTerms([])
    )
    const offList = window.api.on('terminal:list', (e) => {
      if (samePath(e.cwd, cwd)) void refresh().catch(() => {})
    })
    const offExit = window.api.on('terminal:exit', (e) => {
      setTerms((list) =>
        list
          ? list.map((t) => (t.id === e.id ? { ...t, running: false, exitCode: e.exitCode } : t))
          : list
      )
    })
    return () => {
      offList()
      offExit()
    }
  }, [cwd, refresh])

  const create = useCallback(async () => {
    if (creating.current) return
    creating.current = true
    try {
      const info = await window.api.terminalCreate(cwd, 100, 24)
      await refresh()
      setCurrent(info.id)
    } catch (e) {
      toasts.error(errorMessage(e))
    } finally {
      creating.current = false
    }
  }, [cwd, refresh, toasts])

  useEffect(() => {
    if (!active) {
      suppressAuto.current = false
      return
    }
    if (terms && terms.length === 0 && !suppressAuto.current) void create()
  }, [active, terms, create])

  const close = async (id: string): Promise<void> => {
    const last = terms?.length === 1
    if (last) suppressAuto.current = true
    try {
      await window.api.terminalKill(id)
    } catch {
      // Already gone.
    }
    await refresh().catch(() => {})
    if (last) onClose()
  }

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    let latest = startH
    const move = (ev: MouseEvent): void => {
      const max = Math.max(MIN_HEIGHT, window.innerHeight * 0.8)
      latest = Math.round(Math.min(max, Math.max(MIN_HEIGHT, startH + startY - ev.clientY)))
      setHeight(latest)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('terminal-resizing')
      try {
        localStorage.setItem(HEIGHT_KEY, String(latest))
      } catch {
        // Not critical.
      }
    }
    document.body.classList.add('terminal-resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div
      className={maximized ? 'terminal-panel maximized' : 'terminal-panel'}
      style={maximized ? undefined : { height }}
    >
      {!maximized && (
        <div
          className="terminal-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the terminal"
          onMouseDown={startDrag}
        />
      )}
      <div className="terminal-tabs" role="tablist" aria-label="Terminals">
        {terms?.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === current}
            className={['terminal-tab', t.id === current && 'active', !t.running && 'exited']
              .filter(Boolean)
              .join(' ')}
            title={t.running ? t.title : `${t.title} (exited)`}
            onClick={() => setCurrent(t.id)}
            onAuxClick={(e) => e.button === 1 && void close(t.id)}
          >
            {t.kind === 'agent' ? <Bot size={13} /> : <SquareTerminal size={13} />}
            <span className="terminal-tab-title">{t.title}</span>
            <button
              className="icon-btn terminal-tab-close"
              aria-label={`Close ${t.title}`}
              title="Close (ends the process)"
              onClick={(e) => {
                e.stopPropagation()
                void close(t.id)
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          className="icon-btn"
          aria-label="New terminal"
          title="New terminal"
          onClick={() => void create()}
        >
          <Plus size={14} />
        </button>
        <span className="terminal-tabs-spacer" />
        {onToggleMaximized && (
          <button
            className="icon-btn"
            aria-label={maximized ? 'Restore the terminal' : 'Maximize the terminal'}
            aria-pressed={maximized}
            title={maximized ? 'Restore the terminal size' : 'Maximize the terminal'}
            onClick={onToggleMaximized}
          >
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        )}
        <button
          className="icon-btn"
          aria-label="Hide the terminal"
          title="Hide (Ctrl+`)"
          onClick={onClose}
        >
          <ChevronDown size={14} />
        </button>
      </div>
      <div className="terminal-body">
        {terms?.map((t) => (
          <XtermView key={t.id} id={t.id} visible={active && t.id === current} />
        ))}
        {terms && terms.length === 0 && (
          <div className="terminal-empty">
            <button className="btn" onClick={() => void create()}>
              <Plus size={14} /> New terminal
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
