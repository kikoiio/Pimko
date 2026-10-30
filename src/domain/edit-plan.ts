import type { MediaAsset } from './media'
import type { ContentKind, EditDocument, Transition, VideoClip } from './document'
import type { SubtitleAppearance } from './subtitle-appearance'
import type { Transcript } from './transcript'
import { normalizedWords, snapEndToWords, snapStartToWords } from './words'

/**
 * 补丁式编辑计划：planner 只描述要改什么，不返回完整时间线。
 * applyPlan 是唯一写文档的纯函数；任何非法操作整份拒绝。
 */

export interface KeepOp {
  kind: 'keep'
  assetId: string
  startSec: number
  endSec: number
  speed?: number
  reason?: string
}

export interface DropOp {
  kind: 'drop'
  clipIds: string[]
  reason?: string
}

export interface TrimOp {
  kind: 'trim'
  clipId: string
  edge: 'in' | 'out'
  amountSec: number
  reason?: string
}

export interface SpeedOp {
  kind: 'speed'
  clipIds: string[]
  speed: number
  reason?: string
}

export interface ReorderOp {
  kind: 'reorder'
  clipIds: string[]
  reason?: string
}

export interface TransitionOp {
  kind: 'transition'
  clipId: string
  transition: Transition
  reason?: string
}

export interface SetBgmOp {
  kind: 'setBgm'
  assetId: string
  gainDb?: number
}

export interface SetSubtitleOp {
  kind: 'setSubtitle'
  enabled?: boolean
  appearance?: SubtitleAppearance
}

export type EditOp =
  | KeepOp
  | DropOp
  | TrimOp
  | SpeedOp
  | ReorderOp
  | TransitionOp
  | SetBgmOp
  | SetSubtitleOp

export interface EditPlan {
  mode: 'draft' | 'revise'
  contentKind: ContentKind
  ops: EditOp[]
  note: string
}

export interface PlanContext {
  assets: MediaAsset[]
  contentKind?: ContentKind
  /** 单素材项目的词级转写；有词时 keep/trim 边界会吸附词界。 */
  transcript?: Transcript
  /** 多素材项目按 assetId 的转写。 */
  transcripts?: Record<string, Transcript>
}

const MIN_SPEED = 0.5
const MAX_SPEED = 4

function videoTrack(document: EditDocument) {
  return document.tracks.find((track) => track.kind === 'video')
}

function videoClips(document: EditDocument): VideoClip[] {
  return (videoTrack(document)?.clips ?? []).filter((clip): clip is VideoClip => clip.type === 'video')
}

function nextClipId(document: EditDocument): string {
  let max = 0
  for (const track of document.tracks) {
    for (const clip of track.clips) {
      const match = /^clip-(\d+)$/.exec(clip.id)
      if (match) max = Math.max(max, Number(match[1]))
    }
  }
  return `clip-${max + 1}`
}


function transcriptFor(context: PlanContext, assetId: string): Transcript | undefined {
  return context.transcripts?.[assetId] ?? (context.transcript?.assetId === assetId ? context.transcript : undefined)
}

/** 若切点落在词内部，向外扩到词边界；无词级数据时保持原值。 */
function snapStart(context: PlanContext, assetId: string, startSec: number): number {
  return snapStartToWords(normalizedWords(transcriptFor(context, assetId)), startSec)
}

function snapEnd(context: PlanContext, assetId: string, endSec: number): number {
  // 不在这里夹到素材时长：那会掩盖模型越界；baseline 自己负责把转写溢出夹紧。
  return snapEndToWords(normalizedWords(transcriptFor(context, assetId)), endSec)
}

function assetDuration(context: PlanContext, assetId: string): number | undefined {
  return context.assets.find((asset) => asset.id === assetId)?.durationSec
}

function validRange(context: PlanContext, assetId: string, startSec: number, endSec: number): string | null {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return `保留区间无效：${startSec}–${endSec}`
  }
  const duration = assetDuration(context, assetId)
  if (duration !== undefined && (startSec < -0.001 || endSec > duration + 0.001)) {
    return `保留区间 ${startSec}–${endSec} 超出素材 ${assetId} 的长度 ${duration}`
  }
  return null
}

function ensureVideoTrack(document: EditDocument) {
  const existing = videoTrack(document)
  if (existing) return
  document.tracks.unshift({ id: 'video-1', kind: 'video', clips: [] })
}

