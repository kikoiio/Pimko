import type { ContentKind, EditDocument, VideoClip } from '../domain/document'
import type { QualityReport } from '../domain/quality'
import type { Inspector } from '../ports/inspector'
import { QualityGate } from './quality-gate'
import {
  addOverlayVideo,
  bgmClipOf,
  emptyEditDocument,
  removeDocumentBgm,
  setDocumentBgm,
  setDocumentBgmGain,
  videoClipsOf,
} from '../domain/document'
import { applyPlan, type EditPlan } from '../domain/edit-plan'
import { baselinePlan } from '../domain/baseline'
import {
  compileProject,
  documentFromTimeline,
  legacyBgmAssetId,
  mergeAssets,
  normalizeProject,
  projectWithDocument,
  timelineFromDocument,
} from '../domain/legacy'
import type { MediaAsset } from '../domain/media'
import type { Feedback, Project, ProjectId, ProjectRevision, RevisionDiff, RevisionId } from '../domain/project'
import type { TimelineClip } from '../domain/timeline'
import { randomUUID } from 'node:crypto'
import type { SilenceAnalyzer } from '../ports/analyzer'
import type { EditingIntelligence } from '../ports/intelligence'
import type { Planner } from '../ports/planner'
import type { Prober } from '../ports/prober'
import type { ProjectStore } from '../ports/store'
import type { ExportProgress, Renderer } from '../ports/renderer'
import type { Transcriber } from '../ports/transcriber'
import type { Transcript } from '../domain/transcript'

/** 导出结果：真实成片路径、实际时长与质量报告；调用者不需要再单独跑检查。 */
export interface ExportOutcome {
  outputPath: string
  durationSec: number
  quality: QualityReport
}

export interface EditorDeps {
  prober: Prober
  transcriber: Transcriber
  intelligence: EditingIntelligence
  renderer: Renderer
  store: ProjectStore
  /** 静音分析为可选增强：缺失或失败时降级为无静音图，不阻断建稿。 */
  silenceAnalyzer?: SilenceAnalyzer
  /**
   * P2 补丁式 planner；缺省时走旧 EditingIntelligence。
   * 迁移期两条路都能建稿，但新路径只写 document。
   */
  planner?: Planner
  /**
   * P4 视觉兜底：无音轨/转写不可用时用镜头/节拍生成草稿。
   * 有转写时仍走 planner/旧 intelligence，不会把口播误送到视觉路径。
   */
  visualPlanner?: Planner
  /**
   * P3 成片检查器；缺省时导出仍可用，但质量报告会明确标记为未检查（warn），
   * 不会把"没有检查"伪装成 pass。GUI/MCP 都注入 FfmpegInspector。
   */
  inspector?: Inspector
}

/**
 * 命令层：所有编辑都写 document（唯一 canonical 字段），
 * timeline 只是给旧 UI/验收读的派生视图；预览与导出统一走 compileProject。
 */
export class Editor {
  constructor(private readonly deps: EditorDeps) {}

