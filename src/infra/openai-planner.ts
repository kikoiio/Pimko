import { baselinePlan } from '../domain/baseline'
import { compile, type CompiledTimeline } from '../domain/compiler'
import type { ContentKind, EditDocument, Transition } from '../domain/document'
import {
  applyPlan,
  validatePlan,
  type EditOp,
  type EditPlan,
  type PlanContext,
} from '../domain/edit-plan'
import { isSubtitleAppearance } from '../domain/subtitle-appearance'
import type { Transcript } from '../domain/transcript'
import type { Planner, PlannerInput } from '../ports/planner'
import type { LlmConfig } from './llm-config'
import {
  firstJsonObject,
  requestJsonCompletion,
  type JsonCompletionOptions,
} from './openai-chat'

/**
 * 真实模型 planner：模型只输出补丁 ops，绝不返回完整时间线。
 * - draft：本地 baselinePlan 先给确定性初剪，模型只在其上追加语义补丁；
 * - revise：模型按当前文档/编译片段返回补丁，本地 validatePlan 拒绝非法引用与清空；
 * - draft 模型失败回退 baseline（note 标注原因），revise 失败抛错，由 Editor 保留上一版。
 */

const CONTENT_KINDS: ContentKind[] = ['speech', 'visual', 'tutorial', 'mixed']

const SYSTEM_PROMPT = `你是资深短视频剪辑师，服务对象是完全不懂剪辑的用户。
你的唯一任务是根据转写、当前剪辑和用户反馈，返回一份“补丁计划”，不要返回完整时间线。

只返回一个 JSON 对象，不要输出任何其他文字：
{"ops":[...],"note":"一句中文说明"}

ops 里只允许以下 8 种操作：
- keep：新增/插入源区间 {"kind":"keep","assetId":"素材id","startSec":0.0,"endSec":4.2,"speed":1.0,"reason":"..."}
- drop：删除片段 {"kind":"drop","clipIds":["clip-1"],"reason":"..."}
- trim：裁掉片段入点或出点 {"kind":"trim","clipId":"clip-1","edge":"in","amountSec":0.5,"reason":"..."}（edge 只能是 in/out）
- speed：变速 {"kind":"speed","clipIds":["clip-1"],"speed":1.25,"reason":"..."}
- reorder：重排 {"kind":"reorder","clipIds":["clip-2","clip-1"],"reason":"..."}
- transition：设置与前一镜头的衔接 {"kind":"transition","clipId":"clip-2","transition":{"type":"crossfade","durationSec":0.3},"reason":"..."}（硬切为 {"type":"cut"}）
- setBgm：替换配乐 {"kind":"setBgm","assetId":"素材id","gainDb":-18}
- setSubtitle：字幕开关/外观 {"kind":"setSubtitle","enabled":true,"appearance":{"visible":true,"size":"large","position":"top","style":"bold"}}

规则：
- 只能引用上下文中真实出现的 clipId / assetId，不要编造 ID、时间或字段；不要输出文件路径、ffmpeg 参数或完整 timeline。
- 补丁按数组顺序原子应用；任意一条非法，本地会拒绝整份计划。
- 视频变速范围 0.5–4；trim 的 amountSec 必须大于 0；叠化 durationSec 必须大于 0。
- reorder 的 clipIds 必须恰好包含应用补丁前的全部视频片段，不重复、不遗漏。
- 初次建稿时本地已经生成确定性初剪；你的 ops 追加在初剪之后，只做有把握的语义修正（口癖、重复、废话、节奏、字幕/配乐）。可以用 keep 插入新的源区间，但新片段由本地分配 clipId，不能在同一次补丁里再次引用它。
- 修订时只返回需要改的补丁；未要求改变的片段、速度、转场、配乐、字幕必须保留；没有把握就返回空 ops。
- 不得把成片清空；返回空 ops 时 note 说明为什么不需要改。
- 可选 contentKind：speech|visual|tutorial|mixed；只有确实判断内容类型变化时才返回。
- note 必须是一句中文，说明你做了什么，或为什么没有改动。`

interface ModelPlan {
  ops: EditOp[]
  note: string
  contentKind?: ContentKind
}

interface BaselineDraft {
  plan: EditPlan
  document: EditDocument
  compiled: CompiledTimeline
}

export class OpenAiPlanner implements Planner {
  constructor(
    private readonly config: LlmConfig,
    private readonly completionOptions: JsonCompletionOptions = {},
  ) {}

