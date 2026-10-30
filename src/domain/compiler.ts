import type { ProjectAnalysis, SilenceInterval } from './analysis'
import type {
  AudioClip,
  ClipId,
  EditDocument,
  SubtitleCue,
  Transition,
  VideoClip,
} from './document'
import type { SubtitleAppearance } from './subtitle-appearance'
import { subtitlesForClips } from './subtitles'
import type { TimelineClip } from './timeline'
import type { Transcript } from './transcript'

/**
 * 编译器是纯函数：document + 分析事实 → 唯一输出时间线。
 * 不读文件、不调 ffmpeg、不写修订。渲染器/预览/MCP 都只消费这个产物。
 */

export interface CompileAnalysis extends ProjectAnalysis {
  /** 单素材兼容字段；多素材项目用 transcripts。 */
  transcript?: Transcript
  /** 逐素材转写（key = assetId）；字幕按 clip.assetId 取对应事实。 */
  transcripts?: Record<string, Transcript>
  silences?: SilenceInterval[]
}

export interface CompiledClipBase {
  id: ClipId
  assetId: string
  sourceStartSec: number
  sourceEndSec: number
  /** 输出时间坐标；叠化时前后片段会重叠。 */
  outputStartSec: number
  outputEndSec: number
}

export interface CompiledVideoClip extends CompiledClipBase {
  kind: 'video'
  speed: number
  role: VideoClip['role']
  transitionIn: Transition
}

export interface CompiledAudioClip extends CompiledClipBase {
  kind: 'audio'
  gainDb: number
  role: AudioClip['role']
  loop: boolean
}

/** P5 叠加轨：全屏 B-roll；输出时间独立于主视频轨。 */
export interface CompiledOverlayClip extends CompiledClipBase {
  kind: 'video'
  speed: number
  role: VideoClip['role']
}

export type CompiledClip = CompiledVideoClip | CompiledAudioClip | CompiledOverlayClip

export interface CompiledTrack {
  id: string
  kind: 'video' | 'audio' | 'overlay'
  clips: CompiledClip[]
}

/** 输出时间坐标的字幕块；按片段切分，与旧 ASS 生成口径一致。 */
export interface OutputCue extends SubtitleCue {
  clipId?: ClipId
}

export interface CompiledTimeline {
  durationSec: number
  tracks: CompiledTrack[]
  /** 单视频轨渲染器的便捷视图。 */
  videoClips: CompiledVideoClip[]
  audioClips: CompiledAudioClip[]
  /** P5 叠加轨片段；目前渲染器支持全屏 B-roll。 */
  overlays: CompiledOverlayClip[]
  subtitles: OutputCue[]
  subtitlesEnabled: boolean
  subtitleAppearance: SubtitleAppearance
  bgm?: CompiledAudioClip
  warnings: string[]
}

const MIN_SPEED = 0.5
const MAX_SPEED = 4

