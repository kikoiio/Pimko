import type { MediaAssetId } from './media'

export interface TranscriptWord {
  startSec: number
  endSec: number
  word: string
}

export interface TranscriptSegment {
  startSec: number
  endSec: number
  text: string
  confidence: number
  /** 词级时间戳；口癖删除、停顿压缩、字幕分块都依赖它。旧项目与降级转写（如 OpenRouter omni）可能没有。 */
  words?: TranscriptWord[]
}

export interface Transcript {
  assetId: MediaAssetId
  language: string
  segments: TranscriptSegment[]
}
