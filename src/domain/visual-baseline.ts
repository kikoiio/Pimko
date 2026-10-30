import type { ContentKind } from './document'
import type { EditPlan, KeepOp } from './edit-plan'
import type { Transcript } from './transcript'
import type { BlackFrameRange, SceneShot, VisualAnalysis } from './visual'

/**
 * 视觉确定性初剪：把镜头切点变成 keep ops。
 * - 过短镜头先合并，避免成片闪切；
 * - 默认剔除黑帧；
 * - 每个片段带可读 reason，整体指标随结果返回，供 prompt/质量报告使用。
 *
 * 纯函数、确定性：同一 VisualAnalysis + 同一 options 必然同一份 EditPlan。
 */

const DEFAULT_MIN_SHOT_SEC = 0.8
const DEFAULT_MIN_FRAGMENT_SEC = 0.15
/** 至少 6 次/分钟切点才算“场景多”，避免慢节奏空镜被误判成蒙太奇。 */
const VISUAL_CUTS_PER_MINUTE = 6
/** 高于此运动值才给视觉/蒙太奇中等以上置信度。 */
const VISUAL_STRONG_MOTION = 0.02
const TUTORIAL_MIN_AVERAGE_SHOT_SEC = 4
/** 低于此运动值才考虑“录屏/教程”标签；V1 没有 OCR，必须标注低置信度。 */
const TUTORIAL_MAX_MOTION = 0.008

export interface ContentKindDecision {
  contentKind: ContentKind
  confidence: 'high' | 'medium' | 'low'
  /** 给 planner note / UI 解释为什么这样判定；无法可靠判断时明确写出。 */
  reasons: string[]
}

export function hasWordLevelTranscript(transcript?: Transcript): boolean {
  return transcript?.segments.some((segment) => (segment.words?.length ?? 0) > 0) === true
}

/** 有时间戳（词级或句级）就足以走语音基线；空转写视为没有语音。 */
export function hasUsableTranscript(transcript?: Transcript): boolean {
  return transcript?.segments.some(
    (segment) => (segment.words?.length ?? 0) > 0 || segment.text.trim().length > 0,
  ) === true
}

/**
 * 内容类型初判。规则有意保守：
 * - 词级转写 → speech；
 * - 无可用转写且镜头足够密 → visual（画面变化低时降置信度并说明可能是幻灯片/录屏）；
 * - 镜头少且画面几乎静止 → tutorial（低置信度，V1 没有 OCR）；
 * - 其余 → mixed 并说明无法可靠判断。
 */
export function decideContentKind(input: {
  transcript?: Transcript
  visual?: VisualAnalysis
}): ContentKindDecision {
  const { transcript, visual } = input

  if (hasWordLevelTranscript(transcript)) {
    const wordCount = transcript!.segments.reduce((sum, segment) => sum + (segment.words?.length ?? 0), 0)
    return {
      contentKind: 'speech',
      confidence: 'high',
      reasons: [`检测到词级转写（${wordCount} 个词），按口播处理。`],
    }
  }
  if (hasUsableTranscript(transcript)) {
    return {
      contentKind: 'speech',
      confidence: 'low',
      reasons: ['有转写但缺少词级时间戳，切点只能按句级处理。'],
    }
  }

  if (!visual || visual.shots.length === 0) {
    return {
      contentKind: 'mixed',
      confidence: 'low',
      reasons: ['没有语音转写，也没有镜头切点，无法可靠判断内容类型；按混合内容处理，建议人工确认。'],
    }
  }

  const shots = visual.shots.length
  const durationSec = visual.durationSec
  const cutsPerMinute = durationSec > 0 ? (Math.max(0, shots - 1) / durationSec) * 60 : 0
  const averageShotSec = durationSec > 0 ? durationSec / shots : 0

  if (shots >= 3 && cutsPerMinute >= VISUAL_CUTS_PER_MINUTE) {
    const lowMotion = visual.motionScore < VISUAL_STRONG_MOTION
    const reasons = [
      `没有语音转写；检测到 ${shots} 个镜头（约 ${cutsPerMinute.toFixed(1)} 次/分钟），按视觉/蒙太奇处理。`,
    ]
    if (lowMotion) {
      reasons.push('镜头多但画面变化低，也可能是静态照片蒙太奇或录屏；V1 未做 OCR，建议人工确认。')
    }
    return {
      contentKind: 'visual',
      confidence: lowMotion ? 'low' : shots >= 5 && cutsPerMinute >= 12 ? 'high' : 'medium',
      reasons,
    }
  }

  if (averageShotSec >= TUTORIAL_MIN_AVERAGE_SHOT_SEC && visual.motionScore < TUTORIAL_MAX_MOTION) {
    return {
      contentKind: 'tutorial',
      confidence: 'low',
      reasons: [
        `没有语音转写；镜头少（${shots} 个）且画面几乎静止（运动 ${visual.motionScore.toFixed(3)}），`
          + '可能是录屏/教程。V1 未做 OCR，无法确认文字可读，先按教程处理并建议人工确认。',
      ],
    }
  }

  return {
    contentKind: 'mixed',
    confidence: 'low',
    reasons: [
      `没有语音转写；镜头少（${shots} 个）或画面变化不足以判定蒙太奇，`
        + '可能是慢节奏空镜、教程或录屏；V1 未做 OCR，按混合内容处理并建议人工确认。',
    ],
  }
}

