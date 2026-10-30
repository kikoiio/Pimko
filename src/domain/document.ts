import type { MediaAssetId } from './media'
import type { SubtitleAppearance } from './subtitle-appearance'

/**
 * EditDocument 是唯一可编辑的剪辑状态。
 * Timeline/CompiledTimeline 都只能由 document 派生，不允许作为第二真源持久化。
 */

export type UnitId = string
export type ClipId = string
export type TrackId = string

export type ContentKind = 'speech' | 'visual' | 'tutorial' | 'mixed'

export interface EditUnit {
  id: UnitId
  assetId: MediaAssetId
  startSec: number
  endSec: number
  kind: 'word' | 'phrase' | 'shot' | 'beat'
  text?: string
}

export interface SubtitleCue {
  startSec: number
  endSec: number
  text: string
}

export type Transition =
  | { type: 'cut' }
  | { type: 'crossfade'; durationSec: number }

export interface VideoClip {
  type: 'video'
  id: ClipId
  assetId: MediaAssetId
  /** 源时间坐标；输出时间由编译器按顺序、速度和转场计算。 */
  sourceStartSec: number
  sourceEndSec: number
  speed: number
  role: 'speech' | 'broll' | 'screen' | 'other'
  /** 叠加轨上的开始时间（输出秒）；主视频轨忽略。 */
  atSec?: number
  anchor?: { inUnitId: UnitId; outUnitId: UnitId; leadMs: number; tailMs: number }
  /** 与前一视频片段的衔接；首段与缺省均视为硬切。 */
  transitionIn?: Transition
}

export interface AudioClip {
  type: 'audio'
  id: ClipId
  assetId: MediaAssetId
  sourceStartSec: number
  sourceEndSec: number
  speed?: number
  gainDb: number
  role: 'bgm' | 'sfx'
  /** 配乐循环铺满成片；P1 渲染器只支持 BGM 循环，源区间不参与截断。 */
  loop?: boolean
}

export type EditClip = VideoClip | AudioClip

export interface EditTrack {
  id: TrackId
  kind: 'video' | 'audio' | 'overlay'
  clips: EditClip[]
  muted?: boolean
}

export interface SubtitlePolicy {
  enabled: boolean
  appearance: SubtitleAppearance
}

export interface EditDocument {
  schemaVersion: 2
  tracks: EditTrack[]
  subtitle: SubtitlePolicy
  /** 旧项目迁移用；新文档不写。编译器优先使用 transcript/words，缺失时才回退到这里。 */
  legacySubtitles?: SubtitleCue[]
}

export const EDIT_DOCUMENT_SCHEMA_VERSION = 2 as const

export function createEditDocument(
  tracks: EditTrack[],
  subtitle: SubtitlePolicy = { enabled: true, appearance: {} },
): EditDocument {
  return { schemaVersion: EDIT_DOCUMENT_SCHEMA_VERSION, tracks, subtitle }
}

/** 新项目从空文档开始；轨道由 planner/applyPlan 建立。 */
export function emptyEditDocument(): EditDocument {
  return createEditDocument([])
}

export function firstTrack(document: EditDocument, kind: EditTrack['kind']): EditTrack | undefined {
  return document.tracks.find((track) => track.kind === kind)
}

export function videoClipsOf(document: EditDocument): VideoClip[] {
  const track = firstTrack(document, 'video')
  return track ? track.clips.filter((clip): clip is VideoClip => clip.type === 'video') : []
}

export function bgmClipOf(document: EditDocument): AudioClip | undefined {
  for (const track of document.tracks) {
    if (track.kind !== 'audio') continue
    const clip = track.clips.find(
      (candidate): candidate is AudioClip => candidate.type === 'audio' && candidate.role === 'bgm',
    )
    if (clip) return clip
  }
  return undefined
}

function isBgm(clip: EditClip): clip is AudioClip {
  return clip.type === 'audio' && clip.role === 'bgm'
}

/** 替换（或新增）文档里的 BGM 音轨；保留其它轨道与片段。 */
export function setDocumentBgm(document: EditDocument, assetId: string, gainDb: number): EditDocument {
  const bgm: AudioClip = {
    type: 'audio',
    id: 'bgm-1',
    assetId,
    sourceStartSec: 0,
    sourceEndSec: 0,
    gainDb,
    role: 'bgm',
    loop: true,
  }
  let replaced = false
  const tracks = document.tracks.map((track) => {
    if (track.kind !== 'audio' || !track.clips.some(isBgm)) return track
    replaced = true
    return { ...track, clips: [...track.clips.filter((clip) => !isBgm(clip)), bgm] }
  })
  if (replaced) return { ...document, tracks }
  const audioTrack = tracks.find((track) => track.kind === 'audio')
  if (audioTrack) {
    return {
      ...document,
      tracks: tracks.map((track) => (track === audioTrack ? { ...track, clips: [...track.clips, bgm] } : track)),
    }
  }
  return { ...document, tracks: [...tracks, { id: 'audio-1', kind: 'audio', clips: [bgm] }] }
}

export function setDocumentBgmGain(document: EditDocument, gainDb: number): EditDocument {
  return {
    ...document,
    tracks: document.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.type === 'audio' && clip.role === 'bgm' ? { ...clip, gainDb } : clip,
      ),
    })),
  }
}

export function addOverlayVideo(document: EditDocument, clip: VideoClip): EditDocument {
  const tracks = [...document.tracks]
  const index = tracks.findIndex((track) => track.kind === 'overlay')
  if (index >= 0) {
    tracks[index] = { ...tracks[index]!, clips: [...tracks[index]!.clips, clip] }
  } else {
    tracks.push({ id: 'overlay-1', kind: 'overlay', clips: [clip] })
  }
  return { ...document, tracks }
}

export function removeDocumentBgm(document: EditDocument): EditDocument {
  return {
    ...document,
    tracks: document.tracks
      .map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => !(clip.type === 'audio' && clip.role === 'bgm')),
      }))
      .filter((track) => track.kind !== 'audio' || track.clips.length > 0),
  }
}
