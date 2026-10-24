import type { Project } from '../domain/project'

export interface ExportProgress {
  phase: 'cutting' | 'concatenating' | 'finalizing' | 'verifying'
  current: number
  total: number
}

export interface RenderResult {
  outputPath: string
  durationSec: number
}

export interface Renderer {
  render(
    project: Project,
    outputPath: string,
    onProgress?: (progress: ExportProgress) => void,
  ): Promise<RenderResult>
}
