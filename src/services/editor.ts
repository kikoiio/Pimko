import type { MediaAsset } from '../domain/media'
import type { Feedback, Project, ProjectId, ProjectRevision, RevisionDiff, RevisionId } from '../domain/project'
import type { TimelineClip } from '../domain/timeline'
import { randomUUID } from 'node:crypto'
import type { SilenceAnalyzer } from '../ports/analyzer'
import type { EditingIntelligence } from '../ports/intelligence'
import type { Prober } from '../ports/prober'
import type { ProjectStore } from '../ports/store'
import type { ExportProgress, Renderer } from '../ports/renderer'
import type { Transcriber } from '../ports/transcriber'

export interface EditorDeps {
  prober: Prober
  transcriber: Transcriber
  intelligence: EditingIntelligence
  renderer: Renderer
  store: ProjectStore
  /** 静音分析为可选增强：缺失或失败时降级为无静音图，不阻断建稿。 */
  silenceAnalyzer?: SilenceAnalyzer
}

export class Editor {
  constructor(private readonly deps: EditorDeps) {}

  async createDraft(videoPath: string, name?: string): Promise<ProjectRevision> {
    const asset = await this.deps.prober.probe(videoPath)
    const transcript = await this.deps.transcriber.transcribe(asset)
    const silences = await this.analyzeSilences(asset)
    const width = evenDimension(asset.width ?? 1080)
    const height = evenDimension(asset.height ?? 1920)
    if (width === 0 || height === 0) throw new Error('无法读取视频尺寸，导出前需要有效的宽高。')
    const settings = { width, height, fps: 30, subtitleStyle: 'bold-center' as const }
    const plan = await this.deps.intelligence.draftTimeline(transcript, settings, silences)
    const project: Project = {
      id: randomUUID(),
      name: name ?? videoPath.split('/').pop() ?? '未命名项目',
      assets: [asset],
      transcript,
      ...(silences.length > 0 ? { silences } : {}),
      timeline: plan.timeline,
      settings,
    }
    const revision: ProjectRevision = {
      id: randomUUID(),
      project,
      agentNote: plan.note,
      createdAt: new Date().toISOString(),
    }
    await this.deps.store.save(revision)
    return revision
  }

  /** 静音图是增强事实源：分析失败（如无音轨的 mock 素材）不应阻断建稿。 */
  private async analyzeSilences(asset: MediaAsset): Promise<{ startSec: number; endSec: number }[]> {
    if (!this.deps.silenceAnalyzer) return []
    try {
      return await this.deps.silenceAnalyzer.analyze(asset)
    } catch {
      return []
    }
  }

