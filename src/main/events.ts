import { BrowserWindow } from 'electron'
import type { EventMap } from '../shared/api'

/** Sends a feature event (see EventMap in src/shared/api.ts) to every window. */
export function emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}
