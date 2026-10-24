import { contextBridge, ipcRenderer } from 'electron'
import type { PimkoApi } from '../shared/api'

const api: PimkoApi = {
  importVideo: () => ipcRenderer.invoke('project:import'),
  revise: (projectId, feedback) => ipcRenderer.invoke('project:revise', projectId, feedback),
  exportVideo: (projectId) => ipcRenderer.invoke('project:export', projectId),
  setBgm: (projectId) => ipcRenderer.invoke('project:bgm:set', projectId),
  removeBgm: (projectId) => ipcRenderer.invoke('project:bgm:remove', projectId),
}

contextBridge.exposeInMainWorld('pimko', api)