export interface VisualBaselineOptions {
  /** 计划的内容类型只影响 applyPlan 的 clip role；判定由 decideContentKind 负责。 */
  contentKind?: ContentKind
  /** 短于此时长的相邻镜头会合并（秒）。 */
  minShotSec?: number
  /** 黑帧切开的碎片短于此时长会被丢弃（秒）。 */
  minFragmentSec?: number
  /** 默认剔除黑帧。 */
  trimBlackFrames?: boolean
}

export interface VisualBaselineMetrics {
  sourceDurationSec: number
  shotCount: number
  keptClipCount: number
  /** 被合并进相邻镜头的过短镜头数。 */
  mergedShotCount: number
  droppedFragmentCount: number
  droppedFragmentSec: number
  droppedBlackSec: number
  blackRangeCount: number
  keptDurationSec: number
  averageShotSec: number
  cutsPerMinute: number
  motionScore: number
  bpm?: number
  /** 全是黑帧/无有效镜头时整段保留；调用方应提示人工确认。 */
  usedFallback: boolean
}

export interface VisualBaselineResult {
  plan: EditPlan
  metrics: VisualBaselineMetrics
}

interface ShotGroup {
  startSec: number
  endSec: number
  firstShotIndex: number
  lastShotIndex: number
  shotCount: number
  motion: number
}

interface KeptPiece {
  startSec: number
  endSec: number
  group: ShotGroup
  blackRemovedSec: number
}

export function buildVisualBaseline(
  analysis: VisualAnalysis,
  options: VisualBaselineOptions = {},
): VisualBaselineResult {
  const contentKind = options.contentKind ?? 'visual'
  const minShotSec = Math.max(0, options.minShotSec ?? DEFAULT_MIN_SHOT_SEC)
  const minFragmentSec = Math.max(0, options.minFragmentSec ?? DEFAULT_MIN_FRAGMENT_SEC)
  const durationSec = round3(Math.max(0, analysis.durationSec))
  const shots = normalizeShots(analysis.shots, durationSec)
  const blackFrames = options.trimBlackFrames === false
    ? []
    : normalizeBlackFrames(analysis.blackFrames, durationSec)
  const metrics = createMetrics(analysis, shots, blackFrames)

  if (durationSec <= 0) {
    return {
      plan: { mode: 'draft', contentKind, ops: [], note: '素材时长无效，未生成视觉草稿。' },
      metrics,
    }
  }

  if (shots.length === 0) {
    metrics.keptClipCount = 1
    metrics.keptDurationSec = durationSec
    metrics.usedFallback = true
    return {
      plan: {
        mode: 'draft',
        contentKind,
        ops: [{
          kind: 'keep',
          assetId: analysis.assetId,
          startSec: 0,
          endSec: durationSec,
          reason: '未检测到镜头切点，按整段保留',
        }],
        note: `未检测到镜头切点，已按整段 ${durationSec.toFixed(1)}s 生成草稿。`,
      },
      metrics,
    }
  }

  const groups = mergeShortShots(shots, minShotSec)
  for (const group of groups) group.motion = groupMotion(shots, group)
  metrics.mergedShotCount = Math.max(0, shots.length - groups.length)

  const pieces: KeptPiece[] = []
  for (const group of groups) {
    const split = subtractBlack(group, blackFrames)
    metrics.droppedBlackSec = round3(metrics.droppedBlackSec + split.removedSec)
    for (const piece of split.pieces) {
      const length = piece.endSec - piece.startSec
      if (length < minFragmentSec) {
        metrics.droppedFragmentCount += 1
        metrics.droppedFragmentSec = round3(metrics.droppedFragmentSec + length)
        continue
      }
      pieces.push({ ...piece, group, blackRemovedSec: split.removedSec })
    }
  }

  if (pieces.length === 0) {
    // 整段都是黑帧或只剩碎片：保留整段，避免空草稿；提示人工确认。
    metrics.keptClipCount = 1
    metrics.keptDurationSec = durationSec
    metrics.usedFallback = true
    return {
      plan: {
        mode: 'draft',
        contentKind,
        ops: [{
          kind: 'keep',
          assetId: analysis.assetId,
          startSec: 0,
          endSec: durationSec,
          reason: '画面几乎全是黑帧，保留整段以免草稿为空',
        }],
        note: `检测到 ${blackFrames.length} 段黑帧，覆盖了全部镜头；为避免空草稿按整段保留 `
          + `${durationSec.toFixed(1)}s，建议人工确认。`,
      },
      metrics,
    }
  }

  const ops: KeepOp[] = pieces.map((piece) => ({
    kind: 'keep',
    assetId: analysis.assetId,
    startSec: round3(piece.startSec),
    endSec: round3(piece.endSec),
    reason: describePiece(piece, shots.length),
  }))
  metrics.keptClipCount = ops.length
  metrics.keptDurationSec = round3(pieces.reduce((sum, piece) => sum + (piece.endSec - piece.startSec), 0))

  const noteParts = [
    `已按 ${shots.length} 个镜头生成 ${ops.length} 段视觉草稿`,
    `保留 ${metrics.keptDurationSec.toFixed(1)}s / 原 ${durationSec.toFixed(1)}s`,
  ]
  if (metrics.mergedShotCount > 0) noteParts.push(`合并 ${metrics.mergedShotCount} 个过短镜头`)
  if (metrics.droppedBlackSec > 0.05) noteParts.push(`剔除 ${metrics.droppedBlackSec.toFixed(1)}s 黑帧`)
  if (metrics.droppedFragmentCount > 0) noteParts.push(`丢弃 ${metrics.droppedFragmentCount} 个碎片`)
  if (metrics.bpm !== undefined) noteParts.push(`约 ${metrics.bpm} BPM`)

  return {
    plan: {
      mode: 'draft',
      contentKind,
      ops,
      note: `${noteParts.join('，')}。视觉草稿不会切断镜头；后续可用一句话继续调整。`,
    },
    metrics,
  }
}

