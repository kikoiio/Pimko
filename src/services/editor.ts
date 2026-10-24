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

  async setBgm(projectId: ProjectId, bgmPath: string, gainDb = -18): Promise<ProjectRevision> {
    const current = await this.deps.store.latest(projectId)
    if (!current) throw new Error(`项目不存在: ${projectId}`)
    const revision: ProjectRevision = {
      id: randomUUID(),
      project: {
        ...current.project,
        timeline: { ...current.project.timeline, bgm: { path: bgmPath, gainDb } },
      },
      parentRevisionId: current.id,
      feedback: { text: `设置配乐: ${bgmPath}` },
      agentNote: '配乐已设置，导出时会与原声混合。',
      createdAt: new Date().toISOString(),
    }
    await this.deps.store.save(revision)
    return revision
  }

  async removeBgm(projectId: ProjectId): Promise<ProjectRevision> {
    const current = await this.deps.store.latest(projectId)
    if (!current) throw new Error(`项目不存在: ${projectId}`)
    const { bgm: _removed, ...timeline } = current.project.timeline
    const revision: ProjectRevision = {
      id: randomUUID(),
      project: { ...current.project, timeline },
      parentRevisionId: current.id,
      feedback: { text: '移除配乐' },
      agentNote: '配乐已移除。',
      createdAt: new Date().toISOString(),
    }
    await this.deps.store.save(revision)
    return revision
  }
}
