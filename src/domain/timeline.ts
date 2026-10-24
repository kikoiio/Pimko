import type { MediaAssetId } from './media'

export interface TimelineClip {
  assetId: MediaAssetId
  sourceStartSec: number
  sourceEndSec: number
  /** 播放速度，0.5–2.0；缺省或 1 表示原速。导出与预览共用同一数值。 */
  speed?: number
}

export interface SubtitleCue {
  startSec: number
  endSec: number
  text: string
}

export interface BgmTrack {
  path: string
  gainDb: number
}

export type Transition =
  | { type: 'cut' }
  | { type: 'crossfade'; durationSec: number }

export interface Timeline {
  clips: TimelineClip[]
  subtitles: SubtitleCue[]
  bgm?: BgmTrack
  transitions: Transition[]
}
