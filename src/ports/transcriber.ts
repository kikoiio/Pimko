import type { MediaAsset } from '../domain/media'
import type { Transcript } from '../domain/transcript'

export interface Transcriber {
  transcribe(asset: MediaAsset): Promise<Transcript>
}
