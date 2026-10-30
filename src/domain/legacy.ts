import type { CompileAnalysis, CompiledTimeline } from './compiler'
import { compile } from './compiler'
import {
  EDIT_DOCUMENT_SCHEMA_VERSION,
  type AudioClip,
  type EditDocument,
  type EditTrack,
  type SubtitleCue,
  type Transition,
  type VideoClip,
} from './document'
import type { MediaAsset } from './media'
import type { Project } from './project'
import { subtitlesForClips } from './subtitles'
import type { Timeline, TimelineClip } from './timeline'
import type { Transcript } from './transcript'

/**
 * 旧 Timeline ↔ EditDocument 的唯一适配层。
 * - documentFromTimeline：只读迁移，不改输入；旧 subtitles 暂存为迁移 fallback。
 * - timelineFromDocument：兼容视图，给旧 UI/验收脚本/迁移入口读，不是真源。
 * - compileProject：项目（不论新旧）→ CompiledTimeline，渲染/预览/MCP 的唯一入口。
 */

const LEGACY_BGM_ASSET_PREFIX = 'legacy-bgm:'

export function legacyBgmAssetId(path: string): string {
  return `${LEGACY_BGM_ASSET_PREFIX}${path}`
}

function bgmPathFromAssetId(assetId: string): string | undefined {
  return assetId.startsWith(LEGACY_BGM_ASSET_PREFIX)
    ? assetId.slice(LEGACY_BGM_ASSET_PREFIX.length)
    : undefined
}

export interface DocumentFromTimelineOptions {
  /** 旧项目迁移时 BGM 对应的素材 id；缺省用路径派生的稳定 id。 */
  bgmAssetId?: string
}

export function documentFromTimeline(
  timeline: Timeline,
  options: DocumentFromTimelineOptions = {},
): EditDocument {
  const videoClips: VideoClip[] = timeline.clips.map((clip, index) => ({
    type: 'video',
    id: `clip-${index + 1}`,
    assetId: clip.assetId,
    sourceStartSec: clip.sourceStartSec,
    sourceEndSec: clip.sourceEndSec,
    speed: clip.speed ?? 1,
    role: 'speech',
    ...(index > 0 ? { transitionIn: cloneTransition(timeline.transitions[index - 1]) } : {}),
  }))
  const tracks: EditTrack[] = [{ id: 'video-1', kind: 'video', clips: videoClips }]
  if (timeline.bgm) {
    const bgm: AudioClip = {
      type: 'audio',
      id: 'bgm-1',
      assetId: options.bgmAssetId ?? legacyBgmAssetId(timeline.bgm.path),
      sourceStartSec: 0,
      sourceEndSec: 0,
      gainDb: timeline.bgm.gainDb,
      role: 'bgm',
      loop: true,
    }
    tracks.push({ id: 'audio-1', kind: 'audio', clips: [bgm] })
  }
  const appearance = timeline.subtitleAppearance ? { ...timeline.subtitleAppearance } : {}
  return {
    schemaVersion: EDIT_DOCUMENT_SCHEMA_VERSION,
    tracks,
    subtitle: { enabled: appearance.visible !== false, appearance },
    ...(timeline.subtitles.length > 0
      ? { legacySubtitles: timeline.subtitles.map((cue) => ({ ...cue })) }
      : {}),
  }
}

/** 由 document 派生旧时间线视图；只用于兼容读取，不用于新路径的时间计算。 */
export function timelineFromDocument(
  document: EditDocument,
  assets: MediaAsset[] = [],
  transcript?: Transcript,
  transcripts?: Record<string, Transcript>,
): Timeline {
  const videoTrack = document.tracks.find(
    (track) => track.kind === 'video' && track.clips.some((clip) => clip.type === 'video'),
  )
  const videoClips = (videoTrack?.clips ?? []).filter((clip): clip is VideoClip => clip.type === 'video')
  const clips: TimelineClip[] = videoClips.map((clip) => ({
    assetId: clip.assetId,
    sourceStartSec: clip.sourceStartSec,
    sourceEndSec: clip.sourceEndSec,
    ...(clip.speed !== 1 ? { speed: clip.speed } : {}),
  }))
  const transitions: Transition[] = videoClips
    .slice(1)
    .map((clip) => cloneTransition(clip.transitionIn))
  const subtitles = subtitlesForDocument(document, clips, transcript, transcripts)
  const appearance = { ...document.subtitle.appearance }
  if (!document.subtitle.enabled) appearance.visible = false
  const bgmClip = findBgmClip(document)
  const bgmPath = bgmClip ? bgmPathOf(bgmClip, assets) : undefined
  return {
    clips,
    subtitles,
    ...(Object.keys(appearance).length > 0 ? { subtitleAppearance: appearance } : {}),
    ...(bgmClip && bgmPath ? { bgm: { path: bgmPath, gainDb: bgmClip.gainDb } } : {}),
    transitions,
  }
}

