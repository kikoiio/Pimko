import type { MediaAsset } from '../domain/media'
import type { Feedback, Project, ProjectId, ProjectRevision } from '../domain/project'
import { randomUUID } from 'node:crypto'
import type { EditingIntelligence } from '../ports/intelligence'
import type { Prober } from '../ports/prober'
import type { ProjectStore } from '../ports/store'
import type { Renderer } from '../ports/renderer'
import type { Transcriber } from '../ports/transcriber'

export interface EditorDeps {
  prober: Prober
  transcriber: Transcriber
  intelligence: EditingIntelligence
  renderer: Renderer
  store: ProjectStore
}

export class Editor {
  constructor(private readonly deps: EditorDeps) {}

  async createDraft(videoPath: string, name?: string): Promise<ProjectRevision> {
    const asset = await this.deps.prober.probe(videoPath)
    const transcript = await this.deps.transcriber.transcribe(asset)
    const settings = { width: 1080, height: 1920, fps: 30, subtitleStyle: 'bold-center' as const }
    const timeline = await this.deps.intelligence.draftTimeline(transcript, settings)
    const project: Project = {
      id: randomUUID(),
      name: name ?? videoPath.split('/').pop() ?? '未命名项目',
      assets: [asset],
      timeline,
      settings,
    }
    const revision: ProjectRevision = {
      id: randomUUID(),
      project,
      createdAt: new Date().toISOString(),
    }
    await this.deps.store.save(revision)
    return revision
  }

  async revise(projectId: ProjectId, feedback: Feedback): Promise<ProjectRevision> {
    const current = await this.deps.store.latest(projectId)
    if (!current) throw new Error(`项目不存在: ${projectId}`)
    const nextTimeline = await this.deps.intelligence.reviseTimeline(current.project, feedback)
    const revision: ProjectRevision = {
      id: randomUUID(),
      project: { ...current.project, timeline: nextTimeline },
      parentRevisionId: current.id,
      feedback,
      createdAt: new Date().toISOString(),
    }
    await this.deps.store.save(revision)
    return revision
  }

  async export(projectId: ProjectId, outputPath: string): Promise<string> {
    const current = await this.deps.store.latest(projectId)
    if (!current) throw new Error(`项目不存在: ${projectId}`)
    const result = await this.deps.renderer.render(current.project, outputPath)
    return result.outputPath
  }
}
