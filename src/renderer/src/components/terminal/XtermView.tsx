// One terminal of the main process shown with xterm.js. The process lives in the main
// process: unmounting this view keeps it running, and mounting it again repaints the
// recent output from terminalSnapshot().

import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import '../../assets/terminal.css'

const WINDOWS = window.api.platform === 'win32'

/** Terminal colors from the theme's CSS variables (re-read when the theme changes). */
function readTheme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string =>
    css.getPropertyValue(name).trim() || fallback
  const light = document.documentElement.dataset.theme === 'light'
  return {
    background: v('--bg', light ? '#ffffff' : '#1b1e24'),
    foreground: v('--text', light ? '#1f2328' : '#e3e7ee'),
    cursor: v('--accent', '#3d8bfd'),
    cursorAccent: v('--bg', '#1b1e24'),
    selectionBackground: v('--select', 'rgba(61, 139, 253, 0.3)'),
    black: light ? '#24292f' : '#3b4250',
    red: v('--bad', '#ec5b52'),
    green: v('--ok', '#46b978'),
    yellow: v('--warn', '#e3a33d'),
    blue: v('--accent', '#3d8bfd'),
    magenta: v('--hue-3', '#c584ff'),
    cyan: v('--hue-5', '#2fc6c6'),
    white: light ? '#6e7781' : '#d0d7de',
    brightBlack: v('--muted', '#8a93a3'),
    brightRed: v('--hue-1', '#ef7b5a'),
    brightGreen: v('--hue-2', '#43c983'),
    brightYellow: v('--hue-4', '#f0c84b'),
    brightBlue: v('--hue-0', '#4aa8ff'),
    brightMagenta: v('--hue-6', '#ff6f9e'),
    brightCyan: v('--hue-5', '#2fc6c6'),
    brightWhite: light ? '#8c959f' : '#ffffff'
  }
}

/** Nerd Font variants, so prompt themes (oh-my-posh, starship, powerlevel10k) show their icons. */
const NERD_FONTS = [
  'CaskaydiaCove Nerd Font Mono',
  'CaskaydiaMono Nerd Font',
  'MesloLGS Nerd Font Mono',
  'MesloLGS Nerd Font',
  'MesloLGS NF',
  'JetBrainsMono Nerd Font Mono',
  'FiraCode Nerd Font Mono',
  'Hack Nerd Font Mono',
  'Symbols Nerd Font Mono'
].map((f) => `'${f}'`)

function monoFont(): string {
  const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()
  const fonts = (mono || 'Consolas, monospace').split(',').map((f) => f.trim())
  // The app's font first; Nerd Fonts only fill in the glyphs it lacks (before the generic family).
  const generic = fonts.filter((f) => f === 'monospace')
  return [...fonts.filter((f) => f !== 'monospace'), ...NERD_FONTS, ...generic, 'monospace']
    .filter((f, i, all) => all.indexOf(f) === i)
    .join(', ')
}

async function copy(text: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard unavailable (window not focused): nothing to do.
  }
}

export function XtermView({
  id,
  visible,
  onExit
}: {
  id: string
  /** Shown on screen: fits and takes the focus when it becomes visible. */
  visible: boolean
  onExit?(exitCode: number): void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const onExitRef = useRef(onExit)
  useEffect(() => {
    onExitRef.current = onExit
  })

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      fontFamily: monoFont(),
      fontSize: 13,
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: false,
      theme: readTheme(),
      // Windows ConPTY already reflows; xterm must not do it a second time.
      ...(WINDOWS ? { windowsPty: { backend: 'conpty' as const } } : {})
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term
    let disposed = false

    const doFit = (): void => {
      if (disposed || el.offsetParent === null || !el.clientWidth || !el.clientHeight) return
      try {
        fit.fit()
      } catch {
        // Not laid out yet.
      }
    }
    fitRef.current = doFit

    // Output: chunks that arrive before the snapshot wait, then only the new part is written.
    let seq = -1
    let exitShown = false
    const queued: { data: string; seq: number }[] = []
    const apply = (chunk: { data: string; seq: number }): void => {
      if (chunk.seq <= seq) return
      const start = chunk.seq - chunk.data.length
      term.write(start < seq ? chunk.data.slice(seq - start) : chunk.data)
      seq = chunk.seq
    }
    const showExit = (code: number | null): void => {
      if (exitShown) return
      exitShown = true
      term.write(
        `\r\n\x1b[2m[Process exited${code === null ? '' : ` with code ${code}`}]\x1b[0m\r\n`
      )
      onExitRef.current?.(code ?? -1)
    }
    const offData = window.api.on('terminal:data', (chunk) => {
      if (chunk.id !== id) return
      if (seq < 0) queued.push(chunk)
      else apply(chunk)
    })
    const offExit = window.api.on('terminal:exit', (e) => {
      if (e.id === id && seq >= 0) showExit(e.exitCode)
    })
    window.api.terminalSnapshot(id).then(
      (snap) => {
        if (disposed) return
        term.write(snap.data)
        seq = snap.seq
        for (const chunk of queued.splice(0)) apply(chunk)
        if (!snap.info.running) showExit(snap.info.exitCode)
        doFit()
        if (snap.info.running) {
          void window.api.terminalResize(id, term.cols, term.rows).catch(() => {})
        }
      },
      () => {
        seq = 0
        term.write('\x1b[2m[This terminal no longer exists]\x1b[0m\r\n')
      }
    )

    const input = term.onData((data) => {
      void window.api.terminalWrite(id, data).catch(() => {})
    })
    const resize = term.onResize(({ cols, rows }) => {
      void window.api.terminalResize(id, cols, rows).catch(() => {})
    })

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      // Left to the app: terminal toggle and tab switching.
      if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote' || key === 'tab')) return false
      if (ctrl && e.shiftKey && key === 'c') {
        e.preventDefault()
        void copy(term.getSelection())
        return false
      }
      // Paste: let the browser fire its paste event, which xterm handles (bracketed paste).
      if (ctrl && e.shiftKey && key === 'v') return false
      if (WINDOWS && e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (key === 'v') return false
        // Like Windows Terminal: Ctrl+C copies when text is selected, else interrupts.
        if (key === 'c' && term.hasSelection()) {
          e.preventDefault()
          void copy(term.getSelection())
          term.clearSelection()
          return false
        }
      }
      return true
    })

    // Windows console habit: right-click copies the selection, or pastes.
    const onContextMenu = (e: MouseEvent): void => {
      if (!WINDOWS) return
      e.preventDefault()
      if (term.hasSelection()) {
        void copy(term.getSelection())
        term.clearSelection()
      } else {
        navigator.clipboard.readText().then(
          (text) => text && term.paste(text),
          () => {}
        )
      }
    }
    el.addEventListener('contextmenu', onContextMenu)

    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(doFit)
    })
    observer.observe(el)

    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style']
    })

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      themeObserver.disconnect()
      el.removeEventListener('contextmenu', onContextMenu)
      offData()
      offExit()
      input.dispose()
      resize.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [id])

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      fitRef.current?.()
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])

  return <div className="xterm-host" ref={host} hidden={!visible} data-terminal-id={id} />
}
