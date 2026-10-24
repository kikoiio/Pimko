import type { Feedback, Project, ProjectSettings } from '../domain/project'
import type { Timeline } from '../domain/timeline'
import type { Transcript } from '../domain/transcript'
import type { EditPlan, EditingIntelligence } from '../ports/intelligence'
import type { LlmConfig } from './llm-config'

interface LlmClip {
  segmentIndex: number
  startSec: number
  endSec: number
}

interface LlmPlan {
  clips: LlmClip[]
  reply: string
}

const SYSTEM_PROMPT = `你是资深短视频剪辑师，服务对象是完全不懂剪辑的用户。
根据口播转写片段和用户反馈，决定保留哪些片段、如何微调边界。
只返回 JSON，不要输出任何其他文字，格式：
{"clips":[{"segmentIndex":0,"startSec":0.0,"endSec":4.2}],"reply":"给用户的一句中文说明"}
规则：
- clips 按播放顺序排列，只使用给出的 segmentIndex；
- startSec/endSec 必须落在对应转写片段时间内，可微调边界但不能跨越相邻片段；
- 用户要求更紧凑时，优先删除口癖、重复、停顿，而不是加速；
- reply 用一句中文说明你做了什么。`

export class OpenAiIntelligence implements EditingIntelligence {
  constructor(private readonly config: LlmConfig) {}

  async draftTimeline(transcript: Transcript, settings: ProjectSettings): Promise<EditPlan> {
    const plan = await this.plan(transcript, '这是初始草稿：请保留全部有效内容，只剪掉明显的口癖和长停顿。')
    if (!plan) {
      return {
        timeline: this.fullTimeline(transcript),
        note: '模型输出无效，已先用完整时间线建稿，请继续对话调整。',
      }
    }
    return { timeline: this.toTimeline(plan.clips, transcript, transcript.assetId), note: plan.reply }
  }

  async reviseTimeline(project: Project, feedback: Feedback): Promise<EditPlan> {
    const transcript = project.transcript ?? this.reconstructTranscript(project)
    const current = project.timeline.clips
      .map((clip, index) => `第${index + 1}段: ${clip.sourceStartSec.toFixed(2)}-${clip.sourceEndSec.toFixed(2)}`)
      .join('\\n')
    const plan = await this.plan(
      transcript,
      `当前时间线：\n${current}\n\n用户反馈：${feedback.text}`,
    )
    if (!plan) {
      // 重试耗尽仍无效：宁可报错也不静默沿用旧时间线，让用户知道这轮没生效。
      throw new Error('模型连续返回无效结果，已保留上一版。请稍后重试或换个说法。')
    }
    return {
      timeline: this.toTimeline(plan.clips, transcript, project.assets[0]!.id),
      note: plan.reply,
    }
  }

  private async plan(transcript: Transcript, userMessage: string): Promise<LlmPlan | null> {
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1'
    const segments = transcript.segments
      .map(
        (segment, index) =>
          `${index}: ${segment.startSec.toFixed(2)}-${segment.endSec.toFixed(2)} ${segment.text}`,
      )
      .join('\n')
    const body: Record<string, unknown> = {
      model: this.config.model ?? 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `转写片段（index: 起止秒 文本）：\n${segments}\n\n${userMessage}` },
      ],
    }
    // OpenRouter 的结构化输出按端点"尽力而为"；该参数只把请求路由到强制 schema 的端点。
    if (baseUrl.includes('openrouter.ai')) body.require_parameters = true

    // 最多 3 次尝试：偶发非法 JSON / 越界字段时重试，而不是静默降级。
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        throw new Error(`LLM 请求失败: ${response.status} ${await response.text()}`)
      }
      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] }
      const content = data.choices?.[0]?.message?.content
      if (!content) continue
      try {
        const parsed = JSON.parse(content) as unknown
        if (isLlmPlan(parsed)) return parsed
      } catch {
        // 非法 JSON，进入下一次重试
      }
    }
    return null
  }

  private toTimeline(llmClips: LlmClip[], transcript: Transcript, assetId: string): Timeline {
    const clips: Timeline['clips'] = []
    for (const llmClip of llmClips) {
      const segment = transcript.segments[llmClip.segmentIndex]
      if (!segment) continue
      const start = clamp(llmClip.startSec, segment.startSec, segment.endSec)
      const end = clamp(llmClip.endSec, segment.startSec, segment.endSec)
      if (end - start < 0.2) continue
      clips.push({ assetId, sourceStartSec: start, sourceEndSec: end })
    }
    if (clips.length === 0) return this.fullTimeline(transcript)
    return {
      clips,
        subtitles: transcript.segments.flatMap((segment) => {
          const clip = clips.find(
            (candidate) => Math.max(segment.startSec, candidate.sourceStartSec) < Math.min(segment.endSec, candidate.sourceEndSec),
          )
          if (!clip) return []
          return [{
            startSec: Math.max(segment.startSec, clip.sourceStartSec),
            endSec: Math.min(segment.endSec, clip.sourceEndSec),
            text: segment.text,
          }]
        }),
      transitions: clips.slice(1).map(() => ({ type: 'cut' as const })),
    }
  }

  private fullTimeline(transcript: Transcript): Timeline {
    return {
      clips: transcript.segments.map((segment) => ({
        assetId: transcript.assetId,
        sourceStartSec: segment.startSec,
        sourceEndSec: segment.endSec,
      })),
      subtitles: transcript.segments.map(({ startSec, endSec, text }) => ({ startSec, endSec, text })),
      transitions: transcript.segments.slice(1).map(() => ({ type: 'cut' as const })),
    }
  }

  private reconstructTranscript(project: Project): Transcript {
    // 单素材 MVP：转写可由时间线 + 字幕重建，供 LLM 看到当前片段内容。
    const asset = project.assets[0]!
    const segments = project.timeline.subtitles.map((cue) => ({
      startSec: cue.startSec,
      endSec: cue.endSec,
      text: cue.text,
      confidence: 1,
    }))
    return { assetId: asset.id, language: 'zh-CN', segments }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 客户端 schema 校验：OpenRouter 的结构化输出只按端点尽力而为，不能信任原生约束。 */
function isLlmPlan(value: unknown): value is LlmPlan {
  if (typeof value !== 'object' || value === null) return false
  const { clips, reply } = value as { clips?: unknown; reply?: unknown }
  if (!Array.isArray(clips)) return false
  for (const clip of clips) {
    if (typeof clip !== 'object' || clip === null) return false
    const { segmentIndex, startSec, endSec } = clip as Record<string, unknown>
    if (typeof segmentIndex !== 'number' || !Number.isInteger(segmentIndex) || segmentIndex < 0) return false
    if (typeof startSec !== 'number' || typeof endSec !== 'number') return false
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return false
  }
  if (reply !== undefined && typeof reply !== 'string') return false
  return true
}