export function compile(document: EditDocument, analysis: CompileAnalysis = {}): CompiledTimeline {
  const warnings: string[] = []
  const videoTracks = document.tracks.filter(
    (track) => !track.muted && track.kind === 'video' && track.clips.some((clip) => clip.type === 'video'),
  )
  if (videoTracks.length > 1) {
    warnings.push(`P1 只编译第一条视频轨，忽略其余 ${videoTracks.length - 1} 条。`)
  }
  const videoTrack = videoTracks[0]
  const sourceVideoClips = (videoTrack?.clips ?? []).filter((clip): clip is VideoClip => clip.type === 'video')
  const videoClips = compileVideoClips(sourceVideoClips, warnings)

  const audioClips: CompiledAudioClip[] = []
  const audioTrack = document.tracks.find(
    (track) => !track.muted && track.kind === 'audio' && track.clips.some((clip) => clip.type === 'audio'),
  )
  if (audioTrack) {
    for (const clip of audioTrack.clips) {
      if (clip.type !== 'audio') continue
      if (clip.role !== 'bgm') {
        warnings.push(`P1 渲染器暂不支持 ${clip.role} 音轨，已跳过片段 ${clip.id}。`)
        continue
      }
      if (audioClips.length > 0) {
        warnings.push('P1 只支持一条 BGM 音轨，已忽略后续配乐片段。')
        continue
      }
      audioClips.push({
        kind: 'audio',
        id: clip.id,
        assetId: clip.assetId,
        sourceStartSec: clip.sourceStartSec,
        sourceEndSec: clip.sourceEndSec,
        outputStartSec: 0,
        outputEndSec: videoClips.length > 0 ? videoClips[videoClips.length - 1]!.outputEndSec : 0,
        gainDb: Number.isFinite(clip.gainDb) ? clip.gainDb : -18,
        role: clip.role,
        loop: clip.loop ?? clip.role === 'bgm',
      })
    }
  }
  const overlays = compileOverlays(document, videoClips, warnings)
  const durationSec = videoClips.length > 0 ? videoClips[videoClips.length - 1]!.outputEndSec : 0
  const subtitles = compileSubtitles(document, sourceVideoClips, videoClips, analysis, warnings)
  const tracks: CompiledTrack[] = []
  if (videoTrack) tracks.push({ id: videoTrack.id, kind: 'video', clips: videoClips })
  for (const track of document.tracks) {
    if (track.kind !== 'overlay') continue
    const compiled = overlays.filter((clip) => track.clips.some((source) => source.id === clip.id))
    if (compiled.length > 0) tracks.push({ id: track.id, kind: 'overlay', clips: compiled })
  }
  if (audioTrack && audioClips.length > 0) {
    tracks.push({ id: audioTrack.id, kind: 'audio', clips: audioClips })
  }

  return {
    durationSec,
    tracks,
    videoClips,
    audioClips,
    overlays,
    subtitles,
    subtitlesEnabled: document.subtitle.enabled && document.subtitle.appearance.visible !== false,
    subtitleAppearance: { ...document.subtitle.appearance },
    ...(audioClips[0] ? { bgm: audioClips[0] } : {}),
    warnings,
  }
}

function compileVideoClips(clips: VideoClip[], warnings: string[]): CompiledVideoClip[] {
  const compiled: CompiledVideoClip[] = []
  for (const clip of clips) {
    const sourceDuration = clip.sourceEndSec - clip.sourceStartSec
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
      warnings.push(`片段 ${clip.id} 的源区间无效，已跳过。`)
      continue
    }
    let speed = clip.speed
    if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
      warnings.push(`片段 ${clip.id} 的速度 ${String(clip.speed)} 超出 ${MIN_SPEED}–${MAX_SPEED}，已按原速处理。`)
      speed = 1
    }
    const outputDuration = sourceDuration / speed
    const previous = compiled[compiled.length - 1]
    const requestedFade = previous ? transitionFade(clip.transitionIn) : 0
    let fade = requestedFade
    if (previous && fade > 0) {
      const clamped = Math.min(fade, previous.outputEndSec - previous.outputStartSec, outputDuration)
      if (clamped < fade - 1e-9) {
        warnings.push(`片段 ${clip.id} 的叠化 ${fade.toFixed(3)}s 超过相邻片段长度，已收窄为 ${clamped.toFixed(3)}s。`)
        fade = clamped
      }
    }
    const outputStart = previous ? previous.outputEndSec - fade : 0
    compiled.push({
      kind: 'video',
      id: clip.id,
      assetId: clip.assetId,
      sourceStartSec: clip.sourceStartSec,
      sourceEndSec: clip.sourceEndSec,
      outputStartSec: outputStart,
      outputEndSec: outputStart + outputDuration,
      speed,
      role: clip.role,
      transitionIn: clip.transitionIn ?? { type: 'cut' },
    })
  }
  return compiled
}

