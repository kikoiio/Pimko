import type { CompiledTimeline } from '../domain/compiler'
import type { MediaAsset } from '../domain/media'
import type { ProjectSettings } from '../domain/project'

export interface ExportProgress {
  phase: 'cutting' | 'concatenating' | 'finalizing' | 'verifying'
  current: number
  total: number
}

export interface RenderResult {
  outputPath: string
  durationSec: number
}

/**
 * 渲染器的唯一输入：编译产物 + 素材路径 + 画布设置。
 * 不接收 Project，也不读分析器或 timeline。
 */
export interface RenderRequest {
  compiled: CompiledTimeline
  assets: MediaAsset[]
  settings: ProjectSettings
  outputPath: string
  mode?: 'export' | 'preview'
}

export interface Renderer {
  render(request: RenderRequest, onProgress?: (progress: ExportProgress) => void): Promise<RenderResult>
}
