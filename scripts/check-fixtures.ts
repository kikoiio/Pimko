import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Editor } from '../src/services/editor'
import { FfmpegProber } from '../src/infra/ffmpeg-prober'
import { FfmpegRenderer } from '../src/infra/ffmpeg-renderer'
import { FfmpegSilenceAnalyzer } from '../src/infra/ffmpeg-silence-analyzer'
import { FsProjectStore } from '../src/infra/fs-store'
import { MockIntelligence } from '../src/infra/mock-intelligence'
import { MockTranscriber } from '../src/infra/mock-transcriber'
import { createTranscriber } from '../src/infra/ai-factory'
import { loadDotEnv } from '../src/infra/env'
import { loadLlmConfig } from '../src/infra/llm-config'
import { findFillerWords } from '../src/domain/fillers'
import { resolveFfprobe } from '../src/infra/ffmpeg-bin'
import { extractAudio } from '../src/infra/extract-audio'

const execFileAsync = promisify(execFile)

/**
 * 用合成测试集 + 公开素材跑真实管线，断言素材属性、静音分析、
 * 尺寸跟随、导出正确性与边界报错。--transcribe 走真实转写（需 API Key）。
 */

interface FixtureExpectation {
  hasAudio: boolean
  sourceWidth: number
  sourceHeight: number
  minDurationSec: number
  maxDurationSec: number
  minSilences?: number
  expectError?: string
}

interface FixtureSpec {
  name: string
  extension?: 'mp4' | 'mkv'
  expectations: FixtureExpectation
}

interface Manifest {
  fixtures: FixtureSpec[]
}

const args = process.argv.slice(2)
const only = args.includes('--only')
  ? (args[args.indexOf('--only') + 1] ?? '').split(',').filter(Boolean)
  : undefined
const withTranscribe = args.includes('--transcribe')

async function probe(file: string): Promise<{ width: number; height: number; durationSec: number }> {
  const { stdout } = await execFileAsync(resolveFfprobe(), [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ])
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: { codec_type?: string; width?: number; height?: number }[]
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video')
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    durationSec: Number(parsed.format?.duration ?? 0),
  }
}

function even(value: number): number {
  return Math.round(value / 2) * 2
}

async function checkFixture(spec: FixtureSpec, fixtureDir: string, workRoot: string): Promise<void> {
  const file = path.join(fixtureDir, `${spec.name}.${spec.extension ?? 'mp4'}`)
  const expect = spec.expectations
  const info = await probe(file)
  if (info.width !== expect.sourceWidth || info.height !== expect.sourceHeight) {
    throw new Error(`${spec.name}: 源尺寸 ${info.width}x${info.height}，期望 ${expect.sourceWidth}x${expect.sourceHeight}`)
  }
  if (info.durationSec < expect.minDurationSec || info.durationSec > expect.maxDurationSec) {
    throw new Error(`${spec.name}: 时长 ${info.durationSec.toFixed(2)}s 超出期望区间`)
  }

  const editor = new Editor({
    prober: new FfmpegProber(),
    transcriber: new MockTranscriber(),
    intelligence: new MockIntelligence(),
    renderer: new FfmpegRenderer(),
    store: new FsProjectStore(path.join(workRoot, spec.name)),
    silenceAnalyzer: new FfmpegSilenceAnalyzer(),
  })

  if (expect.expectError) {
    // 无音轨提示在真实转写器的抽音频阶段：直接验证这一段，不触网。
    let message = ''
    const errorDir = await mkdtemp(path.join(workRoot, 'no-audio-'))
    try {
      await extractAudio(await new FfmpegProber().probe(file), errorDir)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    } finally {
      await rm(errorDir, { recursive: true, force: true })
    }
    if (!message) {
      // 兜底：确认 mock 管线本身不为无音轨素材报错（提示只来自真实转写器）。
      await editor.createDraft(file, spec.name)
    }
    if (!message.includes(expect.expectError)) {
      throw new Error(`${spec.name}: 期望报错含「${expect.expectError}」，实际「${message || '未报错'}」`)
    }
    console.log(`ok ${spec.name}: 正确拒绝（${expect.expectError}）`)
    return
  }

  const draft = await editor.createDraft(file, spec.name)
  if (!expect.hasAudio && draft.project.silences?.length) {
    throw new Error(`${spec.name}: 无音轨素材不应有静音分析结果`)
  }
  if (expect.minSilences !== undefined) {
    const count = draft.project.silences?.length ?? 0
    if (count < expect.minSilences) {
      throw new Error(`${spec.name}: 静音段 ${count} 少于期望 ${expect.minSilences}`)
    }
  }
  const { settings } = draft.project
  if (settings.width !== even(expect.sourceWidth) || settings.height !== even(expect.sourceHeight)) {
    throw new Error(`${spec.name}: 导出尺寸 ${settings.width}x${settings.height} 未跟随源素材`)
  }
  const output = path.join(workRoot, spec.name, 'out.mp4')
  await editor.export(draft.project.id, output)
  const exported = await probe(output)
  if (exported.width !== settings.width || exported.height !== settings.height) {
    throw new Error(`${spec.name}: 成片尺寸 ${exported.width}x${exported.height}，期望 ${settings.width}x${settings.height}`)
  }
  console.log(
    `ok ${spec.name}: ${exported.width}x${exported.height} ${exported.durationSec.toFixed(1)}s` +
      `, 静音 ${draft.project.silences?.length ?? 0} 段, 片段 ${draft.project.timeline.clips.length}`,
  )
}