function compileOverlays(
  document: EditDocument,
  videoClips: CompiledVideoClip[],
  warnings: string[],
): CompiledOverlayClip[] {
  const endOfFilm = videoClips[videoClips.length - 1]?.outputEndSec ?? 0
  const overlays: CompiledOverlayClip[] = []
  for (const track of document.tracks) {
    if (track.muted || track.kind !== 'overlay') continue
    for (const clip of track.clips) {
      if (clip.type !== 'video') {
        warnings.push(`叠加轨 ${track.id} 只支持视频片段，已跳过 ${clip.id}。`)
        continue
      }
      const sourceDuration = (clip.sourceEndSec - clip.sourceStartSec) / (clip.speed || 1)
      if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
        warnings.push(`叠加片段 ${clip.id} 的源区间无效，已跳过。`)
        continue
      }
      const at = clip.atSec
      if (at === undefined || !Number.isFinite(at) || at < 0) {
        warnings.push(`叠加片段 ${clip.id} 缺少 atSec，已跳过。`)
        continue
      }
      if (at >= endOfFilm) {
        warnings.push(`叠加片段 ${clip.id} 从 ${at.toFixed(2)}s 开始，晚于成片结束，已跳过。`)
        continue
      }
      const end = Math.min(at + sourceDuration, endOfFilm)
      if (end - at < 0.05) {
        warnings.push(`叠加片段 ${clip.id} 在成片内不足 0.05s，已跳过。`)
        continue
      }
      if (at + sourceDuration > endOfFilm + 0.001) {
        warnings.push(`叠加片段 ${clip.id} 超出成片，已截到 ${endOfFilm.toFixed(2)}s。`)
      }
      overlays.push({
        kind: 'video',
        id: clip.id,
        assetId: clip.assetId,
        sourceStartSec: clip.sourceStartSec,
        sourceEndSec: clip.sourceEndSec,
        outputStartSec: at,
        outputEndSec: end,
        speed: clip.speed || 1,
        role: clip.role,
      })
    }
  }
  return overlays.sort((a, b) => a.outputStartSec - b.outputStartSec)
}

function transitionFade(transition: Transition | undefined): number {
  if (transition?.type !== 'crossfade') return 0
  return Number.isFinite(transition.durationSec) ? Math.max(0, transition.durationSec) : 0
}

function compileSubtitles(
  document: EditDocument,
  sourceVideoClips: VideoClip[],
  videoClips: CompiledVideoClip[],
  analysis: CompileAnalysis,
  warnings: string[],
): OutputCue[] {
  if (videoClips.length === 0) return []
  const transcripts = transcriptsByAsset(analysis)
  // 字幕源时间按素材分别计算：同一素材的多个片段仍共用一套源字幕，
  // 因此重播/相邻片段的分块口径与单素材编译完全一致。
  const sourceCuesByAsset = new Map<string, SubtitleCue[]>()
  for (const [assetId, transcript] of transcripts) {
    const clipsOfAsset = sourceVideoClips
      .filter((clip) => clip.assetId === assetId)
      .map((clip): TimelineClip => ({
        assetId: clip.assetId,
        sourceStartSec: clip.sourceStartSec,
        sourceEndSec: clip.sourceEndSec,
        speed: clip.speed,
      }))
    const cues = subtitlesForClips(transcript, clipsOfAsset)
    if (cues.length > 0) sourceCuesByAsset.set(assetId, cues)
  }
  let legacyCues: SubtitleCue[] = []
  if (sourceCuesByAsset.size === 0 && document.legacySubtitles?.length) {
    // 旧项目的字幕是唯一可得的事实；新文档不会写 legacySubtitles。
    legacyCues = document.legacySubtitles
    if (transcripts.size === 0) {
      warnings.push('没有转写，字幕使用旧项目迁移的 legacySubtitles。')
    }
  }
  if (sourceCuesByAsset.size === 0 && legacyCues.length === 0) return []

  const cues: OutputCue[] = []
  for (const clip of videoClips) {
    const sourceCues = sourceCuesByAsset.get(clip.assetId) ?? legacyCues
    for (const cue of sourceCues) {
      const start = Math.max(cue.startSec, clip.sourceStartSec)
      const end = Math.min(cue.endSec, clip.sourceEndSec)
      if (start >= end) continue
      cues.push({
        startSec: clip.outputStartSec + (start - clip.sourceStartSec) / clip.speed,
        endSec: clip.outputStartSec + (end - clip.sourceStartSec) / clip.speed,
        text: cue.text,
        clipId: clip.id,
      })
    }
  }
  return cues
}

/** 合并 transcripts 与旧 transcript；同 assetId 时逐素材记录优先。 */
function transcriptsByAsset(analysis: CompileAnalysis): Map<string, Transcript> {
  const transcripts = new Map<string, Transcript>()
  for (const [assetId, transcript] of Object.entries(analysis.transcripts ?? {})) {
    if (transcript?.segments) transcripts.set(assetId, transcript)
  }
  const legacy = analysis.transcript
  if (legacy && !transcripts.has(legacy.assetId)) {
    transcripts.set(legacy.assetId, legacy)
  }
  return transcripts
}
