import type { Project } from '../domain/project'

export interface RenderResult {
  outputPath: string
  durationSec: number
}

export interface Renderer {
  render(project: Project, outputPath: string): Promise<RenderResult>
}
