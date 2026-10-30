import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CompiledTimeline, CompiledVideoClip } from '../domain/compiler'
import type { QualityCheck, QualityCheckStatus, QualityReport, CutCheck } from '../domain/quality'
import { verdictFromChecks } from '../domain/quality'
import type { Transcript, TranscriptWord } from '../domain/transcript'
import type { InspectRequest, Inspector } from '../ports/inspector'
import { resolveFfmpeg, resolveFfprobe } from './ffmpeg-bin'

const execFileAsync = promisify(execFile)

export interface FfmpegInspectorOptions {
  /** 时长误差上限（秒）；缺省 max(0.2, 2/fps)，容忍逐段编码/变速的帧量化累计误差。 */
  durationToleranceSec?: number
  /** blackdetect 的最短黑帧时长；达到该值判定 fail，短于它判 warn。 */
  blackFrameMinSec?: number
  /** 交给 blackdetect 的检测粒度；默认 0.1s，保证短黑帧也能进入 warn。 */
  blackDetectMinSec?: number
  blackFramePixelThreshold?: number
  /** 爆音检查窗口半径（秒）。 */
  popWindowSec?: number
  sampleRate?: number
}

/**
 * 基于 ffprobe/ffmpeg 的成片检查器。
 * 只读取 outputPath 的实际像素/音频，不把编译产物当成片结论。
 * P3 覆盖：时长、分辨率、切词、爆音（尽力而为）、黑帧、字幕时间；
 * 镜头切断/字幕遮挡按设计留到 P4 或叠加层落地后。
 */
export class FfmpegInspector implements Inspector {
  private readonly durationToleranceSec?: number
  private readonly blackFrameMinSec: number
  private readonly blackDetectMinSec: number
  private readonly blackFramePixelThreshold: number
  private readonly popWindowSec: number
  private readonly sampleRate: number

  constructor(options: FfmpegInspectorOptions = {}) {
    this.durationToleranceSec = options.durationToleranceSec
    this.blackFrameMinSec = options.blackFrameMinSec ?? 0.5
    this.blackDetectMinSec = options.blackDetectMinSec ?? 0.1
    this.blackFramePixelThreshold = options.blackFramePixelThreshold ?? 0.1
    this.popWindowSec = options.popWindowSec ?? 0.03
    this.sampleRate = options.sampleRate ?? 48000
  }

