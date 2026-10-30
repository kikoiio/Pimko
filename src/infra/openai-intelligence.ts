import type { SilenceInterval } from '../domain/analysis'
import { CONTEXTUAL_FILLERS, findFillerWords } from '../domain/fillers'
import { applyPauseCompressions, describePauseCompressions, planPauseCompressions } from '../domain/pause-compress'
import type { Feedback, Project, ProjectSettings } from '../domain/project'
import { subtitlesForClips } from '../domain/subtitles'
import { isSubtitleAppearance, type SubtitleAppearance } from '../domain/subtitle-appearance'
import { transitionDuration, type Timeline } from '../domain/timeline'
import type { Transcript } from '../domain/transcript'
import type { EditPlan, EditingIntelligence } from '../ports/intelligence'
import type { LlmConfig } from './llm-config'
import { firstJsonObject, requestJsonCompletion } from './openai-chat'

interface LlmClip {
  segmentIndex: number
  startSec: number
  endSec: number
  speed?: number
}

interface LlmPlan {
  clips: LlmClip[]
  transitions?: ('cut' | 'crossfade')[]
  subtitleAppearance?: SubtitleAppearance
  reply: string
}

function parseLlmPlan(content: string, transcript: Transcript): LlmPlan | null {
  const candidates = [content, firstJsonObject(content)].filter((value): value is string => !!value)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (isLlmPlan(parsed) && parsed.clips.every((clip) => {
        const segment = transcript.segments[clip.segmentIndex]
        return segment !== undefined && clip.startSec >= segment.startSec - 0.005001 && clip.endSec <= segment.endSec + 0.005001 && clip.endSec - clip.startSec >= 0.1
      })) return parsed
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
- subtitleAppearance 可选：{"visible":true,"size":"small|medium|large","position":"top|center|bottom","style":"bold|minimal"}，仅返回用户要求改变的字段；字幕调大/小、移上/下/居中、简洁/加粗、隐藏/显示都通过它表达；仅改字幕时保持 clips 和 transitions 不变；
- 未要求改变的现有剪辑、速度和转场必须保留；返回完整时间线，不要只返回改动部分；
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
    if (!plan || plan.clips.length === 0) {
      return {
        timeline: this.fullTimeline(transcript, silences),
        note: '模型输出无效，已按确定性预剪(停顿压缩)建稿，请继续对话调整。',
      }
    }
    return { timeline: this.toTimeline(plan, transcript, transcript.assetId), note: plan.reply }
  }

  async reviseTimeline(project: Project, feedback: Feedback): Promise<EditPlan> {
    if (!project.transcript) throw new Error('这个旧项目缺少原始转写，请重新导入素材后修改。')
    const transcript = project.transcript
    const current = project.timeline.clips
      .map((clip, index) => {
        const transition = project.timeline.transitions[index]
        const ending = transition?.type === 'crossfade' ? `，随后叠化 ${transitionDuration(transition)}s` : ''
        return `第${index + 1}段: ${clip.sourceStartSec.toFixed(2)}-${clip.sourceEndSec.toFixed(2)}，${clip.speed ?? 1}倍速${ending}`
      })
      .join('\n')
    const plan = await this.plan(
      transcript,
      `当前时间线：\n${current}\n当前字幕外观：${JSON.stringify(project.timeline.subtitleAppearance ?? {})}\n\n用户反馈：${feedback.text}${this.silenceBlock(project.silences)}`,
    )
    if (!plan) {
      // 重试耗尽仍无效：宁可报错也不静默沿用旧时间线，让用户知道这轮没生效。
      throw new Error('模型连续返回无效结果，已保留上一版。请稍后重试或换个说法。')
    }
    return {
      timeline: {
        ...this.toTimeline(plan, transcript, project.assets[0]!.id),
        ...(project.timeline.bgm ? { bgm: project.timeline.bgm } : {}),
        ...((project.timeline.subtitleAppearance || plan.subtitleAppearance) ? {
          subtitleAppearance: { ...project.timeline.subtitleAppearance, ...plan.subtitleAppearance },
        } : {}),
      },
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
    const segments = transcript.segments
      .map((segment, index) => {
        // 语速密度进 prompt:LLM 判断"别再加速"或"这段可以 1.3x"的依据。
        const density = segment.text.replace(/\s/g, '').length / Math.max(0.1, segment.endSec - segment.startSec)
        const words = segment.words?.map((word) => `${JSON.stringify(word.word)}@${word.startSec.toFixed(2)}-${word.endSec.toFixed(2)}`).join(' ')
        return `${index}: ${segment.startSec.toFixed(2)}-${segment.endSec.toFixed(2)}（${density.toFixed(1)}字/s） ${segment.text}${words ? `\n词级时间：${words}` : ''}`
      })
      .join('\n')
    return requestJsonCompletion(
      this.config,
      {
        system: SYSTEM_PROMPT,
        user: `转写片段（index: 起止秒 文本）：\n${segments}${this.fillerBlock(transcript)}\n\n${userMessage}`,
        parse: (content) => parseLlmPlan(content, transcript),
      },
    )
  }

  private toTimeline(plan: LlmPlan, transcript: Transcript, assetId: string): Timeline {
    const llmClips = plan.clips
    const clips: Timeline['clips'] = []
    for (const llmClip of llmClips) {
      const segment = transcript.segments[llmClip.segmentIndex]
      if (!segment) continue
      const start = clamp(llmClip.startSec, segment.startSec, segment.endSec)
      const end = clamp(llmClip.endSec, segment.startSec, segment.endSec)
      if (end - start < 0.1) continue
      const speed = llmClip.speed !== undefined ? clamp(llmClip.speed, 0.5, 2) : 1
      clips.push({
        assetId,
        sourceStartSec: start,
        sourceEndSec: end,
        ...(speed !== 1 ? { speed } : {}),
      })
    }
    if (clips.length === 0) throw new Error('这次修改会让成片变空，已保留上一版。')
    return {
      clips,
      subtitles: subtitlesForClips(transcript, clips),
      ...(plan.subtitleAppearance ? { subtitleAppearance: plan.subtitleAppearance } : {}),
      transitions: clips.slice(1).map((clip, index) => {
        const previous = clips[index]!
        const durationSec = Math.min(0.3,
          (previous.sourceEndSec - previous.sourceStartSec) / (previous.speed ?? 1) / 2,
          (clip.sourceEndSec - clip.sourceStartSec) / (clip.speed ?? 1) / 2,
        )
        return plan.transitions?.[index] === 'crossfade'
          ? { type: 'crossfade', durationSec }
          : { type: 'cut' }
      }),
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
      subtitles: subtitlesForClips(transcript, clips),
      transitions: clips.slice(1).map(() => ({ type: 'cut' as const })),
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 客户端 schema 校验：OpenRouter 的结构化输出只按端点尽力而为，不能信任原生约束。 */
function isLlmPlan(value: unknown): value is LlmPlan {
  if (typeof value !== 'object' || value === null) return false
  const { clips, reply, transitions } = value as { clips?: unknown; reply?: unknown; transitions?: unknown }
  if ('subtitleAppearance' in value && !isSubtitleAppearance(value.subtitleAppearance)) return false
  if (!Array.isArray(clips)) return false
  for (const clip of clips) {
    if (typeof clip !== 'object' || clip === null) return false
    const { segmentIndex, startSec, endSec, speed } = clip as Record<string, unknown>
    if (typeof segmentIndex !== 'number' || !Number.isInteger(segmentIndex) || segmentIndex < 0) return false
    if (typeof startSec !== 'number' || typeof endSec !== 'number') return false
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return false
    if (speed !== undefined) {
      if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 2) return false
    }
  }
  if (typeof reply !== 'string' || !reply.trim()) return false
  if (transitions !== undefined) {
    if (!Array.isArray(transitions) || transitions.length !== Math.max(0, clips.length - 1)) return false
    for (const transition of transitions) {
      if (transition !== 'cut' && transition !== 'crossfade') return false
    }
  }
  return true
}
