import { contextBridge, ipcRenderer } from 'electron'
import {
  API_METHODS,
  EVENT_CHANNELS,
  CLONE_PROGRESS_CHANNEL,
  REPO_CHANGED_CHANNEL,
  REPOS_SYNCED_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  type RendererApi
} from '../shared/api'
import type { CloneProgress, UpdateStatus } from '../shared/types'

type Events =
  'onRepoChanged' | 'onCloneProgress' | 'onReposSynced' | 'onUpdateStatus' | 'on' | 'platform'

const api = Object.fromEntries(
  API_METHODS.map((name) => [
    name,
    (...args: unknown[]) => ipcRenderer.invoke(`api:${name}`, ...args)
  ])
) as Omit<RendererApi, Events>

function subscribe<T extends unknown[]>(
  channel: string,
  listener: (...args: T) => void
): () => void {
  const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void =>
    listener(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const rendererApi: RendererApi = {
  ...api,
  onRepoChanged: (listener) => subscribe<[string]>(REPO_CHANGED_CHANNEL, listener),
  onCloneProgress: (listener) => subscribe<[CloneProgress]>(CLONE_PROGRESS_CHANNEL, listener),
  onReposSynced: (listener) => subscribe<[]>(REPOS_SYNCED_CHANNEL, listener),
  onUpdateStatus: (listener) => subscribe<[UpdateStatus]>(UPDATE_STATUS_CHANNEL, listener),
  on: (channel, listener) => {
    // Only the channels declared by the feature contracts can be subscribed to.
    if (!EVENT_CHANNELS.includes(channel)) throw new Error(`Unknown event channel ${channel}`)
    return subscribe<[never]>(channel, listener as (payload: never) => void)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('api', rendererApi)
