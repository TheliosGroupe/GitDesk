// Labels that depend on the operating system GitDesk runs on.

const platform = typeof window !== 'undefined' ? (window.api?.platform ?? 'win32') : 'win32'

export const isMac = platform === 'darwin'
export const isWindows = platform === 'win32'

/** "Explorer", "Finder" or "file manager". */
export const fileManagerName = isWindows ? 'Explorer' : isMac ? 'Finder' : 'file manager'

/** e.g. "Open folder in Explorer". */
export const openFolderLabel = `Open folder in ${fileManagerName}`

/** e.g. "Show in Explorer". */
export const showInFolderLabel = `Show in ${fileManagerName}`

/** "Ctrl" on Windows/Linux, "⌘" on macOS. */
export const modKey = isMac ? '⌘' : 'Ctrl'

/** True when the platform's main modifier (Ctrl, or ⌘ on macOS) is held. */
export function hasMod(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

export function editorName(editor: 'vscode' | 'cursor' | 'system'): string {
  return editor === 'vscode' ? 'VS Code' : editor === 'cursor' ? 'Cursor' : 'default app'
}
