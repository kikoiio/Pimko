/**
 * 验收 harness 共享库（docs/testing-acceptance.md）。
 *
 * 只在 CI（GitHub Actions / xvfb）运行；每个批次一个 Electron 实例。
 * userData 通过 HOME 覆盖隔离到批次工作目录，启动后用 app.getPath('userData')
 * 反向校验，避免触碰用户真实项目数据。
 */
import { _electron as electron, type Page, type ElectronApplication } from 'playwright'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(__dirname, '..', '..')

export const REPO_ROOT = root
export const PLATFORM = `${process.platform}-${process.arch}`
export const GIT_REVISION = process.env.PIMKO_ACCEPTANCE_GIT_REV ?? 'unknown'

export type CaseStatus = '通过' | '失败' | '阻塞' | '限制已确认' | '待测'
export type CaseMode = 'M' | 'R' | 'I'

export interface CaseRecord {
  id: string
  variant: string
  mode: CaseMode
  status: CaseStatus
  startedAt: string
  endedAt: string
  executor: string
  codeRevision: string
  platform: string
  userDataDir: string
  provider: Record<string, string>
  keyConfigured: '已配置' | '未配置' | '受控假值'
  material?: { path: string; sha256?: string; spec?: string }
  projectId?: string
  revisionBefore?: string
  revisionAfter?: string
  expected: string
  checks: { name: string; pass: boolean; detail: string }[]
  actual: string
  output?: { path: string; durationSec?: number; width?: number; height?: number }
  cache?: Record<string, unknown>
  evidence: string[]
  defects: string[]
  blockedReason?: string
}

export function sha256(file: string): Promise<string> {
  return execFileAsync('sha256sum', [file]).then(
    (out) => out.stdout.trim().split(/\s+/)[0] ?? '',
    () => '',
  )
}

export async function probeMedia(file: string): Promise<{
  durationSec: number
  width?: number
  height?: number
  videoCodec?: string
  audioCodec?: string
  rotation?: string
  hasAudio: boolean
  raw: unknown
}> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ])
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: Record<string, unknown>[]
  }
  const streams = parsed.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video') as
    | { codec_name?: string; width?: number; height?: number; tags?: Record<string, string>; side_data_list?: { rotation?: number }[] }
    | undefined
  const audio = streams.find((s) => s.codec_type === 'audio') as { codec_name?: string } | undefined
  return {
    durationSec: Number(parsed.format?.duration ?? '0'),
    width: video?.width,
    height: video?.height,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    rotation: String(video?.side_data_list?.[0]?.rotation ?? video?.tags?.rotate ?? ''),
    hasAudio: !!audio,
    raw: parsed,
  }
}

/** 时间线期望时长（与 domain/timeline.ts 同口径：Σ时长/速度 − 叠化重叠）。 */
export function expectedDuration(timeline: {
  clips: { sourceStartSec: number; sourceEndSec: number; speed?: number }[]
  transitions?: ({ type: string; durationSec?: number } | undefined)[]
}): number {
  let total = 0
  timeline.clips.forEach((clip, index) => {
    total += (clip.sourceEndSec - clip.sourceStartSec) / (clip.speed ?? 1)
    const transition = timeline.transitions?.[index - 1]
    if (transition?.type === 'crossfade') total -= transition.durationSec ?? 0
  })
  return total
}

/** 片段覆盖的源区间集合（顺序无关），用于重排/删除断言。 */
export function coverageOf(timeline: { clips: { sourceStartSec: number; sourceEndSec: number; speed?: number }[] }) {
  return timeline.clips.map((clip) => ({
    start: Number(clip.sourceStartSec.toFixed(2)),
    end: Number(clip.sourceEndSec.toFixed(2)),
    speed: clip.speed ?? 1,
  }))
}

