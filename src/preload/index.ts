import { contextBridge, ipcRenderer } from 'electron'
import type { PimkoApi } from '../shared/api'

const api: PimkoApi = {
  importVideo: () => ipcRenderer.invoke('project:import'),
  listProjects: () => ipcRenderer.invoke('project:list'),
  restoreProject: (projectId) => ipcRenderer.invoke('project:restore', projectId),
  revise: (projectId, feedback) => ipcRenderer.invoke('project:revise', projectId, feedback),
  exportVideo: (projectId) => ipcRenderer.invoke('project:export', projectId),
  onExportProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: import('../ports/renderer').ExportProgress) => listener(progress)
    ipcRenderer.on('export:progress', handler)
  },
  setBgm: (projectId) => ipcRenderer.invoke('project:bgm:set', projectId),
  removeBgm: (projectId) => ipcRenderer.invoke('project:bgm:remove', projectId),
}

contextBridge.exposeInMainWorld('pimko', api)
