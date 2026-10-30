import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MediaAsset } from '../domain/media'
import {
  VISUAL_ANALYSIS_VERSION,
  buildBeatGrid,
  emptyVisualAnalysis,
  type BlackFrameRange,
  type LoudnessEnvelope,
  type SceneCut,
  type SceneShot,
  type VisualAnalysis,
} from '../domain/visual'
import type { VisualAnalyzer } from '../ports/visual-analyzer'
import { resolveFfmpeg } from './ffmpeg-bin'

const execFileAsync = promisify(execFile)

export interface FfmpegSceneAnalyzerOptions {
  /** scdet 阈值（0–100，默认 8）；越低越敏感、误报越多。 */
  sceneThreshold: number
  /** blackdetect 最短黑帧时长（秒）。 */
  blackMinDurationSec: number
  /** blackdetect 像素阈值（0–1）。 */
  blackPixelThreshold: number
  /** 是否分析音频响度/节拍。 */
  analyzeAudio: boolean
  /** 运动摘要的抽帧宽度；只影响速度，不影响切点。 */
  motionWidth: number
}

export const DEFAULT_SCENE_ANALYZER_OPTIONS: FfmpegSceneAnalyzerOptions = {
  sceneThreshold: 8,
  blackMinDurationSec: 0.15,
  blackPixelThreshold: 0.1,
  analyzeAudio: true,
  motionWidth: 64,
}

/** 兼容既有测试命名；结构就是 domain 的 SceneCut。 */
export type DetectedSceneCut = SceneCut

export interface MotionSample {
  timeSec: number
  /** 相邻帧的平均绝对亮度差（0–255）；由 tblend difference + signalstats 得到。 */
  meanAbsDiff: number
}

/**
 * 基于 ffmpeg 的确定性视觉分析：
 * - scdet 检测镜头切点；
 * - blackdetect 检测黑帧；
 * - tblend 帧差 + signalstats 抽样，得到镜头内部运动摘要；
 * - ebur128 响度包络 + 简单起音检测，得到节拍摘要。
 *
 * 所有结果都按固定精度取整，重复运行同一素材得到同一份 JSON。
 */
export class FfmpegSceneAnalyzer implements VisualAnalyzer {
  private readonly options: FfmpegSceneAnalyzerOptions

  constructor(options: Partial<FfmpegSceneAnalyzerOptions> = {}) {
    this.options = { ...DEFAULT_SCENE_ANALYZER_OPTIONS, ...options }
  }

  async analyze(asset: MediaAsset): Promise<VisualAnalysis> {
    if (asset.kind !== 'video') throw new Error('视觉分析只支持视频素材。')
    if (!Number.isFinite(asset.durationSec) || asset.durationSec <= 0) {
      return emptyVisualAnalysis(asset.id, 0, ['素材时长无效，已跳过视觉分析。'])
    }

    const video = await this.analyzeVideo(asset)
    const notes = [...video.notes]
    let loudness: LoudnessEnvelope | undefined
    let audioAnalyzed = false
    if (this.options.analyzeAudio) {
      const audio = await this.analyzeAudio(asset)
      loudness = audio.loudness
      audioAnalyzed = audio.loudness !== undefined
      if (audio.note) notes.push(audio.note)
    } else {
      notes.push('已按配置跳过音频分析，节拍摘要为空。')
    }

    return {
      version: VISUAL_ANALYSIS_VERSION,
      assetId: asset.id,
      durationSec: round(asset.durationSec, 3),
      shots: video.shots,
      blackFrames: video.blackFrames,
      motionScore: weightedMotion(video.shots),
      beats: buildBeatGrid(loudness),
      ...(loudness ? { loudness } : {}),
      audioAnalyzed,
      notes,
    }
  }

  private async analyzeVideo(asset: MediaAsset): Promise<{
    shots: SceneShot[]
    blackFrames: BlackFrameRange[]
    notes: string[]
  }> {
    const filters = [
      `scdet=threshold=${this.options.sceneThreshold}`,
      `blackdetect=d=${this.options.blackMinDurationSec}:pix_th=${this.options.blackPixelThreshold}`,
      `scale=${this.options.motionWidth}:-2`,
      'tblend=all_mode=difference',
      'signalstats',
      'metadata=mode=print:file=-:key=lavfi.signalstats.YAVG',
    ].join(',')
    const { stdout, stderr } = await execFileAsync(resolveFfmpeg(), [
      '-hide_banner', '-nostats', '-nostdin', '-v', 'info',
      '-i', asset.absolutePath,
      '-an',
      '-vf', filters,
      '-f', 'null', '-',
    ], { maxBuffer: 64 * 1024 * 1024 })

    const cuts = parseSceneDetectLog(stderr)
    const blackFrames = parseBlackDetectLog(stderr, asset.durationSec)
    const shots = buildSceneShots(cuts, asset.durationSec, parseMotionSamples(stdout))
    return {
      shots,
      blackFrames,
      notes: shots.length <= 1 ? ['没有检测到镜头切点，素材按单镜头处理。'] : [],
    }
  }