/** 音频区间 RMS(dB)，用于配乐混音/静音断言。 */
export async function audioRmsDb(file: string, startSec: number, endSec: number): Promise<number> {
  const duration = Math.max(0.05, endSec - startSec)
  const { stderr } = await execFileAsync('ffmpeg', [
    '-v', 'info', '-ss', String(startSec), '-t', String(duration), '-i', file,
    '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-',
  ])
  const match = /RMS level dB:\s*(-?[\d.]+|inf|-inf)/.exec(stderr)
  if (!match) throw new Error(`astats 未输出 RMS: ${stderr.slice(-400)}`)
  const value = match[1]!
  return value.includes('inf') ? -120 : Number(value)
}

/** 帧平均亮度（0-255），用于黑屏/黑闪断言。signalstats 元数据走 stderr。 */
export async function frameLumaAvg(file: string, atSec: number): Promise<number> {
  const { stderr } = await execFileAsync('ffmpeg', [
    '-ss', String(atSec), '-i', file, '-frames:v', '1',
    '-vf', 'scale=32x32,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-',
  ])
  const match = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(stderr)
  if (!match) throw new Error(`signalstats 未输出 YAVG`)
  return Number(match[1])
}

export interface BatchResult {
  batch: string
  passed: number
  failed: number
  blocked: number
  limited: number
  records: string[]
}

const batchState: { batch?: string; dir?: string; results: BatchResult } = { results: { batch: '', passed: 0, failed: 0, blocked: 0, limited: 0, records: [] } }

export function batchDir(): string {
  if (!batchState.dir) throw new Error('runBatch 未初始化')
  return batchState.dir
}

export function envProvider(): Record<string, string> {
  const env = process.env
  const host = (url?: string) => {
    if (!url) return 'api.openai.com(默认)'
    try { return new URL(url).host } catch { return url }
  }
  return {
    provider: env.PIMKO_LLM_PROVIDER ?? 'mock',
    model: env.PIMKO_LLM_MODEL ?? '(默认)',
    baseUrlHost: host(env.PIMKO_LLM_BASE_URL),
    transcribeModel: env.PIMKO_TRANSCRIBE_MODEL ?? '(按网关默认)',
    transcribeBaseUrlHost: host(env.PIMKO_TRANSCRIBE_BASE_URL),
  }
}

export function keyConfigured(): '已配置' | '未配置' | '受控假值' {
  const key = process.env.PIMKO_LLM_API_KEY
  if (!key) return '未配置'
  return key.startsWith('test-') || key.startsWith('sk-acceptance') ? '受控假值' : '已配置'
}