function createMetrics(
  analysis: VisualAnalysis,
  shots: SceneShot[],
  blackFrames: BlackFrameRange[],
): VisualBaselineMetrics {
  const durationSec = round3(Math.max(0, analysis.durationSec))
  return {
    sourceDurationSec: durationSec,
    shotCount: shots.length,
    keptClipCount: 0,
    mergedShotCount: 0,
    droppedFragmentCount: 0,
    droppedFragmentSec: 0,
    droppedBlackSec: 0,
    blackRangeCount: blackFrames.length,
    keptDurationSec: 0,
    averageShotSec: shots.length > 0 ? round3(durationSec / shots.length) : 0,
    cutsPerMinute: durationSec > 0 ? round1((Math.max(0, shots.length - 1) / durationSec) * 60) : 0,
    motionScore: Number.isFinite(analysis.motionScore) ? round4(analysis.motionScore) : 0,
    ...(analysis.beats.bpm !== undefined ? { bpm: analysis.beats.bpm } : {}),
    usedFallback: false,
  }
}

/** 清理外部传入的镜头表：裁到素材范围、去重叠、补齐首尾空档。 */
function normalizeShots(shots: SceneShot[], durationSec: number): SceneShot[] {
  if (durationSec <= 0) return []
  const cleaned = shots
    .filter((shot) => Number.isFinite(shot.startSec) && Number.isFinite(shot.endSec))
    .map((shot) => ({
      startSec: round3(Math.max(0, Math.min(durationSec, shot.startSec))),
      endSec: round3(Math.max(0, Math.min(durationSec, shot.endSec))),
      startScore: Number.isFinite(shot.startScore) ? shot.startScore : 0,
      motion: Number.isFinite(shot.motion) ? Math.min(1, Math.max(0, shot.motion)) : 0,
    }))
    .filter((shot) => shot.endSec - shot.startSec > 0.001)
    .sort((a, b) => a.startSec - b.startSec)

  const result: SceneShot[] = []
  let cursor = 0
  for (const shot of cleaned) {
    const startSec = Math.max(cursor, shot.startSec)
    if (shot.endSec - startSec <= 0.001) continue
    result.push({ index: 0, startSec, endSec: shot.endSec, startScore: shot.startScore, motion: shot.motion })
    cursor = shot.endSec
  }
  if (result.length === 0) return []
  if (result[0]!.startSec > 0.002) {
    result.unshift({ index: 0, startSec: 0, endSec: result[0]!.startSec, startScore: 0, motion: 0 })
  }
  const last = result[result.length - 1]!
  if (last.endSec < durationSec - 0.002) {
    result.push({ index: 0, startSec: last.endSec, endSec: durationSec, startScore: 0, motion: 0 })
  }
  return result.map((shot, index) => ({ ...shot, index: index + 1 }))
}