interface TranscribeCheck {
  name: string
  file: string
  expectCjk?: boolean
  minFillers?: number
  minWords?: number
}

/** 真实转写检查：断言有词级时间戳；中文素材还要能识别出中文。 */
async function checkTranscription(files: TranscribeCheck[]): Promise<void> {
  await loadDotEnv()
  const config = loadLlmConfig()
  if (config.provider === 'mock') {
    console.warn('跳过真实转写检查：PIMKO_LLM_PROVIDER=mock')
    return
  }
  const transcriber = createTranscriber(config)
  const prober = new FfmpegProber()
  for (const entry of files) {
    const asset = await prober.probe(entry.file)
    const transcript = await transcriber.transcribe(asset)
    const words = transcript.segments.reduce((sum, segment) => sum + (segment.words?.length ?? 0), 0)
    const fillers = findFillerWords(transcript)
    if (transcript.segments.length === 0) throw new Error(`${entry.name}: 转写无分段`)
    if (words === 0) throw new Error(`${entry.name}: 转写无词级时间戳`)
    if (entry.minWords !== undefined && words < entry.minWords) {
      throw new Error(`${entry.name}: 只转写出 ${words} 个词，少于期望 ${entry.minWords}（素材可能被截断）`)
    }
    const text = transcript.segments.map((segment) => segment.text).join(' ')
    if (entry.expectCjk && !/[一-鿿]/.test(text)) {
      throw new Error(`${entry.name}: 期望识别出中文，实际「${text.slice(0, 60)}」`)
    }
    if (entry.minFillers !== undefined && fillers.length < entry.minFillers) {
      throw new Error(`${entry.name}: 期望至少 ${entry.minFillers} 处口癖，实际 ${fillers.length}`)
    }
    console.log(
      `ok transcribe ${entry.name}: ${transcript.segments.length} 段 / ${words} 词, 口癖 ${fillers.length}` +
        (entry.expectCjk ? `, 文本「${text.slice(0, 24)}…」` : ''),
    )
  }
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..')
  const fixtureDir = path.join(root, 'sample-assets', 'fixtures')
  const manifest = JSON.parse(await readFile(path.join(fixtureDir, 'manifest.json'), 'utf8')) as Manifest
  const selected = only ? manifest.fixtures.filter((fixture) => only.includes(fixture.name)) : manifest.fixtures
  if (selected.length === 0) throw new Error(`未找到匹配的测试素材: ${only?.join(',') ?? '全部为空'}`)

  const workRoot = await mkdtemp(path.join(tmpdir(), 'pimko-check-'))
  try {
    for (const spec of selected) {
      await checkFixture(spec, fixtureDir, workRoot)
    }

    if (withTranscribe) {
      const files: TranscribeCheck[] = [
        {
          name: 'talking-head-en',
          file: path.join(fixtureDir, 'talking-head-en.mp4'),
          minFillers: 1,
          minWords: 15,
        },
      ]
      const zhSample = path.join(root, 'sample-assets', 'public', 'zh-speaking-portrait.mp4')
      try {
        await readFile(zhSample)
        files.push({ name: 'zh-speaking-portrait', file: zhSample, expectCjk: true, minWords: 30 })
      } catch {
        console.warn('未找到公开中文素材（npm run samples），跳过中文转写检查')
      }
      await checkTranscription(files)
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
  console.log(`fixtures check passed: ${selected.length} 个素材`)
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
