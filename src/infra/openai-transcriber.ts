import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { MediaAsset } from '../domain/media'
import type { Transcript } from '../domain/transcript'
import type { Transcriber } from '../ports/transcriber'
import { extractAudio } from './extract-audio'
import type { LlmConfig } from './llm-config'

function defaultTranscribeModel(baseUrl: string): string {
  // Groq 没有 whisper-1；OpenAI 没有 whisper-large-v3。按网关选默认模型。
  return baseUrl.includes('groq.com') ? 'whisper-large-v3' : 'whisper-1'
}

export class OpenAiTranscriber implements Transcriber {
  constructor(private readonly config: LlmConfig) {}

  async transcribe(asset: MediaAsset): Promise<Transcript> {
    const workDir = await mkdtemp(path.join(tmpdir(), 'pimko-transcribe-'))
    try {
      const audio = await readFile(await extractAudio(asset, workDir))
      const baseUrl = this.config.transcribeBaseUrl ?? this.config.baseUrl ?? 'https://api.openai.com/v1'
      const form = new FormData()
      form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'audio.mp3')
      form.append('model', this.config.transcribeModel ?? defaultTranscribeModel(baseUrl))
      form.append('response_format', 'verbose_json')
      // 词级 + 句级同时请求：句级仍是 LLM/UI 的主视图，词级供口癖删除与停顿压缩使用。
      form.append('timestamp_granularities[]', 'word')
      form.append('timestamp_granularities[]', 'segment')

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
        words?: { word: string; start: number; end: number }[]
      }
      const words = (data.words ?? [])
        .map((entry) => ({
          startSec: entry.start,
          endSec: entry.end,
          word: entry.word.trim(),
        }))
        .filter((entry) => entry.word && entry.endSec > entry.startSec)
      const segments = (data.segments ?? [])
        .filter((segment) => segment.end > segment.start)
        .map((segment) => ({
          startSec: segment.start,
          endSec: segment.end,
          text: segment.text.trim(),
          confidence: segment.avg_logprob !== undefined ? Math.exp(segment.avg_logprob) : 1,
          // 按时间重叠归属；词与句来自同一次转写，个别词越界落在重叠区间内。
          words: words.filter((word) => word.endSec > segment.start && word.startSec < segment.end),
        }))
      if (segments.length === 0) throw new Error('转写结果为空')
      return { assetId: asset.id, language: data.language ?? 'zh', segments }
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }
}