/** 兼容视图字幕：逐素材转写合并后按源时间排序；legacySubtitles 仍是旧项目 fallback。 */
function subtitlesForDocument(
  document: EditDocument,
  clips: TimelineClip[],
  transcript?: Transcript,
  transcripts?: Record<string, Transcript>,
): SubtitleCue[] {
  if (document.legacySubtitles?.length) return document.legacySubtitles.map((cue) => ({ ...cue }))
  const byAsset = new Map<string, Transcript>()
  for (const [assetId, item] of Object.entries(transcripts ?? {})) {
    if (item?.segments) byAsset.set(assetId, item)
  }
  if (transcript && !byAsset.has(transcript.assetId)) byAsset.set(transcript.assetId, transcript)
  const cues: SubtitleCue[] = []
  for (const item of byAsset.values()) cues.push(...subtitlesForClips(item, clips))
  return cues.sort((a, b) => a.startSec - b.startSec)
}

/** 迁移旧项目：document 为真源，timeline 重算为兼容视图；新增 BGM 素材引用。 */
export function normalizeProject(project: Project): Project {
  const document = project.document ?? documentFromTimeline(project.timeline)
  const assets = assetsForDocument(project.assets, document)
  return {
    ...project,
    document,
    assets,
    timeline: timelineFromDocument(document, assets, project.transcript, project.transcripts),
  }
}

export function documentForProject(project: Project): EditDocument {
  if (project.document) return project.document
  if (project.timeline) return documentFromTimeline(project.timeline)
  throw new Error('项目缺少可编辑的文档或旧时间线。')
}

export function compileProject(project: Project): CompiledTimeline {
  const analysis: CompileAnalysis = {
    ...(project.transcript ? { transcript: project.transcript } : {}),
    ...(project.transcripts ? { transcripts: project.transcripts } : {}),
    ...(project.silences ? { silences: project.silences } : {}),
    ...(project.analysis ?? {}),
  }
  return compile(documentForProject(project), analysis)
}

export function projectWithDocument(
  base: Project,
  document: EditDocument,
  assets: MediaAsset[] = base.assets,
): Project {
  const nextAssets = assetsForDocument(assets, document)
  return {
    ...base,
    assets: nextAssets,
    document,
    timeline: timelineFromDocument(document, nextAssets, base.transcript, base.transcripts),
  }
}

export function mergeAssets(...lists: MediaAsset[][]): MediaAsset[] {
  const merged = new Map<string, MediaAsset>()
  for (const list of lists) {
    for (const asset of list) {
      if (!merged.has(asset.id)) merged.set(asset.id, asset)
    }
  }
  return [...merged.values()]
}

/** 为 legacy BGM 的合成 assetId 补齐 MediaAsset，渲染器才能解析出路径。 */
export function assetsForDocument(assets: MediaAsset[], document: EditDocument): MediaAsset[] {
  const result = [...assets]
  for (const track of document.tracks) {
    if (track.kind !== 'audio') continue
    for (const clip of track.clips) {
      if (clip.type !== 'audio' || clip.role !== 'bgm') continue
      if (result.some((asset) => asset.id === clip.assetId)) continue
      const path = bgmPathFromAssetId(clip.assetId)
      if (path) {
        result.push({ id: clip.assetId, kind: 'audio', absolutePath: path, durationSec: 0 })
      }
    }
  }
  return result
}

function findBgmClip(document: EditDocument): AudioClip | undefined {
  for (const track of document.tracks) {
    if (track.kind !== 'audio') continue
    const clip = track.clips.find(
      (candidate): candidate is AudioClip => candidate.type === 'audio' && candidate.role === 'bgm',
    )
    if (clip) return clip
  }
  return undefined
}

function bgmPathOf(clip: AudioClip, assets: MediaAsset[]): string | undefined {
  const asset = assets.find((candidate) => candidate.id === clip.assetId)
  return asset?.absolutePath ?? bgmPathFromAssetId(clip.assetId)
}

function cloneTransition(transition: Transition | undefined): Transition {
  if (transition?.type === 'crossfade') {
    return { type: 'crossfade', durationSec: transition.durationSec }
  }
  return { type: 'cut' }
}
