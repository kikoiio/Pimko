export type MediaAssetId = string

export interface MediaAsset {
  id: MediaAssetId
  kind: 'video' | 'audio'
  absolutePath: string
  durationSec: number
  width?: number
  height?: number
}
