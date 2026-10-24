import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { MediaAsset } from '../domain/media'
import type { Transcript } from '../domain/transcript'
import type { Transcriber } from '../ports/transcriber'
import type { LlmConfig } from './llm-config'

const execFileAsync = promisify(execFile)

interface TranscribedSegment {
  startSec?: number
  endSec?: number
  text?: string
}

/**
 * OpenRouter 没有免费 STT 目录模型，但免费 omni 模型可通过
 * chat completions 接收 base64 音频；这里用它产出带时间码的 JSON 分段。
 */
export class OpenRouterTranscriber implements Transcriber {
  constructor(private readonly config: LlmConfig) {}

  async transcribe(asset: MediaAsset): Promise<Transcript> {
    const workDir = await mkdtemp(path.join(tmpdir(), 'pimko-transcribe-'))
    try {
      const audioPath = path.join(workDir, 'audio.mp3')
      try {
        await execFileAsync('ffmpeg', [
          '-y', '-v', 'error', '-i', asset.absolutePath, '-vn', '-ac', '1', '-ar', '16000', audioPath,
        ])
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('does not contain any stream')) {
          throw new Error('这段视频没有音轨，无法转写。请导入有说话声的口播视频，或切回 mock 模式测试界面。')
        }
        throw err
      }
      const audio = await readFile(audioPath)
      const baseUrl = this.config.transcribeBaseUrl ?? this.config.baseUrl ?? 'https://openrouter.ai/api/v1'
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.transcribeApiKey ?? this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.transcribeModel ?? 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You transcribe spoken audio. Return only JSON: {"language":"<code>","segments":[{"startSec":0.0,"endSec":1.2,"text":"..."}]}. Use second-level timestamps, split by sentence or natural pause, cover all speech.',
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Transcribe this audio with segment timestamps.' },
                { type: 'input_audio', input_audio: { data: audio.toString('base64'), format: 'mp3' } },
              ],
            },
          ],
        }),
      })
      if (!response.ok) {
        throw new Error(`转写请求失败: ${response.status} ${await response.text()}`)
      }
      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] }
      const content = data.choices?.[0]?.message?.content
      if (!content) throw new Error('转写结果为空')
      let parsed: { language?: string; segments?: TranscribedSegment[] }
      try {
        parsed = JSON.parse(content)
      } catch {
        throw new Error(`转写结果不是合法 JSON: ${content.slice(0, 200)}`)
      }
      const segments = (parsed.segments ?? [])
        .map((segment) => ({
          startSec: Number(segment.startSec),
          endSec: Number(segment.endSec),
          text: (segment.text ?? '').trim(),
          confidence: 1,
        }))
        .filter((segment) => Number.isFinite(segment.startSec) && Number.isFinite(segment.endSec) && segment.endSec > segment.startSec && segment.text)
      if (segments.length === 0) throw new Error('转写结果为空')
      return { assetId: asset.id, language: parsed.language ?? 'zh', segments }
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }
}
