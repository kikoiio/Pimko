import type { SilenceInterval } from '../domain/analysis'
import { CONTEXTUAL_FILLERS, findFillerWords } from '../domain/fillers'
import { applyPauseCompressions, describePauseCompressions, planPauseCompressions } from '../domain/pause-compress'
import type { Feedback, Project, ProjectSettings } from '../domain/project'
import type { Timeline } from '../domain/timeline'
import type { Transcript } from '../domain/transcript'
import type { EditPlan, EditingIntelligence } from '../ports/intelligence'
import type { LlmConfig } from './llm-config'

interface LlmClip {
  segmentIndex: number
  startSec: number
  endSec: number
  speed?: number
}

interface LlmPlan {
  clips: LlmClip[]
  transitions?: ('cut' | 'crossfade')[]
  reply: string
}

/** 从模型输出里取第一个完整的 JSON 对象：兼容 ```json 围栏、前后解释文字。 */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

function parseLlmPlan(content: string): LlmPlan | null {
  const candidates = [content, firstJsonObject(content)].filter((value): value is string => !!value)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (isLlmPlan(parsed)) return parsed
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null
}

const SYSTEM_PROMPT = `你是资深短视频剪辑师，服务对象是完全不懂剪辑的用户。
根据口播转写片段和用户反馈，决定保留哪些片段、如何微调边界、以及片段的播放速度。
只返回 JSON，不要输出任何其他文字，格式：
{"clips":[{"segmentIndex":0,"startSec":0.0,"endSec":4.2,"speed":1.5}],"transitions":["cut","crossfade"],"reply":"给用户的一句中文说明"}
规则：
- clips 按播放顺序排列，只使用给出的 segmentIndex，可重排；
- startSec/endSec 必须落在对应转写片段时间内，可微调边界但不能跨越相邻片段；
- speed 可选，范围 0.5–2.0，缺省或 1 为原速；用户嫌某段啰嗦但内容要保留时，优先设 1.2–1.5 倍速而不是删除；
- transitions 可选，长度为 clips 数减一，描述相邻片段衔接；口播默认全 "cut"，用户明确要柔和/叠化衔接时才用 "crossfade"；
- 用户要求更紧凑时，优先删除口癖、重复、停顿，其次适度变速；
- 转写下方会给出机械检测的固定口癖与语境口癖：固定口癖默认删除，语境口癖由你判断是否有语义；
- 删除口癖的方法是把所在片段拆成两段、绕开该词的起止时间（同一 segmentIndex 可对应多个 clips）；
- reply 用一句中文说明你做了什么，有变速时说明哪段变速多少。`

export class OpenAiIntelligence implements EditingIntelligence {
  constructor(private readonly config: LlmConfig) {}

  async draftTimeline(
    transcript: Transcript,
    settings: ProjectSettings,
    silences?: SilenceInterval[],
  ): Promise<EditPlan> {
    const plan = await this.plan(
      transcript,
      `这是初始草稿：请保留全部有效内容，只剪掉明显的口癖和长停顿。${this.silenceBlock(silences)}`,
    )
    if (!plan) {
      return {
        timeline: this.fullTimeline(transcript, silences),
        note: '模型输出无效，已按确定性预剪(停顿压缩)建稿，请继续对话调整。',
      }
    }
    return { timeline: this.toTimeline(plan, transcript, transcript.assetId), note: plan.reply }
  }

  async reviseTimeline(project: Project, feedback: Feedback): Promise<EditPlan> {
    const transcript = project.transcript ?? this.reconstructTranscript(project)
    const current = project.timeline.clips
      .map((clip, index) => `第${index + 1}段: ${clip.sourceStartSec.toFixed(2)}-${clip.sourceEndSec.toFixed(2)}`)
      .join('\\n')
    const plan = await this.plan(
      transcript,
      `当前时间线：\n${current}\n\n用户反馈：${feedback.text}${this.silenceBlock(project.silences)}`,
    )
    if (!plan) {
      // 重试耗尽仍无效：宁可报错也不静默沿用旧时间线，让用户知道这轮没生效。
      throw new Error('模型连续返回无效结果，已保留上一版。请稍后重试或换个说法。')
    }
    return {
      timeline: this.toTimeline(plan, transcript, project.assets[0]!.id),
      note: plan.reply,
    }
  }

  /** 口癖检测走词级时间戳：固定词机械列出，语境词交给 LLM 判断。 */
  private fillerBlock(transcript: Transcript): string {
    const fixed = findFillerWords(transcript)
    const contextual = findFillerWords(transcript, CONTEXTUAL_FILLERS)
    if (fixed.length === 0 && contextual.length === 0) return ''
    const render = (hits: ReturnType<typeof findFillerWords>) =>
      hits.map((hit) => `段${hit.segmentIndex}「${hit.word}」${hit.startSec.toFixed(2)}-${hit.endSec.toFixed(2)}s`).join('；')
    const parts: string[] = []
    if (fixed.length > 0) parts.push(`固定口癖（默认删除）：${render(fixed)}`)
    if (contextual.length > 0) parts.push(`语境口癖（由你判断是否有语义）：${render(contextual)}`)
    return `\n${parts.join('\n')}`
  }

