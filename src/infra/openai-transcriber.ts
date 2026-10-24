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

export class OpenAiTranscriber implements Transcriber {
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
      const form = new FormData()
      form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'audio.mp3')
      form.append('model', this.config.transcribeModel ?? 'whisper-1')
      form.append('response_format', 'verbose_json')

      const baseUrl = this.config.transcribeBaseUrl ?? this.config.baseUrl ?? 'https://api.openai.com/v1'
      const response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.transcribeApiKey ?? this.config.apiKey}` },
        body: form,
      })
      if (!response.ok) {
        throw new Error(`转写请求失败: ${response.status} ${await response.text()}`)
      }
      const data = (await response.json()) as {
        language?: string
        segments?: { start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }[]
      }
      const segments = (data.segments ?? [])
        .filter((segment) => segment.end > segment.start)
        .map((segment) => ({
          startSec: segment.start,
          endSec: segment.end,
          text: segment.text.trim(),
          confidence: segment.avg_logprob !== undefined ? Math.exp(segment.avg_logprob) : 1,
        }))
      if (segments.length === 0) throw new Error('转写结果为空')
      return { assetId: asset.id, language: data.language ?? 'zh', segments }
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }
}
