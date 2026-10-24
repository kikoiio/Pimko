import type { MediaAssetId } from './media'

export interface TimelineClip {
  assetId: MediaAssetId
  sourceStartSec: number
  sourceEndSec: number
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