  async propose(input: PlannerInput): Promise<EditPlan> {
    if (input.mode === 'draft') return this.draft(input)
    return this.revise(input)
  }

  private async draft(input: PlannerInput): Promise<EditPlan> {
    if (!input.transcript) {
      throw new Error('真实模型草稿需要可用的语音转写；没有转写时请使用视觉路径。')
    }
    const baseline = baselinePlan(
      input.transcript,
      input.silences,
      input.contentKind,
      input.assets.find((asset) => asset.id === input.transcript!.assetId)?.durationSec,
    )
    const context: PlanContext = {
      assets: input.assets,
      contentKind: baseline.contentKind,
      ...(input.transcript ? { transcript: input.transcript } : {}),
    }
    // 先本地应用确定性初剪：模型看到的 clipId 必须与最终 applyPlan 生成的一致。
    const baselineDocument = applyPlan(input.document, baseline, context)
    const baselineCompiled = compile(baselineDocument, {
      transcript: input.transcript,
      ...(input.silences ? { silences: input.silences } : {}),
      contentKind: baseline.contentKind,
    })

    try {
      const patch = await this.requestPlan(input, {
        plan: baseline,
        document: baselineDocument,
        compiled: baselineCompiled,
      })
      const contentKind = patch.contentKind ?? baseline.contentKind
      const plan: EditPlan = {
        mode: 'draft',
        contentKind,
        ops: [...baseline.ops, ...patch.ops],
        note: `${baseline.note} ${patch.note}`.trim(),
      }
      const errors = validatePlan(input.document, plan, {
        assets: input.assets,
        contentKind,
        ...(input.transcript ? { transcript: input.transcript } : {}),
      })
      if (errors.length > 0) throw new Error(`模型计划未通过本地校验：${errors.join('；')}`)
      return plan
    } catch (error) {
      return {
        ...baseline,
        note: `${baseline.note} 模型语义补丁未生效：${reasonOf(error)}；已回退确定性草稿。`,
      }
    }
  }

  private async revise(input: PlannerInput): Promise<EditPlan> {
    try {
      const patch = await this.requestPlan(input)
      const contentKind = patch.contentKind ?? input.contentKind
      const plan: EditPlan = { mode: 'revise', contentKind, ops: patch.ops, note: patch.note }
      const errors = validatePlan(input.document, plan, {
        assets: input.assets,
        contentKind,
        ...(input.transcript ? { transcript: input.transcript } : {}),
      })
      if (errors.length > 0) throw new Error(`模型计划未通过本地校验：${errors.join('；')}`)
      return plan
    } catch (error) {
      const message = reasonOf(error)
      // 已经是带“保留上一版”语义的错误就不再重复包装，避免 UI 出现两层前缀。
      if (message.includes('已保留上一版')) throw error
      throw new Error(`模型修订未生效，已保留上一版：${message}`)
    }
  }

  private async requestPlan(input: PlannerInput, baseline?: BaselineDraft): Promise<ModelPlan> {
    const allowedAssets = allowedAssetIds(input, baseline?.document)
    const user = buildUserPrompt(input, baseline)
    const plan = await requestJsonCompletion(
      this.config,
      {
        system: SYSTEM_PROMPT,
        user,
        parse: (content) => parseModelPlan(content, allowedAssets),
      },
      this.completionOptions,
    )
    if (!plan) {
      throw new Error(`模型连续返回无效结果（已尝试 ${this.completionOptions.structureAttempts ?? 3} 次）`)
    }
    return plan
  }
}

