import type { QualityReport } from '../domain/quality'
import type { ProjectRevision } from '../domain/project'
import type { ExportOutcome } from '../services/editor'
import type { ExportProgress } from '../ports/renderer'

export type { ExportProgress, QualityReport }

export interface ImportResult {
  revision: ProjectRevision
  sourceUrl: string
}

/** 导出回执：文件地址、实际时长与质量报告；UI/MCP 都必须能读到 verdict。 */
export interface ExportResult extends ExportOutcome {
  outputUrl: string
}

export interface PreviewResult {
  revisionId: string
  previewUrl: string
}

export interface ProjectSummary {
  projectId: string
  name: string
  revisionId: string
  updatedAt: string
  clipCount: number
  durationSec: number
  sourceUrl: string
}

export interface PimkoApi {
  importVideo(): Promise<ImportResult | null>
  listProjects(): Promise<ProjectSummary[]>
  restoreProject(projectId: string): Promise<ImportResult>
  revise(projectId: string, feedback: string): Promise<ProjectRevision>
  undo(projectId: string): Promise<ProjectRevision>
  renderPreview(projectId: string, revisionId: string): Promise<PreviewResult>
  exportVideo(projectId: string): Promise<ExportResult | null>
  onExportProgress(listener: (progress: ExportProgress) => void): void
  setBgm(projectId: string): Promise<ProjectRevision | null>
  setBgmVolume(projectId: string, gainDb: number): Promise<ProjectRevision>
  removeBgm(projectId: string): Promise<ProjectRevision>
  addBroll(projectId: string, atSec: number): Promise<ProjectRevision | null>
  getClipThumbnail(projectId: string, index: number): Promise<string | null>
  getQuality(projectId: string, revisionId?: string): Promise<QualityReport | null>
}
