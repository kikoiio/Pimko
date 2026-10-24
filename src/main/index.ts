import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Editor } from '../services/editor'
import { FfmpegProber } from '../infra/ffmpeg-prober'
import { FfmpegRenderer } from '../infra/ffmpeg-renderer'
import { FsProjectStore } from '../infra/fs-store'
import { MockIntelligence } from '../infra/mock-intelligence'
import { MockTranscriber } from '../infra/mock-transcriber'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'm4v']

let editor: Editor

function createEditor(): Editor {
  return new Editor({
    prober: new FfmpegProber(),
    transcriber: new MockTranscriber(),
    intelligence: new MockIntelligence(),
    renderer: new FfmpegRenderer(),
    store: new FsProjectStore(path.join(app.getPath('userData'), 'projects')),
  })
}

function registerIpc(): void {
  ipcMain.handle('project:import', async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择口播视频',
      properties: ['openFile'],
      filters: [{ name: '视频', extensions: VIDEO_EXTENSIONS }],
    })
    const file = picked.filePaths[0]
    if (!file) return null
    const revision = await editor.createDraft(file)
    return { revision, sourceUrl: pathToFileURL(file).href }
  })

  ipcMain.handle('project:revise', async (_event, projectId: string, feedback: string) => {
    return editor.revise(projectId, { text: feedback })
  })

  ipcMain.handle('project:export', async (_event, projectId: string) => {
    const picked = await dialog.showSaveDialog({
      title: '导出成片',
      defaultPath: 'pimko-成片.mp4',
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    })
    if (picked.canceled || !picked.filePath) return null
    const outputPath = await editor.export(projectId, picked.filePath)
    return { outputPath, outputUrl: pathToFileURL(outputPath).href }
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Pimko',
  })
  void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

void app.whenReady().then(() => {
  editor = createEditor()
  registerIpc()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
