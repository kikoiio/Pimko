import type { ProjectRevision } from '../domain/project'
import type { ExportProgress } from '../ports/renderer'

export type { ExportProgress }

export interface ImportResult {
  revision: ProjectRevision
  sourceUrl: string
}

export interface ExportResult {
  outputPath: string
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
  getClipThumbnail(projectId: string, index: number): Promise<string | null>
}