  /** 静音图 + 参数化压缩提案一起进 prompt:LLM 默认采纳,可整体覆盖。 */
  private silenceBlock(silences?: SilenceInterval[]): string {
    if (!silences || silences.length === 0) return ''
    const lines = silences
      .map((interval) => `- ${interval.startSec.toFixed(2)}-${interval.endSec.toFixed(2)}s（长 ${(interval.endSec - interval.startSec).toFixed(2)}s）`)
      .join('\n')
    const edits = planPauseCompressions(silences)
    const proposal = edits.length > 0
      ? `\n预剪提案（${describePauseCompressions(edits)}）：默认采纳——把跨停顿的片段拆分、绕开压缩区间 ${edits
          .slice(0, 12)
          .map((edit) => `${edit.cutStartSec.toFixed(2)}-${edit.cutEndSec.toFixed(2)}s`)
          .join('、')}${edits.length > 12 ? ' 等' : ''}；个别停顿有表达作用时可覆盖保留。`
      : ''
    return `\n\n确定性检测到的静音/长停顿：\n${lines}${proposal}`
  }

  private async plan(transcript: Transcript, userMessage: string): Promise<LlmPlan | null> {
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1'
    const segments = transcript.segments
      .map((segment, index) => {
        // 语速密度进 prompt:LLM 判断"别再加速"或"这段可以 1.3x"的依据。
        const density = segment.text.replace(/\s/g, '').length / Math.max(0.1, segment.endSec - segment.startSec)
        return `${index}: ${segment.startSec.toFixed(2)}-${segment.endSec.toFixed(2)}（${density.toFixed(1)}字/s） ${segment.text}`
      })
      .join('\n')
    const body: Record<string, unknown> = {
      model: this.config.model ?? 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `转写片段（index: 起止秒 文本）：\n${segments}${this.fillerBlock(transcript)}\n\n${userMessage}` },
      ],
    }
    // OpenRouter 的结构化输出按端点"尽力而为"；该参数只把请求路由到强制 schema 的端点。
    // 部分免费模型不支持 response_format，命中时在下面自动降级。
    const isOpenRouter = baseUrl.includes('openrouter.ai')
    if (isOpenRouter) body.require_parameters = true

    // 限流与"端点不支持结构化输出"都不是模型答错，单独重试；JSON 解析失败才算一次尝试。
    let jsonAttempts = 0
    let rateRetries = 0
    let relaxed = !isOpenRouter
    while (jsonAttempts < 3) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const detail = await response.text()
        // 免费模型常被限流：按 Retry-After 等一会儿再试，别立刻把错误抛给用户。
        if (response.status === 429 && rateRetries < 2) {
          rateRetries++
          const retryAfter = Number(response.headers.get('retry-after'))
          const waitMs = Math.min(
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 4000 * rateRetries,
            20000,
          )
          await new Promise((resolve) => setTimeout(resolve, waitMs))
          continue
        }
        const unsupported =
          isOpenRouter &&
          (response.status === 400 || response.status === 404) &&
          /response_format|structured|require_parameters|No endpoints found/i.test(detail)
        if (unsupported && !relaxed) {
          // 该模型的端点不支持强制结构化输出：去掉参数，改用提示词约束 + 本地解析。
          relaxed = true
          delete body.require_parameters
          delete body.response_format
          continue
        }
        throw new Error(`LLM 请求失败: ${response.status} ${detail}`)
      }
      jsonAttempts++
      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] }
      const content = data.choices?.[0]?.message?.content
      if (!content) continue
      const parsed = parseLlmPlan(content)
      if (parsed) return parsed
    }
    return null
  }

  private toTimeline(plan: LlmPlan, transcript: Transcript, assetId: string): Timeline {
    const llmClips = plan.clips
    const clips: Timeline['clips'] = []
    for (const llmClip of llmClips) {
      const segment = transcript.segments[llmClip.segmentIndex]
      if (!segment) continue
      const start = clamp(llmClip.startSec, segment.startSec, segment.endSec)
      const end = clamp(llmClip.endSec, segment.startSec, segment.endSec)
      if (end - start < 0.2) continue
      const speed = llmClip.speed !== undefined ? clamp(llmClip.speed, 0.5, 2) : 1
      clips.push({
        assetId,
        sourceStartSec: start,
        sourceEndSec: end,
        ...(speed !== 1 ? { speed } : {}),
      })
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
      transitions: clips.slice(1).map((_, index) =>
        plan.transitions?.[index] === 'crossfade'
          ? { type: 'crossfade' as const, durationSec: 0.3 }
          : { type: 'cut' as const },
      ),
    }
  }

  private fullTimeline(transcript: Transcript, silences?: SilenceInterval[]): Timeline {
    const clips = applyPauseCompressions(
      transcript.segments.map((segment) => ({
        assetId: transcript.assetId,
        sourceStartSec: segment.startSec,
        sourceEndSec: segment.endSec,
      })),
      planPauseCompressions(silences),
    )
    return {
      clips,
      subtitles: transcript.segments.map(({ startSec, endSec, text }) => ({ startSec, endSec, text })),
      transitions: clips.slice(1).map(() => ({ type: 'cut' as const })),
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
  const { clips, reply, transitions } = value as { clips?: unknown; reply?: unknown; transitions?: unknown }
  if (!Array.isArray(clips)) return false
  for (const clip of clips) {
    if (typeof clip !== 'object' || clip === null) return false
    const { segmentIndex, startSec, endSec, speed } = clip as Record<string, unknown>
    if (typeof segmentIndex !== 'number' || !Number.isInteger(segmentIndex) || segmentIndex < 0) return false
    if (typeof startSec !== 'number' || typeof endSec !== 'number') return false
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return false
    if (speed !== undefined) {
      if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.25 || speed > 4) return false
    }
  }
  if (reply !== undefined && typeof reply !== 'string') return false
  if (transitions !== undefined) {
    if (!Array.isArray(transitions)) return false
    for (const transition of transitions) {
      if (transition !== 'cut' && transition !== 'crossfade') return false
    }
  }
  return true
}
