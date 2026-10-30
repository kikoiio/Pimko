/**
 * 视觉分析事实：镜头、黑帧、运动与节拍摘要。
 * 只存纯数据，可 JSON 序列化；同一素材 + 同一分析器必须得到同一结果。
 */
export const VISUAL_ANALYSIS_VERSION = 1 as const

export interface VisualRange {
  startSec: number
  endSec: number
}

export interface SceneShot extends VisualRange {
  /** 1-based，按源时间顺序。 */
  index: number
  /** 打开这个镜头的 scdet 分数；第一个镜头没有切点，记为 0。 */
  startScore: number
  /** 镜头内部的平均亮度变化（0–1）；静态画面接近 0。 */
  motion: number
}

/** 镜头切点（源时间）；由 shots[1..] 的起点派生，供质量闸门/调试使用。 */
export interface SceneCut {
  atSec: number
  score: number
}

export function sceneCutsOf(analysis: VisualAnalysis): SceneCut[] {
  return analysis.shots.slice(1).map((shot) => ({ atSec: shot.startSec, score: shot.startScore }))
}

export interface BlackFrameRange extends VisualRange {
  durationSec: number
}

export interface LoudnessPoint {
  timeSec: number
  lufs: number
}

export interface LoudnessEnvelope {
  /** 相邻采样间隔（秒）；ebur128 momentary 通常为 0.1。 */
  stepSec: number
  points: LoudnessPoint[]
  minLufs: number
  maxLufs: number
  meanLufs: number
}

export interface BeatGrid {
  /** 响度跃升得到的起音/节拍候选；不是音乐节拍跟踪。 */
  onsetsSec: number[]
  bpm?: number
  source: 'loudness-onsets' | 'none'
}

export interface VisualAnalysis {
  version: typeof VISUAL_ANALYSIS_VERSION
  assetId: string
  durationSec: number
  shots: SceneShot[]
  blackFrames: BlackFrameRange[]
  /** 全片运动摘要：按镜头时长加权的镜头内部亮度变化均值（0–1）。 */
  motionScore: number
  beats: BeatGrid
  loudness?: LoudnessEnvelope
  /** 音频分析是否成功；false 时 beats 为空，notes 说明原因。 */
  audioAnalyzed: boolean
  /** 非致命问题（无音轨、无镜头等），供 planner/UI 显示。 */
  notes: string[]
}

const ONSET_DELTA_DB = 6
const ONSET_FLOOR_LUFS = -45
const ONSET_MIN_GAP_SEC = 0.25
const MIN_BPM = 40
const MAX_BPM = 220

export function emptyVisualAnalysis(
  assetId: string,
  durationSec: number,
  notes: string[] = [],
): VisualAnalysis {
  return {
    version: VISUAL_ANALYSIS_VERSION,
    assetId,
    durationSec,
    shots: [],
    blackFrames: [],
    motionScore: 0,
    beats: { onsetsSec: [], source: 'none' },
    audioAnalyzed: false,
    notes,
  }
}

/**
 * 从响度包络提取起音候选与粗略 BPM。
 * 只认“相对上一个采样突然变响”的位置，避免持续响度被误判成连续节拍。
 */
export function buildBeatGrid(envelope?: LoudnessEnvelope): BeatGrid {
  if (!envelope || envelope.points.length === 0) {
    return { onsetsSec: [], source: 'none' }
  }
  const points = envelope.points
  const onsets: number[] = []
  for (let index = 1; index < points.length; index++) {
    const current = points[index]!
    const previous = points[index - 1]!
    if (current.lufs < ONSET_FLOOR_LUFS) continue
    if (current.lufs - previous.lufs < ONSET_DELTA_DB) continue
    const last = onsets[onsets.length - 1]
    if (last !== undefined && current.timeSec - last < ONSET_MIN_GAP_SEC) continue
    onsets.push(round(current.timeSec, 3))
  }
  const bpm = estimateBpm(onsets)
  return {
    onsetsSec: onsets,
    ...(bpm !== undefined ? { bpm } : {}),
    source: 'loudness-onsets',
  }
}

function estimateBpm(onsets: number[]): number | undefined {
  if (onsets.length < 3) return undefined
  const intervals: number[] = []
  for (let index = 1; index < onsets.length; index++) {
    intervals.push(onsets[index]! - onsets[index - 1]!)
  }
  intervals.sort((a, b) => a - b)
  const median = intervals[Math.floor(intervals.length / 2)]!
  if (!Number.isFinite(median) || median <= 0) return undefined
  const bpm = Math.round(60 / median)
  return bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : undefined
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
