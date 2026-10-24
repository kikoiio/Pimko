import { contextBridge, ipcRenderer } from 'electron'
import type { PimkoApi } from '../shared/api'

const api: PimkoApi = {
  importVideo: () => ipcRenderer.invoke('project:import'),
  revise: (projectId, feedback) => ipcRenderer.invoke('project:revise', projectId, feedback),
  exportVideo: (projectId) => ipcRenderer.invoke('project:export', projectId),
}

contextBridge.exposeInMainWorld('pimko', api)
