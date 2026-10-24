import type { SilenceInterval } from './analysis'
import type { TimelineClip } from './timeline'

/**
 * 停顿压缩:参数化确定性预剪。
 * 语义:长停顿 [p0, p1] 压缩为保留头部 keepSec、尾部留 marginSec 余量,
 * 中间(原停顿的大头)剪掉——用拆分片段表达,时间线仍是源时间坐标。
 */

export interface PauseCompressOptions {
  /** 只处理不短于此的停顿(秒)。 */
  minPauseSec: number
  /** 压缩后保留的停顿时长(秒)。 */
  keepSec: number
  /** 与后续语音的边界余量(秒),防止切到首音节。 */
  marginSec: number
}

export const DEFAULT_PAUSE_OPTIONS: PauseCompressOptions = {
  minPauseSec: 0.6,
  keepSec: 0.3,
  marginSec: 0.15,
}

export interface PauseEdit {
  /** 要剪掉的区间(源时间)。 */
  cutStartSec: number
  cutEndSec: number
  originalSec: number
  keptSec: number
}

/** 静音区间 → 压缩编辑提案;同一输入必然同一输出。 */
export function planPauseCompressions(
  silences: SilenceInterval[] | undefined,
  options: PauseCompressOptions = DEFAULT_PAUSE_OPTIONS,
): PauseEdit[] {
  if (!silences) return []
  const edits: PauseEdit[] = []
  for (const interval of silences) {
    const duration = interval.endSec - interval.startSec
    if (duration < Math.max(options.minPauseSec, options.keepSec + options.marginSec + 0.2)) continue
    const cutStart = interval.startSec + options.keepSec
    const cutEnd = interval.endSec - options.marginSec
    if (cutEnd - cutStart < 0.1) continue
    edits.push({ cutStartSec: cutStart, cutEndSec: cutEnd, originalSec: duration, keptSec: options.keepSec + options.marginSec })
  }
  return edits
}

/** 把压缩编辑应用到片段列表:重叠处拆分,剪掉压缩区间;变速等属性随片段保留。 */
export function applyPauseCompressions(clips: TimelineClip[], edits: PauseEdit[]): TimelineClip[] {
  if (edits.length === 0) return clips
  const sorted = [...edits].sort((a, b) => a.cutStartSec - b.cutStartSec)
  const result: TimelineClip[] = []
  for (const clip of clips) {
    let cursor = clip.sourceStartSec
    for (const edit of sorted) {
      if (edit.cutEndSec <= cursor || edit.cutStartSec >= clip.sourceEndSec) continue
      const cutStart = Math.max(edit.cutStartSec, cursor)
      if (cutStart - cursor >= 0.1) {
        result.push({ ...clip, sourceStartSec: cursor, sourceEndSec: cutStart })
      }
      cursor = Math.max(cursor, edit.cutEndSec)
      if (cursor >= clip.sourceEndSec) break
    }
    if (clip.sourceEndSec - cursor >= 0.1) {
      result.push({ ...clip, sourceStartSec: cursor, sourceEndSec: clip.sourceEndSec })
    }
  }
  return result
}

/** 人类可读的提案摘要,供 prompt 与 agent 说明使用。 */
export function describePauseCompressions(edits: PauseEdit[]): string {
  if (edits.length === 0) return ''
  const saved = edits.reduce((sum, edit) => sum + (edit.cutEndSec - edit.cutStartSec), 0)
  return `${edits.length} 处长停顿压缩,预计缩短 ${saved.toFixed(1)}s`
}
