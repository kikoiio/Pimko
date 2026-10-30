import type { SilenceInterval } from './analysis'
import type { ContentKind } from './document'
import type { EditPlan, KeepOp } from './edit-plan'
import { applyPauseCompressions, planPauseCompressions } from './pause-compress'
import type { Transcript } from './transcript'
import { normalizedWords, snapEndToWords, snapStartToWords } from './words'

/**
 * 确定性 first-pass：先按转写段 + 静音压缩得到保留区间，再交给 planner 做语义补丁。
 * 不做语义判断；同一输入必然同一输出。
 */
export function baselinePlan(
  transcript: Transcript,
  silences: SilenceInterval[] | undefined,
  contentKind: ContentKind = 'speech',
  assetDurationSec?: number,
): EditPlan {
  const segments = transcript.segments.map((segment) => ({
    assetId: transcript.assetId,
    sourceStartSec: segment.startSec,
    sourceEndSec: segment.endSec,
  }))
  const compressed = applyPauseCompressions(segments, planPauseCompressions(silences))
  // 转写时间戳可能比容器时长多出几十毫秒；baseline 夹到素材时长，避免合法转写被 applyPlan 拒绝。
  const maxSec = assetDurationSec !== undefined && Number.isFinite(assetDurationSec) && assetDurationSec > 0
    ? assetDurationSec
    : Infinity
  const words = normalizedWords(transcript)
  const snapped: KeepOp[] = compressed
    .map((clip) => {
      const startSec = Math.min(Math.max(0, snapStartToWords(words, clip.sourceStartSec)), maxSec)
      const endSec = Math.min(Math.max(0, snapEndToWords(words, clip.sourceEndSec)), maxSec)
      return {
        kind: 'keep' as const,
        assetId: clip.assetId,
        startSec,
        endSec,
        reason: '确定性停顿预剪',
      }
    })
    .filter((clip) => clip.endSec - clip.startSec >= 0.05)
    .sort((a, b) => a.startSec - b.startSec)
  // 词边界吸附会让相邻转写段跨词重叠；合并重叠区间，避免同一素材片段重复播放。
  const ops: KeepOp[] = []
  for (const clip of snapped) {
    const previous = ops[ops.length - 1]
    if (previous && clip.startSec <= previous.endSec + 0.05 && previous.assetId === clip.assetId) {
      previous.endSec = Math.max(previous.endSec, clip.endSec)
    } else {
      ops.push({ ...clip })
    }
  }
  return {
    mode: 'draft',
    contentKind,
    ops,
    note:
      ops.length < segments.length
        ? `已按确定性静音分析拆出 ${ops.length} 个保留区间；后续可继续用一句话调整。`
        : '已按转写生成确定性草稿；后续可继续用一句话调整。',
  }
}
