import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Editor } from '../services/editor'
import { FfmpegProber } from '../infra/ffmpeg-prober'
import { FfmpegRenderer } from '../infra/ffmpeg-renderer'
import { FfmpegSilenceAnalyzer } from '../infra/ffmpeg-silence-analyzer'
import { FsProjectStore } from '../infra/fs-store'
import { MockIntelligence } from '../infra/mock-intelligence'
import { createIntelligence, createTranscriber } from '../infra/ai-factory'
import { loadDotEnv } from '../infra/env'
import { loadLlmConfig } from '../infra/llm-config'
import type { LlmConfig } from '../infra/llm-config'
import type { ExportProgress } from '../ports/renderer'
import { timelineDurationSec } from '../domain/timeline'
import type { ProjectSummary } from '../shared/api'
import { resolveFfmpeg } from '../infra/ffmpeg-bin'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'm4v']
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac']

const execFileAsync = promisify(execFile)

let editor: Editor
let mainWindow: BrowserWindow | undefined

// 必须在 app ready 前注册：stream 让 <video> 支持 Range 请求，否则只能拿到无法播放的整段响应。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pimko-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

function mediaUrl(fileUrl: string): string {
  // 文件路径放 pathname：host 会被 URL 解析器小写化，Linux 路径大小写敏感。
  return `pimko-media://media/${encodeURIComponent(fileURLToPath(fileUrl))}`
}

function registerMediaProtocol(): void {
  protocol.handle('pimko-media', (request) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname.slice(1))
    return net.fetch(pathToFileURL(filePath).href)
  })
}

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
    silenceAnalyzer: new FfmpegSilenceAnalyzer(),
  })
}

function registerIpc(): void {
  ipcMain.handle('project:import', async () => {
    if (process.env.PIMKO_SELF_TEST_VIDEO) {
      const revision = await editor.createDraft(process.env.PIMKO_SELF_TEST_VIDEO)
      return { revision, sourceUrl: mediaUrl(pathToFileURL(process.env.PIMKO_SELF_TEST_VIDEO).href) }
    }
    const picked = await dialog.showOpenDialog({
      title: '选择口播视频',
      properties: ['openFile'],
      filters: [{ name: '视频', extensions: VIDEO_EXTENSIONS }],
    })
    const file = picked.filePaths[0]
    if (!file) return null
    const revision = await editor.createDraft(file)
    return { revision, sourceUrl: mediaUrl(pathToFileURL(file).href) }
  })

  ipcMain.handle('project:list', async (): Promise<ProjectSummary[]> => {
    const revisions = await editor.listProjects()
    return revisions.map((revision) => {
      const asset = revision.project.assets[0]
      return {
        projectId: revision.project.id,
        name: revision.project.name,
        revisionId: revision.id,
        updatedAt: revision.createdAt,
        clipCount: revision.project.timeline.clips.length,
        durationSec: timelineDurationSec(revision.project.timeline),
        sourceUrl: asset ? mediaUrl(pathToFileURL(asset.absolutePath).href) : '',
      }
    })
  })

  ipcMain.handle('project:restore', async (_event, projectId: string) => {
    const revision = await editor.restore(projectId)
    if (!revision) throw new Error(`项目不存在: ${projectId}`)
    const asset = revision.project.assets[0]
    if (!asset) throw new Error('项目没有素材，无法恢复。')
    return { revision, sourceUrl: mediaUrl(pathToFileURL(asset.absolutePath).href) }
  })

  ipcMain.handle('project:revise', async (_event, projectId: string, feedback: string) => {
    return editor.revise(projectId, { text: feedback })
  })

  ipcMain.handle('project:export', async (_event, projectId: string) => {
    // ffmpeg 输出不含结构化进度；先发一个整体阶段事件，UI 有明确反馈。
    mainWindow?.webContents.send('export:progress', { phase: 'cutting', current: 0, total: 1 })
    const picked = await dialog.showSaveDialog({
      title: '导出成片',
      defaultPath: 'pimko-成片.mp4',
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    })
    if (picked.canceled || !picked.filePath) return null
    const outputPath = await editor.export(projectId, picked.filePath, (progress: ExportProgress) => {
      mainWindow?.webContents.send('export:progress', progress)
    })
    return { outputPath, outputUrl: mediaUrl(pathToFileURL(outputPath).href) }
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

  ipcMain.handle('project:undo', (_event, projectId: string) => editor.undo(projectId))

  ipcMain.handle('project:bgm:volume', (_event, projectId: string, gainDb: number) =>
    editor.setBgmVolume(projectId, gainDb),
  )

  // 片段缩略图:取片段中点帧,按 项目+修订+序号 落盘缓存;失败返回 null,UI 留空。
  ipcMain.handle('clip:thumbnail', async (_event, projectId: string, index: number): Promise<string | null> => {
    try {
      const revision = await editor.restore(projectId)
      const clip = revision?.project.timeline.clips[index]
      const asset = revision ? revision.project.assets.find((entry) => entry.id === clip?.assetId) : undefined
      if (!revision || !clip || !asset) return null
      const cacheDir = path.join(app.getPath('userData'), 'thumbnails')
      await mkdir(cacheDir, { recursive: true })
      const cachePath = path.join(cacheDir, `${projectId}-${revision.id}-${index}.jpg`)
      try {
        await readFile(cachePath)
      } catch {
        const mid = clip.sourceStartSec + (clip.sourceEndSec - clip.sourceStartSec) / 2
        await execFileAsync(resolveFfmpeg(), [
          '-y', '-v', 'error',
          '-ss', String(Math.max(0, mid)),
          '-i', asset.absolutePath,
          '-frames:v', '1',
          '-vf', 'scale=160:-2',
          '-q:v', '5',
          cachePath,
        ])
      }
      const bytes = await readFile(cachePath)
      return `data:image/jpeg;base64,${bytes.toString('base64')}`
    } catch {
      return null
    }
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
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  void loadDotEnv().then(() => {
  registerMediaProtocol()
  editor = createEditor()
  registerIpc()
  createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