  async createDraft(videoPath: string, name?: string): Promise<ProjectRevision> {
    const asset = await this.deps.prober.probe(videoPath)
    let transcript: Transcript | undefined
    try {
      transcript = await this.deps.transcriber.transcribe(asset)
    } catch (error) {
      // 无音轨才允许走视觉路径；网络/鉴权错误仍要抛给用户，不能悄悄换成蒙太奇草稿。
      if (!this.deps.visualPlanner || !isNoAudioError(error)) throw error
    }
    const silences = await this.analyzeSilences(asset)
    const width = evenDimension(asset.width ?? 1080)
    const height = evenDimension(asset.height ?? 1920)
    if (width === 0 || height === 0) throw new Error('无法读取视频尺寸，导出前需要有效的宽高。')
    const settings = { width, height, fps: 30, subtitleStyle: 'bold-center' as const }
    const baseProject = {
      id: randomUUID(),
      name: name ?? videoPath.split('/').pop() ?? '未命名项目',
      assets: [asset],
      ...(transcript ? { transcript } : {}),
      ...(silences.length > 0 ? { silences } : {}),
      settings,
    }
    const planner = transcript ? this.deps.planner : this.deps.visualPlanner
    if (planner) {
      const contentKind: ContentKind = transcript
        ? (transcript.segments.some((segment) => segment.words?.length) ? 'speech' : 'mixed')
        : 'visual'
      const plan = await planner.propose({
        mode: 'draft',
        contentKind,
        document: emptyEditDocument(),
        ...(transcript ? { transcript } : {}),
        silences,
        assets: [asset],
        settings,
      })
      const document = applyPlan(emptyEditDocument(), plan, {
        assets: [asset],
        contentKind: plan.contentKind,
        ...(transcript ? { transcript } : {}),
      })
      const project = projectWithDocument(
        { ...baseProject, timeline: timelineFromDocument(document, [asset], transcript) },
        document,
      )
      project.analysis = { contentKind: plan.contentKind }
      const revision: ProjectRevision = {
        id: randomUUID(),
        schemaVersion: 2,
        project,
        agentNote: plan.note,
        createdAt: new Date().toISOString(),
      }
      await this.deps.store.save(revision)
      return revision
    }

    if (!transcript) throw new Error('这段素材没有可用语音，也没有配置视觉分析器。')
    const plan = await this.deps.intelligence.draftTimeline(transcript, settings, silences)
    const document = documentFromTimeline(plan.timeline)
    const project = projectWithDocument({
      ...baseProject,
      transcript,
      timeline: plan.timeline,
    }, document)
    const revision: ProjectRevision = {
      id: randomUUID(),
      schemaVersion: 2,
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

  /**
   * 多素材顺序合成：逐个 probe/转写，为每个素材生成确定性 first-pass，
   * 再按给定顺序拼到同一条视频轨。单文件与 createDraft 完全等价。
   * 每条素材各自转写，编译时字幕按 clip.assetId 映射回各自源时间。
   * 限制：本轮只支持一条视频轨的硬切顺序拼接，不渲染 B-roll/叠加轨。
   */
  async createDraftFromPaths(paths: string[], name?: string): Promise<ProjectRevision> {
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('请至少选择一个视频文件。')
    if (paths.length === 1) return this.createDraft(paths[0]!, name)

    const assets: MediaAsset[] = []
    const transcripts: Record<string, Transcript> = {}
    const silencesByAsset = new Map<string, { startSec: number; endSec: number }[]>()
    for (const file of paths) {
      const asset = await this.deps.prober.probe(file)
      assets.push(asset)
      let transcript: Transcript | undefined
      try {
        transcript = await this.deps.transcriber.transcribe(asset)
      } catch (error) {
        // 与单素材一致：只有“没有音轨”才允许降级，鉴权/网络错误必须抛给用户。
        if (!this.deps.visualPlanner || !isNoAudioError(error)) throw error
      }
      if (transcript) transcripts[asset.id] = transcript
      silencesByAsset.set(asset.id, await this.analyzeSilences(asset))
    }

    const first = assets[0]!
    const width = evenDimension(first.width ?? 1080)
    const height = evenDimension(first.height ?? 1920)
    if (width === 0 || height === 0) throw new Error('无法读取视频尺寸，导出前需要有效的宽高。')
    const settings = { width, height, fps: 30, subtitleStyle: 'bold-center' as const }

    let document = emptyEditDocument()
    const notes: string[] = []
    const contentKinds: ContentKind[] = []
    for (const asset of assets) {
      const transcript = transcripts[asset.id]
      let plan: EditPlan
      let contentKind: ContentKind
      if (transcript) {
        contentKind = transcript.segments.some((segment) => segment.words?.length) ? 'speech' : 'mixed'
        plan = baselinePlan(transcript, silencesByAsset.get(asset.id), contentKind)
      } else {
        if (!this.deps.visualPlanner) {
          throw new Error(`素材 ${fileName(asset.absolutePath)} 没有可用语音，也没有配置视觉分析器。`)
        }
        plan = await this.deps.visualPlanner.propose({
          mode: 'draft',
          contentKind: 'visual',
          document: emptyEditDocument(),
          assets: [asset],
          settings,
        })
        contentKind = plan.contentKind
      }
      try {
        const part = applyPlan(emptyEditDocument(), plan, {
          assets: [asset],
          contentKind: plan.contentKind,
          ...(transcript ? { transcript } : {}),
        })
        document = appendVideoClips(document, videoClipsOf(part))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`素材 ${fileName(asset.absolutePath)} 无法生成初剪：${reason}`)
      }
      notes.push(plan.note)
      contentKinds.push(contentKind)
    }

    const project = projectWithDocument({
      id: randomUUID(),
      name: name ?? `${fileName(paths[0]!)} 等 ${paths.length} 个素材`,
      assets,
      ...(Object.keys(transcripts).length > 0 ? { transcripts } : {}),
      settings,
      timeline: timelineFromDocument(document, assets, undefined, transcripts),
    }, document)
    project.analysis = { contentKind: aggregateContentKind(contentKinds) }
    const revision: ProjectRevision = {
      id: randomUUID(),
      schemaVersion: 2,
      project,
      agentNote: `已按导入顺序拼接 ${assets.length} 个素材（${assets.map((asset) => fileName(asset.absolutePath)).join(' → ')}）。${notes.join(' ')}`.trim(),
      createdAt: new Date().toISOString(),
    }
    await this.deps.store.save(revision)
    return revision
  }

  async listProjects(): Promise<ProjectRevision[]> {
    const revisions = await this.deps.store.list()
    const byProject = new Map<string, ProjectRevision>()
    for (const revision of revisions) {
      const current = byProject.get(revision.project.id)
      if (!current || revision.createdAt > current.createdAt) byProject.set(revision.project.id, revision)
    }
    return [...byProject.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((revision) => ({ ...revision, project: normalizeProject(revision.project) }))
  }

  async revise(projectId: ProjectId, feedback: Feedback): Promise<ProjectRevision> {
    const current = await this.currentRevision(projectId)
    const planner = current.project.transcript
      ? this.deps.planner
      : (this.deps.visualPlanner ?? this.deps.planner)
    if (planner) {
      const document = current.project.document ?? documentFromTimeline(current.project.timeline)
      const contentKind: ContentKind = current.project.analysis?.contentKind ?? 'speech'
      const plan = await planner.propose({
        mode: 'revise',
        contentKind,
        document,
        compiled: compileProject(current.project),
        transcript: current.project.transcript,
        silences: current.project.silences,
        assets: current.project.assets,
        settings: current.project.settings,
        feedback,
      })
      const nextDocument = applyPlan(document, plan, {
        assets: current.project.assets,
        contentKind,
        ...(current.project.transcript ? { transcript: current.project.transcript } : {}),
        ...(current.project.transcripts ? { transcripts: current.project.transcripts } : {}),
      })
      const project = projectWithDocument(
        {
          ...current.project,
          timeline: timelineFromDocument(
            nextDocument,
            current.project.assets,
            current.project.transcript,
            current.project.transcripts,
          ),
        },
        nextDocument,
      )
      if (compileProject(project).videoClips.length === 0) {
        throw new Error('这次修改会让成片变空，已保留上一版。')
      }
      const revision: ProjectRevision = {
        id: randomUUID(),
        schemaVersion: 2,
        project,
        parentRevisionId: current.id,
        operation: { kind: 'edit' },
        feedback,
        agentNote: plan.note,
        diff: diffTimelines(current.project.timeline.clips, project.timeline.clips),
        createdAt: nextRevisionTime(current),
      }
      await this.deps.store.save(revision)
      return revision
    }

    const plan = await this.deps.intelligence.reviseTimeline(current.project, feedback)
    if (plan.timeline.clips.length === 0) {
      throw new Error('这次修改会让成片变空，已保留上一版。')
    }
    // P1 仍由旧 intelligence 产出 Timeline；立刻归一化成 document，P2 换 planner 时渲染边界不再变。
    const document = documentFromTimeline(plan.timeline)
    const project = projectWithDocument({ ...current.project, timeline: plan.timeline }, document)
    const revision: ProjectRevision = {
      id: randomUUID(),
      schemaVersion: 2,
      project,
      parentRevisionId: current.id,
      operation: { kind: 'edit' },
      feedback,
      agentNote: plan.note,
      diff: diffTimelines(current.project.timeline.clips, project.timeline.clips),
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
    const targetProject = normalizeProject(target.project)
    const document = structuredClone(targetProject.document as EditDocument)
    const assets = mergeAssets(current.project.assets, targetProject.assets)
    const project = projectWithDocument(current.project, document, assets)
    const revision: ProjectRevision = {
      id: randomUUID(),
      schemaVersion: 2,
      project,
      parentRevisionId: current.id,
      operation: { kind: 'undo', restoredRevisionId: target.id },
      feedback: { text: '撤销上一步' },
      agentNote: `已撤销「${source.feedback?.text ?? '上一步修改'}」，回到上一版。`,
      diff: diffTimelines(current.project.timeline.clips, project.timeline.clips),
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
   * 同时把旧 timeline 归一化为 document + 派生视图。
   */
  private async reconcileSettings(revision: ProjectRevision): Promise<ProjectRevision> {
    const normalized = normalizeProject(revision.project)
    const asset = normalized.assets[0]
    if (!asset?.width || !asset?.height) return { ...revision, project: normalized }
    const width = evenDimension(asset.width)
    const height = evenDimension(asset.height)
    if (width === 0 || height === 0) return { ...revision, project: normalized }
    const { settings } = normalized
    if (width === settings.width && height === settings.height) return { ...revision, project: normalized }
    const repairedProject = projectWithDocument(
      { ...normalized, settings: { ...settings, width, height } },
      normalized.document as EditDocument,
      normalized.assets,
    )
    const repaired: ProjectRevision = {
      id: randomUUID(),
      schemaVersion: 2,
      project: repairedProject,
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
  ): Promise<ExportOutcome> {
    const current = await this.currentRevision(projectId)
    const compiled = compileProject(current.project)
    if (compiled.videoClips.length === 0) {
      throw new Error('时间线没有任何片段，无法导出。')
    }
    const result = await this.deps.renderer.render({
      compiled,
      assets: current.project.assets,
      settings: current.project.settings,
      outputPath,
      mode: 'export',
    }, onProgress)
    const quality = await this.inspectOutput(current, compiled, result.outputPath, result.durationSec)
    return {
      outputPath: result.outputPath,
      // 质量报告里的 actualSec 来自 ffprobe；缺失时回退到渲染器自报时长。
      durationSec: Number.isFinite(quality.actualSec) && quality.actualSec > 0
        ? quality.actualSec
        : result.durationSec,
      quality,
    }
  }

  /** 导出后必须过质量闸门；没有注入 Inspector 时返回显式 warn，不伪报 pass。 */
  private async inspectOutput(
    current: ProjectRevision,
    compiled: ReturnType<typeof compileProject>,
    outputPath: string,
    renderedDurationSec: number,
  ): Promise<QualityReport> {
    if (!this.deps.inspector) {
      return {
        revisionId: current.id,
        outputHash: '',
        verdict: 'warn',
        expectedSec: compiled.durationSec,
        actualSec: renderedDurationSec,
        checks: [{
          kind: 'inspection',
          status: 'warn',
          detail: '未配置成片检查器（Inspector），本次导出未经质量检查。',
        }],
        cuts: [],
      }
    }
    const contentKind = current.project.analysis?.contentKind ?? inferContentKind(current)
    const gate = new QualityGate(this.deps.inspector)
    return gate.verify({
      compiled,
      assets: current.project.assets,
      ...(current.project.transcript ? { transcript: current.project.transcript } : {}),
      contentKind,
      outputPath,
      settings: current.project.settings,
      revisionId: current.id,
    })
  }

  /** P5：在成片的 atSec 插入一段全屏 B-roll；音频沿用主视频，B-roll 音轨暂不混入。 */
  async addBroll(
    projectId: ProjectId,
    brollPath: string,
    atSec: number,
    durationSec?: number,
  ): Promise<ProjectRevision> {
    if (!Number.isFinite(atSec) || atSec < 0) throw new Error('B-roll 开始时间必须是非负数。')
    const current = await this.currentRevision(projectId)
    const broll = await this.deps.prober.probe(brollPath)
    if (broll.kind !== 'video') throw new Error('B-roll 必须是视频文件。')
    const compiled = compileProject(current.project)
    if (atSec >= compiled.durationSec) {
      throw new Error(`B-roll 开始时间 ${atSec.toFixed(2)}s 超出成片时长 ${compiled.durationSec.toFixed(2)}s。`)
    }
    const requested = durationSec ?? broll.durationSec
    if (!Number.isFinite(requested) || requested <= 0) throw new Error('B-roll 时长必须大于 0。')
    const sourceDuration = Math.min(requested, broll.durationSec)
    if (sourceDuration < 0.05) throw new Error('B-roll 时长太短。')
    const document = addOverlayVideo(current.project.document as EditDocument, {
      type: 'video',
      id: `broll-${randomUUID()}`,
      assetId: broll.id,
      sourceStartSec: 0,
      sourceEndSec: sourceDuration,
      speed: 1,
      role: 'broll',
      atSec,
    })
    const project = projectWithDocument(
      { ...current.project, assets: mergeAssets(current.project.assets, [broll]) },
      document,
    )
    const revision: ProjectRevision = {
      id: randomUUID(),
      schemaVersion: 2,
      project,
      parentRevisionId: current.id,
      operation: { kind: 'edit' },
      feedback: { text: `在 ${atSec.toFixed(1)}s 插入 B-roll` },
      agentNote: `已在 ${atSec.toFixed(1)}s 插入 ${sourceDuration.toFixed(1)}s B-roll；主视频音频保持不变。`,
      createdAt: nextRevisionTime(current),
    }
    await this.deps.store.save(revision)
    return revision
  }

  async setBgm(projectId: ProjectId, bgmPath: string, gainDb = -18): Promise<ProjectRevision> {
    const current = await this.currentRevision(projectId)
    const document = setDocumentBgm(
      current.project.document as EditDocument,
      legacyBgmAssetId(bgmPath),
      gainDb,
    )
    const project = projectWithDocument(current.project, document)
    const revision: ProjectRevision = {
      id: randomUUID(),
      schemaVersion: 2,
      project,
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
    const bgm = bgmClipOf(current.project.document as EditDocument)
    if (!bgm) throw new Error('还没有添加配乐，请先添加配乐再调音量。')
    if (!Number.isFinite(gainDb) || gainDb < -40 || gainDb > 0) {
      throw new Error('配乐音量需在 -40 到 0 dB 之间。')
    }
    const project = projectWithDocument(
      current.project,
      setDocumentBgmGain(current.project.document as EditDocument, gainDb),
    )
    const revision: ProjectRevision = {
      id: randomUUID(),
      schemaVersion: 2,
      project,
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
    const project = projectWithDocument(
      current.project,
      removeDocumentBgm(current.project.document as EditDocument),
    )
    const revision: ProjectRevision = {
      id: randomUUID(),
      schemaVersion: 2,
      project,
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

/** 只有“没有音轨”允许降级到视觉路径；网络/鉴权/限流错误必须让用户看到。 */
function isNoAudioError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /没有音轨|no audio|does not contain any stream/i.test(message)
}

/** P2 起分析结果写 analysis.contentKind；旧项目按是否有词级转写降级判断。 */
function inferContentKind(revision: ProjectRevision): ContentKind {
  if (revision.project.analysis?.contentKind) return revision.project.analysis.contentKind
  const hasWords = revision.project.transcript?.segments.some((segment) => (segment.words?.length ?? 0) > 0)
  return hasWords ? 'speech' : 'mixed'
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

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

/** 把一份素材初剪的片段按顺序追加到唯一视频轨；片段 ID 重排为全局唯一。 */
function appendVideoClips(document: EditDocument, clips: VideoClip[]): EditDocument {
  const next = structuredClone(document)
  let videoTrack = next.tracks.find((track) => track.kind === 'video')
  if (!videoTrack) {
    videoTrack = { id: 'video-1', kind: 'video', clips: [] }
    next.tracks.unshift(videoTrack)
  }
  const offset = videoTrack.clips.length
  videoTrack.clips.push(
    ...clips.map((clip, index) => ({ ...clip, id: `clip-${offset + index + 1}` })),
  )
  return next
}

function aggregateContentKind(kinds: ContentKind[]): ContentKind {
  const unique = new Set(kinds)
  return unique.size === 1 ? [...unique][0]! : 'mixed'
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