  private async analyzeAudio(asset: MediaAsset): Promise<{
    loudness?: LoudnessEnvelope
    note?: string
  }> {
    try {
      const { stderr } = await execFileAsync(resolveFfmpeg(), [
        '-hide_banner', '-nostats', '-nostdin', '-v', 'info',
        '-i', asset.absolutePath,
        '-vn',
        '-af', 'ebur128=framelog=info',
        '-f', 'null', '-',
      ], { maxBuffer: 16 * 1024 * 1024 })
      const loudness = parseLoudnessLog(stderr)
      if (!loudness) return { note: '音频分析没有返回响度采样，节拍摘要为空。' }
      return { loudness }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const missingAudio = /does not contain any stream|matches no streams|no audio/i.test(message)
      return {
        note: missingAudio ? '素材没有音频轨，节拍摘要为空。' : '音频分析失败，节拍摘要为空。',
      }
    }
  }
}

/** 解析 scdet 日志：`lavfi.scd.score: 25.391, lavfi.scd.time: 4`。 */
export function parseSceneDetectLog(log: string): DetectedSceneCut[] {
  const cuts: DetectedSceneCut[] = []
  for (const line of log.split('\n')) {
    const match = /lavfi\.scd\.score:\s*(-?\d+(?:\.\d+)?),\s*lavfi\.scd\.time:\s*(-?\d+(?:\.\d+)?)/.exec(line)
    if (!match) continue
    const score = Number(match[1])
    const atSec = Number(match[2])
    if (!Number.isFinite(score) || !Number.isFinite(atSec)) continue
    cuts.push({ atSec: round(Math.max(0, atSec), 3), score: round(score, 3) })
  }
  return cuts.sort((a, b) => a.atSec - b.atSec)
}

/** 解析 blackdetect 日志，并合并重叠/相邻区间。 */
export function parseBlackDetectLog(log: string, durationSec: number): BlackFrameRange[] {
  const ranges: BlackFrameRange[] = []
  let openStart: number | null = null
  for (const line of log.split('\n')) {
    const startMatch = /black_start:\s*(-?\d+(?:\.\d+)?)/.exec(line)
    const endMatch = /black_end:\s*(-?\d+(?:\.\d+)?)/.exec(line)
    if (startMatch) {
      const start = Math.max(0, Number(startMatch[1]))
      if (!Number.isFinite(start)) continue
      if (endMatch) {
        pushBlackRange(ranges, start, Number(endMatch[1]), durationSec)
        openStart = null
      } else {
        openStart = start
      }
      continue
    }
    if (endMatch && openStart !== null) {
      pushBlackRange(ranges, openStart, Number(endMatch[1]), durationSec)
      openStart = null
    }
  }
  // blackdetect 在文件结束时可能只留下 black_start；闭合到素材末尾。
  if (openStart !== null) pushBlackRange(ranges, openStart, durationSec, durationSec)
  return mergeBlackRanges(ranges)
}

function pushBlackRange(
  ranges: BlackFrameRange[],
  startSec: number,
  endSec: number,
  durationSec: number,
): void {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return
  const start = round(Math.max(0, Math.min(durationSec, startSec)), 3)
  const end = round(Math.max(0, Math.min(durationSec, endSec)), 3)
  if (end - start <= 0.001) return
  ranges.push({ startSec: start, endSec: end, durationSec: round(end - start, 3) })
}

