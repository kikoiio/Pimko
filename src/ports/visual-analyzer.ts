import type { MediaAsset } from '../domain/media'
import type { VisualAnalysis } from '../domain/visual'

/**
 * 视觉分析端口：镜头切点、黑帧、运动与节拍摘要。
 *
 * 约定：
 * - 输出必须是可 JSON 序列化的纯数据（见 domain/visual.ts）。
 * - 同一素材 + 同一实现必须得到同一结果；不允许依赖网络或随机数。
 * - 失败可以抛错，由调用方决定降级；不要返回半份伪造的镜头表。
 */
export interface VisualAnalyzer {
  analyze(asset: MediaAsset): Promise<VisualAnalysis>
}