export async function runBatch(
  name: string,
  fn: (ctx: { recordDir: string }) => Promise<void>,
): Promise<void> {
  const dir = path.join(root, '.tmp', 'acceptance', name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  batchState.batch = name
  batchState.dir = dir
  batchState.results = { batch: name, passed: 0, failed: 0, blocked: 0, limited: 0, records: [] }
  let crashed: unknown
  try {
    await fn({ recordDir: dir })
  } catch (err) {
    crashed = err
  }
  const summaryPath = path.join(dir, 'summary.json')
  await writeFile(summaryPath, JSON.stringify(batchState.results, null, 2))
  if (crashed) {
    console.error(`批次 ${name} 异常中断:`, crashed)
    process.exitCode = 1
  } else if (batchState.results.failed > 0) {
    process.exitCode = 1
  }
  console.log(`批次 ${name} 完成: 通过=${batchState.results.passed} 失败=${batchState.results.failed} 阻塞=${batchState.results.blocked} 限制=${batchState.results.limited}`)
}

export interface CaseOptions {
  id: string
  variant?: string
  mode: CaseMode
  material?: string
  materialSpec?: string
  expected: string
}

export class Case {
  readonly record: CaseRecord
  private readonly dir: string
  private readonly userData: string

  constructor(options: CaseOptions) {
    this.dir = path.join(batchDir(), `${options.id}${options.variant ? `-${options.variant}` : ''}`)
    this.userData = path.join(process.env.PIMKO_ACCEPTANCE_HOME ?? '', '.config', 'pimko')
    this.record = {
      id: options.id,
      variant: options.variant ?? '',
      mode: options.mode,
      status: '待测',
      startedAt: new Date().toISOString(),
      endedAt: '',
      executor: 'ZCode 自动化验收（GitHub Actions）',
      codeRevision: GIT_REVISION,
      platform: PLATFORM,
      userDataDir: this.userData,
      provider: envProvider(),
      keyConfigured: keyConfigured(),
      material: options.material
        ? { path: options.material, spec: options.materialSpec }
        : undefined,
      expected: options.expected,
      checks: [],
      actual: '',
      evidence: [],
      defects: [],
    }
  }

  check(name: string, pass: boolean, detail: string): void {
    this.record.checks.push({ name, pass, detail })
    if (!pass) this.record.defects.push(`${name}: ${detail}`)
  }

  async saveEvidence(name: string, data: string | Buffer, ext = 'json'): Promise<string> {
    await mkdir(this.dir, { recursive: true })
    const file = path.join(this.dir, `${name}.${ext}`)
    await writeFile(file, data)
    this.record.evidence.push(path.relative(root, file))
    return file
  }

  async screenshot(page: Page, name: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const file = path.join(this.dir, `${name}.png`)
    await page.screenshot({ path: file }).catch(() => undefined)
    this.record.evidence.push(path.relative(root, file))
  }

  async finish(status: CaseStatus, actual: string, blockedReason?: string): Promise<void> {
    this.record.status = status
    this.record.actual = actual
    this.record.endedAt = new Date().toISOString()
    if (blockedReason) this.record.blockedReason = blockedReason
    if (batchState.results) {
      if (status === '通过') batchState.results.passed++
      else if (status === '失败') batchState.results.failed++
      else if (status === '阻塞') batchState.results.blocked++
      else if (status === '限制已确认') batchState.results.limited++
      batchState.results.records.push(`${status} ${this.record.id}${this.record.variant ? `/${this.record.variant}` : ''}`)
    }
    await mkdir(this.dir, { recursive: true })
    await writeFile(path.join(this.dir, 'record.json'), JSON.stringify(this.record, null, 2))
    const mark = status === '通过' ? '✔' : status === '失败' ? '✘' : '○'
    console.log(`${mark} [${this.record.mode}] ${this.record.id}${this.record.variant ? `/${this.record.variant}` : ''}: ${status}${blockedReason ? `（${blockedReason}）` : ''}`)
  }
}

export interface LaunchOptions {
  env?: Record<string, string | undefined>
}

export interface RevisionSnapshot {
  id: string
  parentRevisionId?: string
  agentNote?: string
  feedback?: { text: string }
  timeline: {
    clips: { assetId: string; sourceStartSec: number; sourceEndSec: number; speed?: number }[]
    subtitles: { startSec: number; endSec: number; text: string }[]
    subtitleAppearance?: { visible?: boolean; size?: string; position?: string; style?: string }
    bgm?: { path: string; gainDb: number }
    transitions: { type: string; durationSec?: number }[]
  }
  settings: { width: number; height: number; fps: number }
  transcript?: { segments: { startSec: number; endSec: number; text: string; words?: { word: string; startSec: number; endSec: number }[] }[] }
}

export class AppSession {
  readonly home: string
  readonly userData: string
  private app?: ElectronApplication
  private _page?: Page
  private launchEnv: Record<string, string | undefined>

  constructor(private readonly caseCtx: Case, env: Record<string, string | undefined> = {}) {
    this.home = process.env.PIMKO_ACCEPTANCE_HOME ?? ''
    if (!this.home) throw new Error('PIMKO_ACCEPTANCE_HOME 未设置')
    this.userData = path.join(this.home, '.config', 'pimko')
    this.launchEnv = env
  }

  get page(): Page {
    if (!this._page) throw new Error('应用未启动')
    return this._page
  }

  async start(): Promise<void> {
    this.app = await electron.launch({
      executablePath: path.join(root, 'node_modules/electron/dist/electron'),
      args: [path.join(root, 'out/main/index.js'), '--no-sandbox', '--disable-gpu'],
      env: {
        ...process.env,
        HOME: this.home,
        WAYLAND_DISPLAY: '',
        DISPLAY: process.env.DISPLAY ?? ':99',
        ...this.launchEnv,
      },
    })
    this._page = await this.app.firstWindow()
    this.page.on('console', (message) => {
      if (message.type() === 'error') void this.caseCtx.saveEvidence('console-error', message.text(), 'log').catch(() => undefined)
    })
    const actualUserData = await this.app.evaluate(({ app }) => app.getPath('userData'))
    if (actualUserData !== this.userData) {
      throw new Error(`userData 隔离校验失败：实际 ${actualUserData}，期望 ${this.userData}（中止以保护真实数据）`)
    }
    await this.page.waitForLoadState('domcontentloaded')
  }

  async close(): Promise<void> {
    if (this.app) {
      await this.app.close().catch(() => undefined)
      this.app = undefined
      this._page = undefined
    }
  }

  /** 对话框 stub：video/audio 选择与保存路径。传 null 表示模拟取消。 */
  async stubDialogs(options: {
    video?: string | null
    audio?: string | null
    save?: string | null
  }): Promise<void> {
    await this.app!.evaluate(({ dialog }, stubs) => {
      const openResult = (file: string | null | undefined) =>
        file === null
          ? { canceled: true, filePaths: [], files: [] }
          : file === undefined
            ? undefined
            : { canceled: false, filePaths: [file], files: [] }
      const saveResult = (file: string | null | undefined) =>
        file === null
          ? { canceled: true, filePath: undefined }
          : file === undefined
            ? undefined
            : { canceled: false, filePath: file }
      if ('video' in stubs || 'audio' in stubs) {
        const originalOpen = dialog.showOpenDialog.bind(dialog)
        dialog.showOpenDialog = ((options: unknown) => {
          const filterName = (options as { filters?: { name?: string }[] })?.filters?.[0]?.name ?? ''
          const wantsAudio = filterName.includes('音频')
          const wanted = wantsAudio ? stubs.audio : stubs.video
          if (wanted === undefined) return originalOpen(options as never)
          return Promise.resolve(openResult(wanted))
        }) as typeof dialog.showOpenDialog
      }
      if ('save' in stubs) {
        dialog.showSaveDialog = (() => Promise.resolve(saveResult(stubs.save))) as typeof dialog.showSaveDialog
      }
    }, {
      video: options.video,
      audio: options.audio,
      save: options.save,
    } as Record<string, string | null | undefined>)
  }

  async state(projectId: string): Promise<RevisionSnapshot> {
    const result = await this.page.evaluate(async (id) => {
      const restored = await window.pimko.restoreProject(id)
      return {
        id: restored.revision.id,
        parentRevisionId: restored.revision.parentRevisionId,
        agentNote: restored.revision.agentNote,
        feedback: restored.revision.feedback,
        timeline: restored.revision.project.timeline,
        settings: restored.revision.project.settings,
        transcript: restored.revision.project.transcript,
      }
    }, projectId)
    return result as unknown as RevisionSnapshot
  }

  async listProjects(): Promise<{ projectId: string; name: string; clipCount: number; durationSec: number }[]> {
    return this.page.evaluate(() => window.pimko.listProjects())
  }

  button(name: string) {
    return this.page.getByRole('button', { name, exact: true })
  }

  async agentBubbleCount(): Promise<number> {
    return this.page.locator('.bubble.agent').count()
  }

  async importVideo(timeoutMs = 120000): Promise<void> {
    const emptyButton = this.page.getByRole('button', { name: '选择视频' })
    if (await emptyButton.isVisible().catch(() => false)) {
      await emptyButton.click()
    } else {
      await this.button('导入视频').click()
    }
    await this.page.waitForFunction(
      () => document.querySelector('video') !== null,
      undefined,
      { timeout: timeoutMs },
    )
    await this.page.waitForFunction(
      () => document.querySelectorAll('.bubble.agent').length > 0,
      undefined,
      { timeout: 10000 },
    ).catch(() => undefined)
  }

  async sendFeedback(text: string, timeoutMs = 120000): Promise<void> {
    const before = await this.agentBubbleCount()
    await this.page.getByRole('textbox', { name: '剪辑反馈' }).fill(text)
    await this.button('发送').click()
    await this.page.waitForFunction(
      (count) => document.querySelectorAll('.bubble.agent').length > count,
      before,
      { timeout: timeoutMs },
    )
  }

  /** 等待错误条出现（用于预期失败的场景）。 */
  async waitForError(timeoutMs = 60000): Promise<string> {
    await this.page.locator('.error-bar').waitFor({ state: 'visible', timeout: timeoutMs })
    return this.page.locator('.error-bar').innerText()
  }

  async undo(): Promise<void> {
    const before = await this.agentBubbleCount()
    await this.button('撤销上一步').click()
    await this.page.waitForFunction(
      (count) => document.querySelectorAll('.bubble.agent').length > count,
      before,
      { timeout: 60000 },
    )
  }

  async renderPreview(timeoutMs = 180000): Promise<string> {
    await this.button('查看实际效果').click()
    await this.page.getByRole('tab', { name: '效果预览', exact: true }).waitFor({ timeout: timeoutMs })
    return (await this.page.locator('video').getAttribute('src')) ?? ''
  }

  async exportTo(outputPath: string, timeoutMs = 300000): Promise<void> {
    await this.stubDialogs({ save: outputPath })
    await this.button('生成成片').click()
    await this.page.getByRole('tab', { name: '成片预览' }).waitFor({ timeout: timeoutMs })
    await this.page.waitForFunction(() => {
      const video = document.querySelector('video')
      return video !== null && video.readyState >= 2 && video.videoWidth > 0 && video.playbackRate === 1
    })
  }

  async waitDraftReady(): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const video = document.querySelector('video')
        return !!video && video.readyState >= 2 && video.videoWidth > 0
      },
      undefined,
      { timeout: 30000 },
    )
  }
}