function mergeBlackRanges(ranges: BlackFrameRange[]): BlackFrameRange[] {
  const merged: BlackFrameRange[] = []
  for (const range of [...ranges].sort((a, b) => a.startSec - b.startSec)) {
    const last = merged[merged.length - 1]
    if (last && range.startSec <= last.endSec + 0.001) {
      last.endSec = round(Math.max(last.endSec, range.endSec), 3)
      last.durationSec = round(last.endSec - last.startSec, 3)
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

/** 解析 ebur128 的 momentary 响度行；静音用 ffmpeg 的 -120.7 LUFS 口径。 */
export function parseLoudnessLog(log: string): LoudnessEnvelope | undefined {
  const points: Array<{ timeSec: number; lufs: number }> = []
  for (const line of log.split('\n')) {
    if (!line.includes('Parsed_ebur128')) continue
    const match = /\bt:\s*(-?\d+(?:\.\d+)?)\s+.*?\bM:\s*(-?(?:\d+(?:\.\d+)?|inf))/i.exec(line)
    if (!match) continue
    const timeSec = round(Math.max(0, Number(match[1])), 3)
    const lufs = /inf/i.test(match[2]!) ? -120.7 : round(Number(match[2]), 1)
    if (!Number.isFinite(timeSec) || !Number.isFinite(lufs)) continue
    const last = points[points.length - 1]
    if (last && timeSec - last.timeSec < 0.001) continue
    points.push({ timeSec, lufs })
  }
  if (points.length === 0) return undefined
  points.sort((a, b) => a.timeSec - b.timeSec)
  const differences: number[] = []
  for (let index = 1; index < points.length; index++) {
    differences.push(points[index]!.timeSec - points[index - 1]!.timeSec)
  }
  differences.sort((a, b) => a - b)
  const stepSec = differences.length > 0 ? round(differences[Math.floor(differences.length / 2)]!, 3) : 0.1
  const values = points.map((point) => point.lufs)
  return {
    stepSec,
    points,
    minLufs: round(Math.min(...values), 1),
    maxLufs: round(Math.max(...values), 1),
    meanLufs: round(values.reduce((sum, value) => sum + value, 0) / values.length, 1),
  }
}

/** 解析 signalstats metadata 输出：frame/pts_time 行 + 帧差 YAVG 行。 */
export function parseMotionSamples(stdout: string): MotionSample[] {
  const samples: MotionSample[] = []
  let frameTime: number | null = null
  for (const line of stdout.split('\n')) {
    const frameMatch = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(line)
    if (frameMatch) {
      frameTime = Math.max(0, Number(frameMatch[1]))
      continue
    }
    const yAvgMatch = /lavfi\.signalstats\.YAVG=(-?\d+(?:\.\d+)?)/.exec(line)
    if (yAvgMatch && frameTime !== null) {
      const meanAbsDiff = Number(yAvgMatch[1])
      if (Number.isFinite(frameTime) && Number.isFinite(meanAbsDiff)) {
        samples.push({ timeSec: round(frameTime, 3), meanAbsDiff })
      }
      frameTime = null
    }
  }
  return samples.sort((a, b) => a.timeSec - b.timeSec)
}

/**
 * 切点 → 镜头表：去掉边界附近的假切点、合并过近的切点，
 * 并用帧间差异均值估计镜头内部运动（排除切点附近，避免把切点本身算成运动）。
 */
export function buildSceneShots(
  cuts: DetectedSceneCut[],
  durationSec: number,
  motionSamples: MotionSample[] = [],
): SceneShot[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return []
  const accepted: DetectedSceneCut[] = []
  const minCutGapSec = 0.12
  const edgeGuardSec = 0.02
  for (const cut of [...cuts].sort((a, b) => a.atSec - b.atSec)) {
    if (!Number.isFinite(cut.atSec) || cut.atSec <= edgeGuardSec || cut.atSec >= durationSec - edgeGuardSec) continue
    const last = accepted[accepted.length - 1]
    if (last && cut.atSec - last.atSec < minCutGapSec) {
      // 闪光/快速切换会在相邻帧产生两个切点，保留分数更高的一个。
      if (cut.score > last.score) accepted[accepted.length - 1] = { atSec: last.atSec, score: round(cut.score, 3) }
      continue
    }
    accepted.push({ atSec: round(cut.atSec, 3), score: round(cut.score, 3) })
  }

  const boundaries = [0, ...accepted.map((cut) => cut.atSec), round(durationSec, 3)]
  const samples = [...motionSamples].sort((a, b) => a.timeSec - b.timeSec)
  const shots: SceneShot[] = []
  const boundaryGuardSec = 0.05
  for (let index = 0; index < boundaries.length - 1; index++) {
    const startSec = boundaries[index]!
    const endSec = boundaries[index + 1]!
    if (endSec - startSec < 0.001) continue
    const lower = startSec + boundaryGuardSec
    const upper = endSec - boundaryGuardSec
    const inside = samples.filter((sample) => sample.timeSec > lower && sample.timeSec < upper)
    const motion = inside.length > 0
      ? Math.min(1, Math.max(0, inside.reduce((sum, sample) => sum + sample.meanAbsDiff, 0) / inside.length / 255))
      : 0
    shots.push({
      index: index + 1,
      startSec: round(startSec, 3),
      endSec: round(endSec, 3),
      startScore: index === 0 ? 0 : accepted[index - 1]!.score,
      motion: round(motion, 4),
    })
  }
  return shots
}

function weightedMotion(shots: SceneShot[]): number {
  let weighted = 0
  let duration = 0
  for (const shot of shots) {
    const length = shot.endSec - shot.startSec
    weighted += shot.motion * length
    duration += length
  }
  return duration > 0 ? round(weighted / duration, 4) : 0
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