  async inspect(request: InspectRequest): Promise<QualityReport> {
    const workDir = await mkdtemp(path.join(tmpdir(), 'pimko-inspect-'))
    try {
      const evidence = new EvidenceWriter(request.evidenceDir)
      const outputHash = await hashFile(request.outputPath)
      const probe = await this.probeOutput(request.outputPath)
      if (probe?.raw) await evidence.write('probe.json', probe.raw)
      const checks: QualityCheck[] = []
      checks.push(this.durationCheck(request, probe, evidence))
      checks.push(this.resolutionCheck(request, probe, evidence))
      const black = await this.detectBlackFrames(request.outputPath, evidence)
      checks.push(this.globalBlackFrameCheck(black, evidence))
      checks.push(subtitleOcclusionCheck())
      const subtitleEvidence = await evidence.write(
        'subtitle-timing.json',
        JSON.stringify({
          enabled: request.compiled.subtitlesEnabled,
          cues: request.compiled.subtitles,
        }, null, 2),
      )
      checks.push(subtitleTimingCheck(
        request.compiled,
        request.transcript,
        probe?.durationSec ?? request.compiled.durationSec,
        subtitleEvidence,
      ))
      const cuts = await this.inspectCuts(request, probe, black, workDir, evidence)
      const allChecks = [...checks, ...cuts.flatMap((cut) => cut.checks)]
      return {
        revisionId: request.revisionId ?? '',
        outputHash,
        verdict: verdictFromChecks(allChecks),
        expectedSec: request.compiled.durationSec,
        actualSec: probe?.durationSec ?? 0,
        checks,
        cuts,
      }
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }

  private durationCheck(
    request: InspectRequest,
    probe: ProbedOutput | undefined,
    evidence: EvidenceWriter,
  ): QualityCheck {
    const expectedSec = request.compiled.durationSec
    const evidencePath = evidence.path('probe.json')
    const evidenceField = evidencePath ? { evidencePath } : {}
    if (!probe || !Number.isFinite(probe.durationSec) || probe.durationSec <= 0) {
      return {
        kind: 'duration',
        status: 'fail',
        detail: `无法用 ffprobe 读取成片时长（预期 ${expectedSec.toFixed(2)}s）。`,
        ...evidenceField,
      }
    }
    const tolerance = this.durationToleranceSec
      ?? Math.max(0.2, 2 / Math.max(1, request.settings?.fps ?? 30))
    const delta = Math.abs(probe.durationSec - expectedSec)
    if (delta > tolerance) {
      return {
        kind: 'duration',
        status: 'fail',
        detail: `成片 ${probe.durationSec.toFixed(2)}s 与编译预期 ${expectedSec.toFixed(2)}s 相差 ${delta.toFixed(2)}s，超过 ${tolerance.toFixed(2)}s。`,
        ...evidenceField,
      }
    }
    return {
      kind: 'duration',
      status: 'pass',
      detail: `成片 ${probe.durationSec.toFixed(2)}s，与预期相差 ${delta.toFixed(2)}s。`,
      ...evidenceField,
    }
  }

  private resolutionCheck(
    request: InspectRequest,
    probe: ProbedOutput | undefined,
    evidence: EvidenceWriter,
  ): QualityCheck {
    const evidencePath = evidence.path('probe.json')
    const evidenceField = evidencePath ? { evidencePath } : {}
    if (!probe?.hasVideo || !probe.width || !probe.height) {
      return { kind: 'resolution', status: 'fail', detail: '成片没有可读取的视频流。', ...evidenceField }
    }
    const settings = request.settings
    if (settings && (probe.width !== settings.width || probe.height !== settings.height)) {
      return {
        kind: 'resolution',
        status: 'fail',
        detail: `成片分辨率 ${probe.width}x${probe.height} 与项目设置 ${settings.width}x${settings.height} 不符。`,
        ...evidenceField,
      }
    }
    return {
      kind: 'resolution',
      status: 'pass',
      detail: `成片分辨率 ${probe.width}x${probe.height}${settings ? '，与项目设置一致' : ''}。`,
      ...evidenceField,
    }
  }

  private async inspectCuts(
    request: InspectRequest,
    probe: ProbedOutput | undefined,
    black: BlackDetection,
    workDir: string,
    evidence: EvidenceWriter,
  ): Promise<CutCheck[]> {
    const cuts = buildCuts(request.compiled, request.transcript)
    if (cuts.length === 0) return []
    await evidence.write(
      'word-cuts.json',
      JSON.stringify(cuts.map((cut) => ({
        atSec: round(cut.atSec),
        soft: cut.soft,
        boundaries: cut.boundaries,
      })), null, 2),
    )

    let audio: DecodedAudio | undefined
    let audioError: string | undefined
    if (probe?.hasAudio) {
      try {
        audio = await decodeAudio(request.outputPath, workDir, this.sampleRate)
      } catch (error) {
        audioError = errorText(error)
      }
    } else if (probe) {
      audioError = '成片没有音轨'
    } else {
      audioError = '无法读取成片'
    }

    await evidence.write('audio-pop.json', JSON.stringify(
      audio ? summarizeAudio(audio, cuts, this.popWindowSec) : { error: audioError },
      null,
      2,
    ))

    return cuts.map((cut) => {
      const checks: QualityCheck[] = [wordCutCheck(cut, evidence.path('word-cuts.json'))]
      checks.push(popCheck(
        cut,
        audio,
        audioError,
        this.popWindowSec,
        evidence.path('audio-pop.json'),
      ))
      checks.push(blackFrameAtCut(cut, black, this.blackFrameMinSec, evidence.path('blackdetect.log')))
      checks.push({
        kind: 'sceneBreak',
        status: 'skip',
        detail: '镜头完整性检查在 P4 视觉路径接入；P3 语音路径不做镜头判定。',
      })
      return { atSec: round(cut.atSec), checks }
    })
  }

  private async probeOutput(outputPath: string): Promise<ProbedOutput | undefined> {
    try {
      const { stdout } = await execFileAsync(resolveFfprobe(), [
        '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', outputPath,
      ], { maxBuffer: 16 * 1024 * 1024 })
      const parsed = JSON.parse(stdout) as ProbeData
      const streams = parsed.streams ?? []
      const video = streams.find((stream) => stream.codec_type === 'video')
      const audio = streams.find((stream) => stream.codec_type === 'audio')
      const streamDurations = streams
        .map((stream) => Number(stream.duration))
        .filter((duration) => Number.isFinite(duration) && duration > 0)
      const formatDuration = Number(parsed.format?.duration)
      const durationSec = Number.isFinite(formatDuration) && formatDuration > 0
        ? formatDuration
        : Math.max(0, ...streamDurations)
      return {
        durationSec,
        width: video?.width,
        height: video?.height,
        hasVideo: video !== undefined,
        hasAudio: audio !== undefined,
        raw: stdout,
      }
    } catch {
      return undefined
    }
  }

  private async detectBlackFrames(outputPath: string, evidence: EvidenceWriter): Promise<BlackDetection> {
    const args = [
      '-hide_banner', '-nostats', '-v', 'info',
      '-i', outputPath,
      '-vf', `blackdetect=d=${this.blackDetectMinSec.toFixed(2)}:pix_th=${this.blackFramePixelThreshold}`,
      '-an', '-f', 'null', '-',
    ]
    try {
      const { stderr } = await execFileAsync(resolveFfmpeg(), args, { maxBuffer: 16 * 1024 * 1024 })
      await evidence.write('blackdetect.log', stderr)
      return { intervals: parseBlackIntervals(stderr) }
    } catch (error) {
      const stderr = errorText(error)
      const intervals = parseBlackIntervals(stderr)
      if (intervals.length > 0) {
        await evidence.write('blackdetect.log', stderr)
        return { intervals }
      }
      return { intervals: undefined, detail: `blackdetect 不可用：${stderr.trim() || 'ffmpeg 执行失败'}` }
    }
  }

  private globalBlackFrameCheck(black: BlackDetection, evidence: EvidenceWriter): QualityCheck {
    const evidencePath = evidence.path('blackdetect.log')
    const evidenceField = evidencePath ? { evidencePath } : {}
    if (!black.intervals) {
      return { kind: 'blackFrame', status: 'skip', detail: black.detail ?? '黑帧检测不可用。', ...evidenceField }
    }
    if (black.intervals.length === 0) {
      return { kind: 'blackFrame', status: 'pass', detail: '整片未检测到黑帧。', ...evidenceField }
    }
    const longest = black.intervals.reduce((max, interval) => Math.max(max, interval.endSec - interval.startSec), 0)
    const ranges = black.intervals
      .slice(0, 3)
      .map((interval) => `${interval.startSec.toFixed(2)}–${interval.endSec.toFixed(2)}s`)
      .join('、')
    const status: QualityCheckStatus = longest >= this.blackFrameMinSec ? 'fail' : 'warn'
    return {
      kind: 'blackFrame',
      status,
      detail: `检测到 ${black.intervals.length} 段黑帧（${ranges}${black.intervals.length > 3 ? ' 等' : ''}），最长 ${longest.toFixed(2)}s。`,
      ...evidenceField,
    }
  }
}

interface ProbeStream {
  codec_type?: string
  width?: number
  height?: number
  duration?: string
}

interface ProbeData {
  format?: { duration?: string }
  streams?: ProbeStream[]
}

interface ProbedOutput {
  durationSec: number
  width?: number
  height?: number
  hasVideo: boolean
  hasAudio: boolean
  raw?: string
}

interface BlackInterval {
  startSec: number
  endSec: number
}

interface BlackDetection {
  /** undefined 表示检测本身失败，而不是"没有黑帧"。 */
  intervals: BlackInterval[] | undefined
  detail?: string
}

interface BoundaryCheck {
  label: string
  clipId: string
  sourceSec: number
  status: 'pass' | 'fail' | 'skip'
  detail: string
}

interface CutInfo {
  atSec: number
  soft: boolean
  boundaries: BoundaryCheck[]
}

interface DecodedAudio {
  samples: Int16Array
  sampleRate: number
}

function buildCuts(compiled: CompiledTimeline, transcript: Transcript | undefined): CutInfo[] {
  const cuts: CutInfo[] = []
  for (let index = 1; index < compiled.videoClips.length; index++) {
    const incoming = compiled.videoClips[index]!
    const outgoing = compiled.videoClips[index - 1]!
    // 用输出时间反推实际叠化长度：编译器会收窄过长转场，transitionIn 里可能仍是请求值。
    const overlap = Math.max(0, outgoing.outputEndSec - incoming.outputStartSec)
    const soft = incoming.transitionIn.type === 'crossfade' && overlap > 1e-6
    const fade = soft ? overlap : 0
    const atSec = fade > 0 ? incoming.outputStartSec + fade / 2 : incoming.outputStartSec
    const boundaries = fade > 0
      ? [
          boundaryAt(transcript, incoming, incoming.sourceStartSec + (fade / 2) * incoming.speed, '叠化入点'),
          boundaryAt(transcript, outgoing, outgoing.sourceEndSec - (fade / 2) * outgoing.speed, '叠化出点'),
        ]
      : [
          boundaryAt(transcript, incoming, incoming.sourceStartSec, '入点'),
          boundaryAt(transcript, outgoing, outgoing.sourceEndSec, '出点'),
        ]
    cuts.push({ atSec, soft: fade > 0, boundaries })
  }
  return cuts
}

function boundaryAt(
  transcript: Transcript | undefined,
  clip: CompiledVideoClip,
  sourceSec: number,
  label: string,
): BoundaryCheck {
  if (!transcript) {
    return { label, clipId: clip.id, sourceSec, status: 'skip', detail: `${label}：没有转写，跳过切词检查` }
  }
  if (transcript.assetId !== clip.assetId) {
    return {
      label,
      clipId: clip.id,
      sourceSec,
      status: 'skip',
      detail: `${label}：没有素材 ${clip.assetId} 的词级转写，跳过切词检查`,
    }
  }
  const words = transcriptWords(transcript)
  if (words.length === 0) {
    return { label, clipId: clip.id, sourceSec, status: 'skip', detail: `${label}：转写没有词级时间戳，跳过切词检查` }
  }
  const word = wordAt(words, sourceSec)
  if (word) {
    return {
      label,
      clipId: clip.id,
      sourceSec,
      status: 'fail',
      detail: `${label}源 ${sourceSec.toFixed(2)}s 落在「${word.word}」内部（${word.startSec.toFixed(2)}–${word.endSec.toFixed(2)}s）`,
    }
  }
  return {
    label,
    clipId: clip.id,
    sourceSec,
    status: 'pass',
    detail: `${label}源 ${sourceSec.toFixed(2)}s 位于词边界或词间停顿`,
  }
}

function wordCutCheck(cut: CutInfo, evidencePath: string | undefined): QualityCheck {
  const evidence = evidencePath ? { evidencePath } : {}
  const detail = cut.boundaries.map((boundary) => boundary.detail).join('；')
  if (cut.boundaries.every((boundary) => boundary.status === 'skip')) {
    return { kind: 'wordCut', status: 'skip', detail, ...evidence }
  }
  const failed = cut.boundaries.some((boundary) => boundary.status === 'fail')
  if (!failed) return { kind: 'wordCut', status: 'pass', detail, ...evidence }
  // 叠化没有硬切，切在词内是质量警告；硬切在词内直接阻止导出。
  return { kind: 'wordCut', status: cut.soft ? 'warn' : 'fail', detail, ...evidence }
}

function transcriptWords(transcript: Transcript): TranscriptWord[] {
  return transcript.segments.flatMap((segment) => segment.words ?? [])
}

function wordAt(words: TranscriptWord[], sourceSec: number): TranscriptWord | undefined {
  const epsilon = 1e-3
  return words.find((word) => sourceSec > word.startSec + epsilon && sourceSec < word.endSec - epsilon)
}

async function decodeAudio(outputPath: string, workDir: string, sampleRate: number): Promise<DecodedAudio> {
  const rawPath = path.join(workDir, 'audio.s16le')
  await execFileAsync(resolveFfmpeg(), [
    '-y', '-v', 'error',
    '-i', outputPath,
    '-vn', '-ac', '1', '-ar', String(sampleRate),
    '-f', 's16le', '-acodec', 'pcm_s16le',
    rawPath,
  ], { maxBuffer: 16 * 1024 * 1024 })
  const buffer = await readFile(rawPath)
  const samples = new Int16Array(Math.floor(buffer.length / 2))
  for (let index = 0; index < samples.length; index++) {
    samples[index] = buffer.readInt16LE(index * 2)
  }
  return { samples, sampleRate }
}

interface PopStats {
  atSec: number
  peak: number
  maxDelta: number
  medianDelta: number
}

function analyzePop(audio: DecodedAudio, atSec: number, windowSec: number): PopStats | undefined {
  const center = Math.round(atSec * audio.sampleRate)
  const half = Math.max(1, Math.round(windowSec * audio.sampleRate))
  const start = Math.max(1, center - half)
  const end = Math.min(audio.samples.length, center + half)
  if (center < 0 || center > audio.samples.length || end - start < 8) return undefined
  let peak = 0
  const deltas: number[] = []
  for (let index = start; index < end; index++) {
    const sample = audio.samples[index] ?? 0
    peak = Math.max(peak, Math.abs(sample))
    if (index > start) deltas.push(Math.abs(sample - (audio.samples[index - 1] ?? 0)))
  }
  if (deltas.length === 0) return undefined
  const sorted = [...deltas].sort((a, b) => a - b)
  const medianDelta = sorted[Math.floor(sorted.length / 2)] ?? 0
  const maxDelta = deltas.reduce((max, delta) => Math.max(max, delta), 0)
  return { atSec, peak, maxDelta, medianDelta }
}

function popCheck(
  cut: CutInfo,
  audio: DecodedAudio | undefined,
  audioError: string | undefined,
  windowSec: number,
  evidencePath: string | undefined,
): QualityCheck {
  const evidence = evidencePath ? { evidencePath } : {}
  if (!audio) {
    return { kind: 'pop', status: 'skip', detail: `${audioError ?? '无法解码成片音轨'}，跳过爆音检查。`, ...evidence }
  }
  const stats = analyzePop(audio, cut.atSec, windowSec)
  if (!stats) {
    return { kind: 'pop', status: 'skip', detail: '切点超出音轨范围，无法测量爆音。', ...evidence }
  }
  const fullScale = 32768
  const peakRatio = stats.peak / fullScale
  if (peakRatio < 0.01) {
    return { kind: 'pop', status: 'skip', detail: '切点附近接近静音，无法可靠判断爆音。', ...evidence }
  }
  const ratio = stats.medianDelta > 0 ? stats.maxDelta / stats.medianDelta : Number.POSITIVE_INFINITY
  const detail = `切点 ±${Math.round(windowSec * 1000)}ms 峰值 ${(peakRatio * 100).toFixed(1)}% FS，`
    + `最大相邻采样跳变 ${(stats.maxDelta / fullScale * 100).toFixed(1)}% FS（${ratio.toFixed(1)}× 中位数）。`
  if (stats.maxDelta >= fullScale * 0.75 && ratio >= 40) {
    return { kind: 'pop', status: 'fail', detail: `疑似爆音：${detail}`, ...evidence }
  }
  if (stats.maxDelta >= fullScale * 0.5 && ratio >= 15) {
    return { kind: 'pop', status: 'warn', detail: `切点波形突变偏大，建议复查：${detail}`, ...evidence }
  }
  return { kind: 'pop', status: 'pass', detail, ...evidence }
}

function summarizeAudio(audio: DecodedAudio, cuts: CutInfo[], windowSec: number): unknown {
  return {
    sampleRate: audio.sampleRate,
    durationSec: round(audio.samples.length / audio.sampleRate),
    windows: cuts.map((cut) => analyzePop(audio, cut.atSec, windowSec) ?? { atSec: cut.atSec, unavailable: true }),
  }
}

function blackFrameAtCut(
  cut: CutInfo,
  black: BlackDetection,
  minSec: number,
  evidencePath: string | undefined,
): QualityCheck {
  const evidence = evidencePath ? { evidencePath } : {}
  if (!black.intervals) {
    return { kind: 'blackFrame', status: 'skip', detail: black.detail ?? '黑帧检测不可用。', ...evidence }
  }
  const near = black.intervals.find(
    (interval) => interval.endSec >= cut.atSec - 0.3 && interval.startSec <= cut.atSec + 0.3,
  )
  if (!near) {
    return { kind: 'blackFrame', status: 'pass', detail: '切点附近没有黑帧。', ...evidence }
  }
  const duration = near.endSec - near.startSec
  return {
    kind: 'blackFrame',
    status: duration >= minSec ? 'fail' : 'warn',
    detail: `切点附近黑帧 ${near.startSec.toFixed(2)}–${near.endSec.toFixed(2)}s（${duration.toFixed(2)}s）。`,
    ...evidence,
  }
}

function subtitleOcclusionCheck(): QualityCheck {
  return {
    kind: 'subtitleOcclusion',
    status: 'skip',
    detail: 'P3 成片没有独立叠加层，字幕遮挡检查待叠加层引入后启用。',
  }
}

function subtitleTimingCheck(
  compiled: CompiledTimeline,
  transcript: Transcript | undefined,
  actualSec: number,
  evidencePath: string | undefined,
): QualityCheck {
  if (!compiled.subtitlesEnabled) {
    return { kind: 'subtitleTiming', status: 'skip', detail: '字幕已关闭，跳过字幕时间检查。' }
  }
  const cues = compiled.subtitles
  if (cues.length === 0) {
    const hasWords = transcript?.segments.some((segment) => (segment.words?.length ?? 0) > 0) ?? false
    if (hasWords) {
      return {
        kind: 'subtitleTiming',
        status: 'warn',
        detail: '字幕开启且转写有词，但编译结果没有字幕可叠加。',
      }
    }
    return { kind: 'subtitleTiming', status: 'skip', detail: '没有可用字幕数据，跳过字幕时间检查。' }
  }
  let invalid = 0
  let tooShort = 0
  let beyond = 0
  for (const cue of cues) {
    if (!Number.isFinite(cue.startSec) || !Number.isFinite(cue.endSec) || cue.startSec < 0 || cue.endSec <= cue.startSec) {
      invalid += 1
      continue
    }
    if (cue.endSec - cue.startSec < 0.08) tooShort += 1
    if (cue.endSec > actualSec + 0.15) beyond += 1
  }
  const evidence = evidencePath ? { evidencePath } : {}
  if (invalid > 0) {
    return { kind: 'subtitleTiming', status: 'fail', detail: `${invalid} 条字幕时间无效（负值或结束不晚于开始）。`, ...evidence }
  }
  const warnings: string[] = []
  if (tooShort > 0) warnings.push(`${tooShort} 条字幕停留短于 0.08s`)
  if (beyond > 0) warnings.push(`${beyond} 条字幕超出成片时长`)
  if (warnings.length > 0) {
    return { kind: 'subtitleTiming', status: 'warn', detail: warnings.join('；') + '。', ...evidence }
  }
  return {
    kind: 'subtitleTiming',
    status: 'pass',
    detail: `${cues.length} 条字幕时间有效且在成片范围内（未做画面 OCR 校验）。`,
    ...evidence,
  }
}

function parseBlackIntervals(log: string): BlackInterval[] {
  const intervals: BlackInterval[] = []
  const pattern = /black_start:\s*([0-9.]+)\s+black_end:\s*([0-9.]+)\s+black_duration:\s*([0-9.]+)/g
  for (const match of log.matchAll(pattern)) {
    const startSec = Number(match[1])
    const endSec = Number(match[2])
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) {
      intervals.push({ startSec, endSec })
    }
  }
  return intervals
}

async function hashFile(filePath: string): Promise<string> {
  try {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(filePath)) hash.update(chunk)
    return hash.digest('hex')
  } catch {
    return ''
  }
}

class EvidenceWriter {
  private readonly written = new Map<string, string>()

  constructor(private readonly dir: string | undefined) {}

  path(name: string): string | undefined {
    return this.written.get(name)
  }

  async write(name: string, content: string): Promise<string | undefined> {
    if (!this.dir) return undefined
    try {
      await mkdir(this.dir, { recursive: true })
      const file = path.join(this.dir, name)
      await writeFile(file, content, 'utf8')
      this.written.set(name, file)
      return file
    } catch {
      return undefined
    }
  }
}

function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    if ('stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) return error.stderr
    if (error instanceof Error) return error.message
  }
  return String(error)
}

function round(value: number): number {
  return Number(value.toFixed(3))
}