/** 相邻短镜头累积到 minShotSec 再落成一段；尾部不足阈值的并回上一段。 */
function mergeShortShots(shots: SceneShot[], minShotSec: number): ShotGroup[] {
  const groups: ShotGroup[] = []
  let pending: ShotGroup | null = null
  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index]!
    if (pending) {
      pending.endSec = shot.endSec
      pending.lastShotIndex = index
      pending.shotCount += 1
    } else {
      pending = {
        startSec: shot.startSec,
        endSec: shot.endSec,
        firstShotIndex: index,
        lastShotIndex: index,
        shotCount: 1,
        motion: 0,
      }
    }
    if (pending.endSec - pending.startSec >= minShotSec) {
      groups.push(pending)
      pending = null
    }
  }
  if (pending) {
    const last = groups[groups.length - 1]
    if (last) {
      last.endSec = pending.endSec
      last.lastShotIndex = pending.lastShotIndex
      last.shotCount += pending.shotCount
    } else {
      groups.push(pending)
    }
  }
  return groups
}

function groupMotion(shots: SceneShot[], group: ShotGroup): number {
  let weighted = 0
  let duration = 0
  for (let index = group.firstShotIndex; index <= group.lastShotIndex; index++) {
    const shot = shots[index]!
    const length = shot.endSec - shot.startSec
    weighted += shot.motion * length
    duration += length
  }
  return duration > 0 ? round4(weighted / duration) : 0
}

function normalizeBlackFrames(ranges: BlackFrameRange[], durationSec: number): BlackFrameRange[] {
  const cleaned = ranges
    .filter((range) => Number.isFinite(range.startSec) && Number.isFinite(range.endSec))
    .map((range) => ({
      startSec: Math.max(0, Math.min(durationSec, range.startSec)),
      endSec: Math.max(0, Math.min(durationSec, range.endSec)),
    }))
    .filter((range) => range.endSec - range.startSec > 0.001)
    .sort((a, b) => a.startSec - b.startSec)

  const merged: BlackFrameRange[] = []
  for (const range of cleaned) {
    const last = merged[merged.length - 1]
    if (last && range.startSec <= last.endSec + 0.001) {
      last.endSec = round3(Math.max(last.endSec, range.endSec))
      last.durationSec = round3(last.endSec - last.startSec)
      continue
    }
    merged.push({
      startSec: round3(range.startSec),
      endSec: round3(range.endSec),
      durationSec: round3(range.endSec - range.startSec),
    })
  }
  return merged
}

function subtractBlack(
  group: ShotGroup,
  blackFrames: BlackFrameRange[],
): { pieces: Array<{ startSec: number; endSec: number }>; removedSec: number } {
  let pieces = [{ startSec: group.startSec, endSec: group.endSec }]
  let removedSec = 0
  for (const black of blackFrames) {
    if (black.endSec <= group.startSec + 0.001 || black.startSec >= group.endSec - 0.001) continue
    const next: Array<{ startSec: number; endSec: number }> = []
    for (const piece of pieces) {
      if (black.endSec <= piece.startSec + 0.001 || black.startSec >= piece.endSec - 0.001) {
        next.push(piece)
        continue
      }
      const overlapStart = Math.max(black.startSec, piece.startSec)
      const overlapEnd = Math.min(black.endSec, piece.endSec)
      removedSec += Math.max(0, overlapEnd - overlapStart)
      if (black.startSec > piece.startSec + 0.001) {
        next.push({ startSec: piece.startSec, endSec: Math.min(black.startSec, piece.endSec) })
      }
      if (black.endSec < piece.endSec - 0.001) {
        next.push({ startSec: Math.max(black.endSec, piece.startSec), endSec: piece.endSec })
      }
    }
    pieces = next
  }
  return { pieces: pieces.filter((piece) => piece.endSec - piece.startSec > 0.001), removedSec }
}

function describePiece(piece: KeptPiece, shotTotal: number): string {
  const group = piece.group
  const label = group.shotCount > 1
    ? `镜头 ${group.firstShotIndex + 1}–${group.lastShotIndex + 1}/${shotTotal}`
    : `镜头 ${group.firstShotIndex + 1}/${shotTotal}`
  const parts = [`${label} 保留 ${(piece.endSec - piece.startSec).toFixed(1)}s`]
  if (group.shotCount > 1) parts.push(`合并 ${group.shotCount} 个连续镜头`)
  if (group.motion > 0.005) parts.push(`运动 ${group.motion.toFixed(2)}`)
  if (piece.blackRemovedSec > 0.01) parts.push(`剔除黑帧 ${piece.blackRemovedSec.toFixed(1)}s`)
  return parts.join('，')
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
