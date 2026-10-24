import type { MediaAsset } from '../domain/media'
import type { SilenceInterval } from '../domain/analysis'

export interface SilenceAnalyzer {
  /** 检测素材中的静音/长停顿区间；同一输入必然同一输出（确定性）。 */
  analyze(asset: MediaAsset): Promise<SilenceInterval[]>
}