function buildUserPrompt(input: PlannerInput, baseline?: BaselineDraft): string {
  const compiled = baseline?.compiled ?? input.compiled ?? compile(input.document, {
    ...(input.transcript ? { transcript: input.transcript } : {}),
    ...(input.silences ? { silences: input.silences } : {}),
    contentKind: input.contentKind,
  })
  const sections: string[] = []
  sections.push(input.mode === 'draft'
    ? '任务：初次建稿的语义补丁。'
    : '任务：按用户反馈修订当前剪辑。')
  sections.push(`内容类型：${input.contentKind}`)
  sections.push(`可用素材（只能把这些 assetId 用在 keep/setBgm）：\n${assetBlock(input)}`)
  sections.push(input.transcript
    ? `转写（优先使用词级时间）：\n${transcriptBlock(input.transcript)}`
    : '转写：不可用')
  if (baseline) {
    sections.push(`当前文档：空（初次建稿）。\n本地确定性初剪说明：${baseline.plan.note}`)
    sections.push(`本地确定性初剪结果（下列 clipId 可直接引用）：\n${documentBlock(baseline.document, baseline.compiled)}`)
  } else {
    sections.push(`当前文档摘要：\n${documentBlock(input.document, compiled)}`)
  }
  sections.push(`用户反馈：${
    input.feedback?.text.trim()
      ? input.feedback.text.trim()
      : '（无；初次建稿只做明显有把握的修正，否则返回空 ops。）'
  }`)
  sections.push('请输出补丁计划 JSON：{"ops":[...],"note":"..."}。只返回 JSON，不要解释。')
  return sections.join('\n\n')
}

function assetBlock(input: PlannerInput): string {
  const lines = input.assets.map((asset) => (
    `${asset.id}（${asset.kind}，${asset.durationSec.toFixed(2)}s）`
  ))
  return lines.length > 0 ? lines.join('\n') : '（无）'
}

function transcriptBlock(transcript: Transcript): string {
  if (transcript.segments.length === 0) return '（空）'
  return transcript.segments
    .map((segment, index) => {
      const duration = Math.max(0.1, segment.endSec - segment.startSec)
      const density = segment.text.replace(/\s/g, '').length / duration
      const words = segment.words?.length
        ? `\n  词级：${segment.words
            .map((word) => `${JSON.stringify(word.word)}@${word.startSec.toFixed(2)}-${word.endSec.toFixed(2)}`)
            .join(' ')}`
        : ''
      return `段${index}: ${segment.startSec.toFixed(2)}-${segment.endSec.toFixed(2)}s（${density.toFixed(1)}字/s） ${segment.text}${words}`
    })
    .join('\n')
}

function documentBlock(document: EditDocument, compiled: CompiledTimeline): string {
  const lines: string[] = []
  if (compiled.videoClips.length === 0) {
    lines.push('视频片段：无')
  } else {
    lines.push('视频片段（按输出顺序；clipId 只能引用这些）：')
    compiled.videoClips.forEach((clip, index) => {
      const transition = clip.transitionIn.type === 'crossfade'
        ? `叠化 ${clip.transitionIn.durationSec.toFixed(2)}s`
        : '硬切'
      lines.push(
        `${index + 1}. ${clip.id} | 素材 ${clip.assetId} | 源 ${clip.sourceStartSec.toFixed(2)}-${clip.sourceEndSec.toFixed(2)}s` +
        ` | ${clip.speed}x | 输出 ${clip.outputStartSec.toFixed(2)}-${clip.outputEndSec.toFixed(2)}s | ${transition} | ${clip.role}`,
      )
    })
  }
  lines.push(`字幕：${document.subtitle.enabled ? '开启' : '关闭'}；外观 ${JSON.stringify(document.subtitle.appearance)}`)
  lines.push(compiled.bgm
    ? `配乐：${compiled.bgm.id}（素材 ${compiled.bgm.assetId}，${compiled.bgm.gainDb}dB，循环）`
    : '配乐：无')
  lines.push(`成片时长：${compiled.durationSec.toFixed(2)}s`)
  if (compiled.warnings.length > 0) lines.push(`编译警告：${compiled.warnings.join('；')}`)
  return lines.join('\n')
}

function allowedAssetIds(input: PlannerInput, baselineDocument?: EditDocument): Set<string> {
  const ids = new Set(input.assets.map((asset) => asset.id))
  for (const track of input.document.tracks) {
    for (const clip of track.clips) ids.add(clip.assetId)
  }
  if (baselineDocument) {
    for (const track of baselineDocument.tracks) {
      for (const clip of track.clips) ids.add(clip.assetId)
    }
  }
  return ids
}

function parseModelPlan(content: string, allowedAssets: ReadonlySet<string>): ModelPlan | null {
  const candidates = [content, firstJsonObject(content)].filter((value): value is string => !!value)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      const plan = toModelPlan(parsed, allowedAssets)
      if (plan) return plan
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null
}

