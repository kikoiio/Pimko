import type { MediaAsset } from '../domain/media'

export interface Prober {
  probe(absolutePath: string): Promise<MediaAsset>
}
