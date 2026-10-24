import type { ProjectRevision } from '../domain/project'

export interface ImportResult {
  revision: ProjectRevision
  sourceUrl: string
}

export interface ExportResult {
  outputPath: string
  outputUrl: string
}

export interface PimkoApi {
  importVideo(): Promise<ImportResult | null>
  revise(projectId: string, feedback: string): Promise<ProjectRevision>
  exportVideo(projectId: string): Promise<ExportResult | null>
}