function toModelPlan(value: unknown, allowedAssets: ReadonlySet<string>): ModelPlan | null {
  if (!isRecord(value)) return null
  if (!Array.isArray(value.ops)) return null
  if (typeof value.note !== 'string' || value.note.trim().length === 0) return null
  let contentKind: ContentKind | undefined
  if (value.contentKind !== undefined) {
    if (!isContentKind(value.contentKind)) return null
    contentKind = value.contentKind
  }
  const ops: EditOp[] = []
  for (const raw of value.ops) {
    const op = parseOp(raw, allowedAssets)
    if (!op) return null
    ops.push(op)
  }
  return {
    ops,
    note: value.note.trim(),
    ...(contentKind !== undefined ? { contentKind } : {}),
  }
}

function parseOp(value: unknown, allowedAssets: ReadonlySet<string>): EditOp | null {
  if (!isRecord(value)) return null
  switch (value.kind) {
    case 'keep': {
      const assetId = asNonEmptyString(value.assetId)
      const startSec = asFiniteNumber(value.startSec)
      const endSec = asFiniteNumber(value.endSec)
      if (!assetId || !allowedAssets.has(assetId) || startSec === undefined || endSec === undefined) return null
      let speed: number | undefined
      if (value.speed !== undefined) {
        speed = asFiniteNumber(value.speed)
        if (speed === undefined) return null
      }
      return {
        kind: 'keep',
        assetId,
        startSec,
        endSec,
        ...(speed !== undefined ? { speed } : {}),
        ...reasonOfOp(value.reason),
      }
    }
    case 'drop': {
      const clipIds = asStringArray(value.clipIds)
      return clipIds ? { kind: 'drop', clipIds, ...reasonOfOp(value.reason) } : null
    }
    case 'trim': {
      const clipId = asNonEmptyString(value.clipId)
      const amountSec = asFiniteNumber(value.amountSec)
      if (!clipId || amountSec === undefined) return null
      if (value.edge !== 'in' && value.edge !== 'out') return null
      return {
        kind: 'trim',
        clipId,
        edge: value.edge,
        amountSec,
        ...reasonOfOp(value.reason),
      }
    }
    case 'speed': {
      const clipIds = asStringArray(value.clipIds)
      const speed = asFiniteNumber(value.speed)
      if (!clipIds || speed === undefined) return null
      return { kind: 'speed', clipIds, speed, ...reasonOfOp(value.reason) }
    }
    case 'reorder': {
      const clipIds = asStringArray(value.clipIds)
      return clipIds ? { kind: 'reorder', clipIds, ...reasonOfOp(value.reason) } : null
    }
    case 'transition': {
      const clipId = asNonEmptyString(value.clipId)
      const transition = asTransition(value.transition)
      if (!clipId || !transition) return null
      return { kind: 'transition', clipId, transition, ...reasonOfOp(value.reason) }
    }
    case 'setBgm': {
      const assetId = asNonEmptyString(value.assetId)
      if (!assetId || !allowedAssets.has(assetId)) return null
      let gainDb: number | undefined
      if (value.gainDb !== undefined) {
        gainDb = asFiniteNumber(value.gainDb)
        if (gainDb === undefined) return null
      }
      return { kind: 'setBgm', assetId, ...(gainDb !== undefined ? { gainDb } : {}) }
    }
    case 'setSubtitle': {
      const enabled = value.enabled
      const appearance = value.appearance
      if (enabled !== undefined && typeof enabled !== 'boolean') return null
      if (appearance !== undefined && !isSubtitleAppearance(appearance)) return null
      if (enabled === undefined && appearance === undefined) return null
      return {
        kind: 'setSubtitle',
        ...(enabled !== undefined ? { enabled } : {}),
        ...(appearance !== undefined ? { appearance } : {}),
      }
    }
    default:
      return null
  }
}

function asTransition(value: unknown): Transition | null {
  if (!isRecord(value)) return null
  if (value.type === 'cut') return { type: 'cut' }
  if (value.type === 'crossfade') {
    const durationSec = asFiniteNumber(value.durationSec)
    return durationSec !== undefined ? { type: 'crossfade', durationSec } : null
  }
  return null
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const strings = value.map(asNonEmptyString)
  return strings.every((entry): entry is string => entry !== undefined) ? strings : null
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function reasonOfOp(value: unknown): { reason?: string } {
  const reason = asNonEmptyString(value)
  return reason ? { reason } : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isContentKind(value: unknown): value is ContentKind {
  return typeof value === 'string' && (CONTENT_KINDS as string[]).includes(value)
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim()
}