  async listProjects(): Promise<ProjectRevision[]> {
    const revisions = await this.deps.store.list()
    const byProject = new Map<string, ProjectRevision>()
    for (const revision of revisions) {
      const current = byProject.get(revision.project.id)
      if (!current || revision.createdAt > current.createdAt) byProject.set(revision.project.id, revision)
    }
    return [...byProject.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async revise(projectId: ProjectId, feedback: Feedback): Promise<ProjectRevision> {
    const current = await this.currentRevision(projectId)
    const plan = await this.deps.intelligence.reviseTimeline(current.project, feedback)
    if (plan.timeline.clips.length === 0) {
      throw new Error('这次修改会让成片变空，已保留上一版。')
    }
    const revision: ProjectRevision = {
      id: randomUUID(),
      project: { ...current.project, timeline: plan.timeline },
      parentRevisionId: current.id,
      operation: { kind: 'edit' },
      feedback,
      agentNote: plan.note,
      diff: diffTimelines(current.project.timeline.clips, plan.timeline.clips),
      createdAt: nextRevisionTime(current),
    }
    await this.deps.store.save(revision)
    return revision
  }

  /** 撤销追加一条修订；从当前逻辑版本继续向前，而不是撤销上一条撤销记录。 */
  async undo(projectId: ProjectId): Promise<ProjectRevision> {
    const current = await this.currentRevision(projectId)
    const source = await this.resolveUndoSource(current)
    if (!source.parentRevisionId) throw new Error('已经是第一版，没有可撤销的修改。')
    const parent = await this.getHistoryRevision(projectId, source.parentRevisionId)
    const target = await this.resolveUndoSource(parent)
    const revision: ProjectRevision = {
      id: randomUUID(),
      project: { ...current.project, timeline: structuredClone(target.project.timeline) },
      parentRevisionId: current.id,
      operation: { kind: 'undo', restoredRevisionId: target.id },
      feedback: { text: '撤销上一步' },
      agentNote: `已撤销「${source.feedback?.text ?? '上一步修改'}」，回到上一版。`,
      diff: diffTimelines(current.project.timeline.clips, target.project.timeline.clips),
      createdAt: nextRevisionTime(current),
    }
    await this.deps.store.save(revision)
    return revision
  }

  /** 将撤销和设置迁移记录解析为其代表的可编辑版本，兼容未带元数据的旧记录。 */
  private async resolveUndoSource(revision: ProjectRevision): Promise<ProjectRevision> {
    const visited = new Set<string>()
    let source = revision
    while (true) {
      if (visited.has(source.id)) throw new Error('修订历史存在循环，无法撤销。')
      visited.add(source.id)
      const operation = source.operation
      if (operation?.kind === 'undo') {
        source = await this.getHistoryRevision(source.project.id, operation.restoredRevisionId)
        continue
      }
      if (operation?.kind === 'settings-migration' || (!operation && isLegacySettingsMigration(source))) {
        if (!source.parentRevisionId) throw new Error('找不到上一版记录，无法撤销。')
        source = await this.getHistoryRevision(source.project.id, source.parentRevisionId)
        continue
      }
      if (!operation && isLegacyUndo(source)) {
        if (!source.parentRevisionId) throw new Error('找不到上一版记录，无法撤销。')
        // 旧版撤销恢复的是直接前驱的父版本，包括当时可能产生的来回切换。
        const previous = await this.getHistoryRevision(source.project.id, source.parentRevisionId)
        if (!previous.parentRevisionId) throw new Error('找不到上一版记录，无法撤销。')
        source = await this.getHistoryRevision(source.project.id, previous.parentRevisionId)
        continue
      }
      return source
    }
  }

  private async getHistoryRevision(projectId: ProjectId, revisionId: RevisionId): Promise<ProjectRevision> {
    const revision = await this.deps.store.get(projectId, revisionId)
    if (!revision) throw new Error('找不到上一版记录，无法撤销。')
    return revision
  }

  async restore(projectId: ProjectId): Promise<ProjectRevision | undefined> {
    const latest = await this.deps.store.latest(projectId)
    if (!latest) return undefined
    return this.reconcileSettings(latest)
  }

  /**
   * 旧项目迁移：早期版本把导出尺寸硬编码为 1080x1920，
   * 恢复时按素材实际尺寸修正，避免竖屏画布装横向素材（上下黑边）。
   * 修正结果落成一条新修订，幂等：修好后再调用不会再产生修订。
   */
  private async reconcileSettings(revision: ProjectRevision): Promise<ProjectRevision> {
    const asset = revision.project.assets[0]
    if (!asset?.width || !asset?.height) return revision
    const width = evenDimension(asset.width)
    const height = evenDimension(asset.height)
    if (width === 0 || height === 0) return revision
    const { settings } = revision.project
    if (width === settings.width && height === settings.height) return revision
    const repaired: ProjectRevision = {
      id: randomUUID(),
      project: { ...revision.project, settings: { ...settings, width, height } },
      parentRevisionId: revision.id,
      operation: { kind: 'settings-migration' },
      feedback: { text: '自动修正导出尺寸' },
      agentNote: `导出尺寸已按素材修正为 ${width}×${height}（原为 ${settings.width}×${settings.height}）。`,
      createdAt: nextRevisionTime(revision),
    }
    await this.deps.store.save(repaired)
    return repaired
  }

  /** 读取最新修订并顺带修正旧项目的导出尺寸。 */
  private async currentRevision(projectId: ProjectId): Promise<ProjectRevision> {
    const latest = await this.deps.store.latest(projectId)
    if (!latest) throw new Error(`项目不存在: ${projectId}`)
    return this.reconcileSettings(latest)
  }

  async export(
    projectId: ProjectId,
    outputPath: string,
    onProgress?: (progress: ExportProgress) => void,
  ): Promise<string> {
    const current = await this.currentRevision(projectId)
    if (current.project.timeline.clips.length === 0) {
      throw new Error('时间线没有任何片段，无法导出。')
    }
    const result = await this.deps.renderer.render(current.project, outputPath, onProgress)
    return result.outputPath
  }

  async setBgm(projectId: ProjectId, bgmPath: string, gainDb = -18): Promise<ProjectRevision> {
    const current = await this.currentRevision(projectId)
    const revision: ProjectRevision = {
      id: randomUUID(),
      project: {
        ...current.project,
        timeline: { ...current.project.timeline, bgm: { path: bgmPath, gainDb } },
      },
      parentRevisionId: current.id,
      operation: { kind: 'edit' },
      feedback: { text: `设置配乐: ${bgmPath}` },
      agentNote: '配乐已设置，导出时会与原声混合。',
      createdAt: nextRevisionTime(current),
    }
    await this.deps.store.save(revision)
    return revision
  }

  /** BGM 音量三档之外也允许连续值;范围收紧在 -40–0dB 防呆。 */
  async setBgmVolume(projectId: ProjectId, gainDb: number): Promise<ProjectRevision> {
    const current = await this.currentRevision(projectId)
    const bgm = current.project.timeline.bgm
    if (!bgm) throw new Error('还没有添加配乐，请先添加配乐再调音量。')
    if (!Number.isFinite(gainDb) || gainDb < -40 || gainDb > 0) {
      throw new Error('配乐音量需在 -40 到 0 dB 之间。')
    }
    const revision: ProjectRevision = {
      id: randomUUID(),
      project: {
        ...current.project,
        timeline: { ...current.project.timeline, bgm: { ...bgm, gainDb } },
      },
      parentRevisionId: current.id,
      operation: { kind: 'edit' },
      feedback: { text: `配乐音量调到 ${gainDb}dB` },
      agentNote: `配乐音量已调到 ${gainDb}dB，导出时生效。`,
      createdAt: nextRevisionTime(current),
    }
    await this.deps.store.save(revision)
    return revision
  }

  async removeBgm(projectId: ProjectId): Promise<ProjectRevision> {
    const current = await this.currentRevision(projectId)
    const { bgm: _removed, ...timeline } = current.project.timeline
    const revision: ProjectRevision = {
      id: randomUUID(),
      project: { ...current.project, timeline },
      parentRevisionId: current.id,
      operation: { kind: 'edit' },
      feedback: { text: '移除配乐' },
      agentNote: '配乐已移除。',
      createdAt: nextRevisionTime(current),
    }
    await this.deps.store.save(revision)
    return revision
  }
}

export type { ExportProgress } from '../ports/renderer'

function isLegacyUndo(revision: ProjectRevision): boolean {
  return revision.feedback?.text === '撤销上一步'
    && revision.agentNote?.startsWith('已撤销「') === true
    && revision.agentNote.endsWith('，回到上一版。')
}

function isLegacySettingsMigration(revision: ProjectRevision): boolean {
  return revision.feedback?.text === '自动修正导出尺寸'
    && revision.agentNote?.startsWith('导出尺寸已按素材修正为 ') === true
}

/** 存储按时间选最新版；快速连续操作和系统时钟回拨也必须排在父版本之后。 */
function nextRevisionTime(parent: ProjectRevision): string {
  const parentTime = Date.parse(parent.createdAt)
  return new Date(Math.max(Date.now(), Number.isFinite(parentTime) ? parentTime + 1 : 0)).toISOString()
}

function evenDimension(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value / 2) * 2
}

function outputDuration(clips: TimelineClip[]): number {
  return clips.reduce((sum, clip) => sum + (clip.sourceEndSec - clip.sourceStartSec) / (clip.speed ?? 1), 0)
}

/** 上一版 → 新版的可读对比:按源区间匹配片段,统计增/删/移/变速与时长变化。 */
function diffTimelines(previous: TimelineClip[], next: TimelineClip[]): RevisionDiff {
  const key = (clip: TimelineClip) => `${clip.assetId}:${clip.sourceStartSec.toFixed(2)}-${clip.sourceEndSec.toFixed(2)}`
  const previousIndex = new Map(previous.map((clip, index) => [key(clip), index]))
  const nextIndex = new Map(next.map((clip, index) => [key(clip), index]))
  let added = 0
  let removed = 0
  let moved = 0
  let spedUp = 0
  for (const [clipKey, index] of nextIndex) {
    const before = previousIndex.get(clipKey)
    if (before === undefined) {
      added += 1
      continue
    }
    if (before !== index) moved += 1
    if ((previous[before]!.speed ?? 1) !== (next[index]!.speed ?? 1)) spedUp += 1
  }
  for (const clipKey of previousIndex.keys()) {
    if (!nextIndex.has(clipKey)) removed += 1
  }
  return {
    added,
    removed,
    moved,
    spedUp,
    durationDeltaSec: Number((outputDuration(next) - outputDuration(previous)).toFixed(2)),
  }
}
