import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { loadDotEnv } from '../src/infra/env'
import { loadLlmConfig } from '../src/infra/llm-config'
import { createIntelligence, createPlanner, createTranscriber } from '../src/infra/ai-factory'
import { FfmpegProber } from '../src/infra/ffmpeg-prober'
import { FfmpegRenderer } from '../src/infra/ffmpeg-renderer'
import { FfmpegInspector } from '../src/infra/ffmpeg-inspector'
import { FfmpegSceneAnalyzer } from '../src/infra/ffmpeg-scene-analyzer'
import { FfmpegSilenceAnalyzer } from '../src/infra/ffmpeg-silence-analyzer'
import { VisualPlanner } from '../src/infra/visual-planner'
import { FsProjectStore } from '../src/infra/fs-store'
import { Editor } from '../src/services/editor'

const PROMPTS = [
  '开头太拖，收紧到直接进正题',
  '去掉口癖和废话，让语言更紧凑',
  '第一段 1.5 倍速，其余保持',
  '把结尾的高潮句移到开头',
  '字幕大一点，放到上方',
  '整体节奏再快一点，但不要切词',
  '保留完整句子，只删重复和停顿',
  '把最有力的一句留到最后',
]

async function main(): Promise<void> {
  await loadDotEnv()
  const config = loadLlmConfig()
  const video = process.env.PIMKO_XUNFEI_VIDEO ?? 'sample-assets/public/en-speaking.mp4'
  if (!existsSync(video)) throw new Error(`找不到测试素材: ${video}（CI 需要先 npm run samples）`)
  const rounds = Math.max(1, Math.min(30, Number(process.env.PIMKO_XUNFEI_ROUNDS ?? '8')))
  const outRoot = path.resolve(process.env.PIMKO_XUNFEI_OUT ?? '.tmp/xunfei-e2e')
  await rm(outRoot, { recursive: true, force: true })
  await mkdir(outRoot, { recursive: true })
  const planner = createPlanner(config)
  const editor = new Editor({
    prober: new FfmpegProber(),
    transcriber: createTranscriber(config),
    intelligence: createIntelligence(config),
    planner,
    visualPlanner: new VisualPlanner({ analyzer: new FfmpegSceneAnalyzer(), transcriptPlanner: planner }),
    renderer: new FfmpegRenderer(),
    inspector: new FfmpegInspector(),
    store: new FsProjectStore(path.join(outRoot, 'projects')),
    silenceAnalyzer: new FfmpegSilenceAnalyzer(),
  })

  const result: Record<string, unknown> = {
    provider: config.provider,
    model: config.model ?? null,
    baseUrl: config.baseUrl ?? null,
    video,
    rounds,
    steps: [],
  }
  let last = await editor.createDraft(video, 'XUNFEI E2E')
  result.transcriptSegments = last.project.transcript?.segments.length ?? 0
  result.words = last.project.transcript?.segments.reduce((sum, segment) => sum + (segment.words?.length ?? 0), 0) ?? 0
  result.draftNote = last.agentNote ?? null

  for (let index = 0; index < rounds; index++) {
    const feedback = PROMPTS[index % PROMPTS.length]!
    const startedAt = Date.now()
    try {
      const next = await editor.revise(last.project.id, { text: feedback })
      last = next
      result.steps = [...(result.steps as unknown[]), {
        round: index + 1,
        feedback,
        ok: true,
        note: next.agentNote ?? null,
        diff: next.diff ?? null,
        durationSec: next.project.timeline.clips.reduce(
          (sum, clip) => sum + (clip.sourceEndSec - clip.sourceStartSec) / (clip.speed ?? 1),
          0,
        ),
        elapsedMs: Date.now() - startedAt,
      }]
    } catch (error) {
      result.steps = [...(result.steps as unknown[]), {
        round: index + 1,
        feedback,
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }]
    }
  }

  const outputPath = path.join(outRoot, 'final.mp4')
  try {
    const exported = await editor.export(last.project.id, outputPath)
    result.export = {
      outputPath,
      durationSec: exported.durationSec,
      quality: exported.quality,
    }
  } catch (error) {
    result.export = { error: error instanceof Error ? error.message : String(error) }
  }
  result.failedRounds = (result.steps as Array<{ ok: boolean }>).filter((step) => !step.ok).length
  console.log(JSON.stringify(result, null, 2))
  // 单轮瞬断不掩盖最终导出结果；严格模式用 PIMKO_XUNFEI_STRICT=1 把失败轮次变成非零退出。
  const strict = process.env.PIMKO_XUNFEI_STRICT === '1'
  const exportOk = result.export !== undefined && !(result.export as { error?: string }).error
  if (!exportOk || (strict && (result.failedRounds as number) > 0)) process.exitCode = 1
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
