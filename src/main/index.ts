import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Editor } from '../services/editor'
import { FfmpegProber } from '../infra/ffmpeg-prober'
import { FfmpegRenderer } from '../infra/ffmpeg-renderer'
import { FsProjectStore } from '../infra/fs-store'
import { MockIntelligence } from '../infra/mock-intelligence'
import { createIntelligence, createTranscriber } from '../infra/ai-factory'
import { loadDotEnv } from '../infra/env'
import { loadLlmConfig } from '../infra/llm-config'
import type { LlmConfig } from '../infra/llm-config'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'm4v']
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac']

let editor: Editor

function createEditor(): Editor {
  let config: LlmConfig
  try {
    config = loadLlmConfig()
  } catch (err) {
    // 配置错误不应让应用白屏；降级到 mock 并在启动时明确告知。
    dialog.showErrorBox(
      'LLM 配置错误',
      `${err instanceof Error ? err.message : String(err)}\n\n已回退到 mock 模式，修正 .env 后重启应用即可。`,
    )
    config = { provider: 'mock' as const }
  }
  return new Editor({
    prober: new FfmpegProber(),
    transcriber: createTranscriber(config),
    intelligence: createIntelligence(config),
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

  ipcMain.handle('project:bgm:set', async (_event, projectId: string) => {
    const picked = await dialog.showOpenDialog({
      title: '选择配乐',
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: AUDIO_EXTENSIONS }],
    })
    const file = picked.filePaths[0]
    if (!file) return null
    return editor.setBgm(projectId, file)
  })

  ipcMain.handle('project:bgm:remove', (_event, projectId: string) => editor.removeBgm(projectId))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'Pimko',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
    },
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  void loadDotEnv().then(() => {
  editor = createEditor()
  registerIpc()
  createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
