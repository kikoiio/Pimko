import type { MediaAssetId } from './media'

export interface TranscriptSegment {
  startSec: number
  endSec: number
  text: string
  confidence: number
}

export interface Transcript {
  assetId: MediaAssetId
  language: string
  segments: TranscriptSegment[]
}
