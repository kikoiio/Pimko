import type { MediaAssetId } from './media'
import type { SubtitleCue, Transition } from './document'
import type { SubtitleAppearance } from './subtitle-appearance'

export type { SubtitleCue, Transition } from './document'
export type { SubtitleAppearance } from './subtitle-appearance'

export interface TimelineClip {
  assetId: MediaAssetId
  sourceStartSec: number
  sourceEndSec: number
  /** 播放速度，0.5–2.0；缺省或 1 表示原速。导出与预览共用同一数值。 */
  speed?: number
}

export interface BgmTrack {
  path: string
  gainDb: number
}

/**
 * 旧版扁平时间线。P1 起不再是真源：新修订由 EditDocument 派生此视图，
 * 旧项目先经 domain/legacy.ts 迁移成 document 再编译。
 */
export interface Timeline {
  clips: TimelineClip[]
  subtitles: SubtitleCue[]
  subtitleAppearance?: SubtitleAppearance
  bgm?: BgmTrack
  /** transitions[i] 衔接 clips[i] 与 clips[i+1];缺省视为硬切。 */
  transitions: Transition[]
}

/** 叠化会吞掉重叠时长;渲染、预览、列表、MCP 的时长口径统一走这里。 */
export function transitionDuration(transition: Transition | undefined): number {
  return transition?.type === 'crossfade' ? transition.durationSec : 0
}

export function timelineDurationSec(timeline: Timeline): number {
  let total = 0
  timeline.clips.forEach((clip, index) => {
    total += (clip.sourceEndSec - clip.sourceStartSec) / (clip.speed ?? 1)
    if (index > 0) total -= transitionDuration(timeline.transitions[index - 1])
  })
  return total
}