/** 把补丁应用到文档；出错抛异常，调用方保留上一版。 */
export function applyPlan(document: EditDocument, plan: EditPlan, context: PlanContext): EditDocument {
  const next = structuredClone(document)
  ensureVideoTrack(next)
  const errors: string[] = []

  for (const op of plan.ops) {
    switch (op.kind) {
      case 'keep': {
        const startSec = snapStart(context, op.assetId, op.startSec)
        let endSec = snapEnd(context, op.assetId, op.endSec)
        const duration = assetDuration(context, op.assetId)
        // 词边界留白可能把原本合法的出点推过素材末尾几十毫秒；只修这种 padding 溢出。
        if (duration !== undefined && endSec > duration && endSec - duration <= 0.1) {
          endSec = duration
        }
        const invalid = validRange(context, op.assetId, startSec, endSec)
        if (invalid) {
          errors.push(invalid)
          break
        }
        if (op.speed !== undefined && (!Number.isFinite(op.speed) || op.speed < MIN_SPEED || op.speed > MAX_SPEED)) {
          errors.push(`变速 ${op.speed} 超出 ${MIN_SPEED}–${MAX_SPEED}`)
          break
        }
        // 修订期的 keep 是“新增内容”，不能把已有片段再追加一遍；否则会重复覆盖同一段素材。
        if (plan.mode === 'revise') {
          const duplicate = videoClips(next).some(
            (existing) => existing.assetId === op.assetId
              && startSec < existing.sourceEndSec - 0.001
              && endSec > existing.sourceStartSec + 0.001,
          )
          if (duplicate) {
            errors.push(`keep 区间 ${startSec.toFixed(2)}–${endSec.toFixed(2)} 与已有片段重叠`)
            break
          }
        }
        const clip: VideoClip = {
          type: 'video',
          id: nextClipId(next),
          assetId: op.assetId,
          sourceStartSec: startSec,
          sourceEndSec: endSec,
          speed: op.speed ?? 1,
          role: plan.contentKind === 'speech' ? 'speech' : plan.contentKind === 'tutorial' ? 'screen' : 'broll',
        }
        videoTrack(next)!.clips.push(clip)
        break
      }
      case 'drop': {
        if (op.clipIds.length === 0) {
          errors.push('drop 没有指定片段')
          break
        }
        const ids = new Set(op.clipIds)
        for (const id of ids) if (!videoClips(next).some((clip) => clip.id === id)) errors.push(`找不到片段 ${id}`)
        if (errors.length > 0) break
        for (const track of next.tracks) {
          track.clips = track.clips.filter((clip) => !ids.has(clip.id))
        }
        break
      }
      case 'trim': {
        const clip = videoClips(next).find((candidate) => candidate.id === op.clipId)
        if (!clip) {
          errors.push(`找不到片段 ${op.clipId}`)
          break
        }
        if (!Number.isFinite(op.amountSec) || op.amountSec <= 0) {
          errors.push(`trim 时长无效：${op.amountSec}`)
          break
        }
        if (op.edge === 'in') clip.sourceStartSec = snapStart(context, clip.assetId, clip.sourceStartSec + op.amountSec)
        else clip.sourceEndSec = snapEnd(context, clip.assetId, clip.sourceEndSec - op.amountSec)
        if (clip.sourceEndSec - clip.sourceStartSec < 0.1) errors.push(`片段 ${op.clipId} 裁剪后过短`)
        break
      }
      case 'speed': {
        if (op.clipIds.length === 0) {
          errors.push('speed 没有指定片段')
          break
        }
        if (!Number.isFinite(op.speed) || op.speed < MIN_SPEED || op.speed > MAX_SPEED) {
          errors.push(`变速 ${op.speed} 超出 ${MIN_SPEED}–${MAX_SPEED}`)
          break
        }
        for (const id of op.clipIds) {
          const clip = videoClips(next).find((candidate) => candidate.id === id)
          if (!clip) errors.push(`找不到片段 ${id}`)
          else clip.speed = op.speed
        }
        break
      }
      case 'reorder': {
        const order = op.clipIds
        const current = videoClips(next)
        const byId = new Map(current.map((clip) => [clip.id, clip]))
        if (order.length !== current.length || new Set(order).size !== order.length || order.some((id) => !byId.has(id))) {
          errors.push('reorder 必须恰好包含当前全部片段且不重复')
          break
        }
        const track = videoTrack(next)!
        track.clips = order.map((id) => byId.get(id)!)
        break
      }
      case 'transition': {
        const clip = videoClips(next).find((candidate) => candidate.id === op.clipId)
        if (!clip) {
          errors.push(`找不到片段 ${op.clipId}`)
          break
        }
        if (op.transition.type === 'crossfade' && (!Number.isFinite(op.transition.durationSec) || op.transition.durationSec <= 0)) {
          errors.push('叠化时长必须大于 0')
          break
        }
        clip.transitionIn = op.transition
        break
      }
      case 'setBgm': {
        const track = next.tracks.find((candidate) => candidate.kind === 'audio')
        if (!track) {
          next.tracks.push({
            id: 'audio-1',
            kind: 'audio',
            clips: [{ type: 'audio', id: 'bgm-1', assetId: op.assetId, sourceStartSec: 0, sourceEndSec: 0, gainDb: op.gainDb ?? -18, role: 'bgm', loop: true }],
          })
        } else {
          track.clips = track.clips.filter((clip) => !(clip.type === 'audio' && clip.role === 'bgm'))
          track.clips.push({ type: 'audio', id: 'bgm-1', assetId: op.assetId, sourceStartSec: 0, sourceEndSec: 0, gainDb: op.gainDb ?? -18, role: 'bgm', loop: true })
        }
        break
      }
      case 'setSubtitle': {
        next.subtitle = {
          ...next.subtitle,
          ...(op.enabled !== undefined ? { enabled: op.enabled } : {}),
          appearance: { ...next.subtitle.appearance, ...op.appearance },
        }
        break
      }
    }
    if (errors.length > 0) break
  }

  if (errors.length > 0) throw new Error(errors.join('；'))
  if (videoClips(next).length === 0) throw new Error('这次修改会让成片变空，已保留上一版。')
  return next
}

/** 只校验不应用；给 planner 前置检查或测试用。 */
export function validatePlan(document: EditDocument, plan: EditPlan, context: PlanContext): string[] {
  try {
    applyPlan(document, plan, context)
    return []
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
}