declare global {
  interface Window {
    pimko: {
      importVideo(): Promise<unknown>
      listProjects(): Promise<{ projectId: string; name: string; clipCount: number; durationSec: number }[]>
      restoreProject(id: string): Promise<{ revision: Record<string, any> }>
      revise(id: string, text: string): Promise<unknown>
      undo(id: string): Promise<unknown>
      renderPreview(id: string, revisionId: string): Promise<unknown>
      exportVideo(id: string): Promise<unknown>
      setBgm(id: string): Promise<unknown>
      setBgmVolume(id: string, gainDb: number): Promise<unknown>
      removeBgm(id: string): Promise<unknown>
    }
  }
}

export const MATERIALS = {
  F1: 'sample-assets/fixtures/talking-head-en.mp4',
  F2: 'sample-assets/fixtures/portrait-en.mp4',
  F3: 'sample-assets/fixtures/odd-dims-en.mkv',
  F4: 'sample-assets/fixtures/long-pauses.mp4',
  F5: 'sample-assets/fixtures/silent-track.mp4',
  F6: 'sample-assets/fixtures/no-audio.mp4',
  F7: 'sample-assets/fixtures/short-0.8s.mp4',
  P1: 'sample-assets/public/sintel-trailer.mp4',
  P2: 'sample-assets/public/big-buck-bunny-10s.mp4',
  P3: 'sample-assets/public/zh-speaking-portrait.mp4',
  P4: 'sample-assets/public/en-speaking.mp4',
  boundary: (file: string) => `sample-assets/boundaries/${file}`,
}

export function materialPath(relative: string): string {
  const absolute = path.join(root, relative)
  if (!existsSync(absolute)) throw new Error(`素材不存在: ${relative}（先运行 npm run fixtures / fixtures:boundaries / samples）`)
  return absolute
}

export function outDir(name: string): string {
  return path.join(batchDir(), 'exports', name)
}

export { readdir, readFile, mkdir, writeFile, rm, path, homedir, execFileAsync }
