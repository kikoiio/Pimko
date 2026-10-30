import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { compile } from '../src/domain/compiler'
import { emptyEditDocument } from '../src/domain/document'
import { applyPlan } from '../src/domain/edit-plan'
import type { Transcript } from '../src/domain/transcript'
import { buildBeatGrid, sceneCutsOf, type LoudnessEnvelope, type SceneShot, type VisualAnalysis } from '../src/domain/visual'
import { buildVisualBaseline, decideContentKind } from '../src/domain/visual-baseline'
import { resolveFfmpeg } from '../src/infra/ffmpeg-bin'
import {
  FfmpegSceneAnalyzer,
  buildSceneShots,
  parseBlackDetectLog,
  parseLoudnessLog,
  parseMotionSamples,
  parseSceneDetectLog,
} from '../src/infra/ffmpeg-scene-analyzer'
import { MockPlanner } from '../src/infra/mock-planner'
import { VisualPlanner } from '../src/infra/visual-planner'
import type { VisualAnalyzer } from '../src/ports/visual-analyzer'

const execFileAsync = promisify(execFile)

const asset = {
  id: 'asset',
  kind: 'video' as const,
  absolutePath: '/unused.mp4',
  durationSec: 6,
  width: 320,
  height: 180,
}
const settings = { width: 320, height: 180, fps: 30, subtitleStyle: 'bold-center' as const }

const transcript: Transcript = {
  assetId: 'asset',
  language: 'en',
  segments: [{
    startSec: 0,
    endSec: 6,
    text: 'Hello world',
    confidence: 1,
    words: [
      { word: 'Hello', startSec: 0, endSec: 2 },
      { word: 'world', startSec: 2, endSec: 6 },
    ],
  }],
}

function shot(index: number, startSec: number, endSec: number, motion = 0.1, startScore = 0): SceneShot {
  return { index, startSec, endSec, startScore, motion }
}

function visualFixture(overrides: Partial<VisualAnalysis> = {}): VisualAnalysis {
  return {
    version: 1,
    assetId: 'asset',
    durationSec: 6,
    shots: [shot(1, 0, 3), shot(2, 3, 6)],
    blackFrames: [],
    motionScore: 0.1,
    beats: { onsetsSec: [], source: 'none' },
    audioAnalyzed: false,
    notes: [],
    ...overrides,
  }
}

void test('scdet 日志解析：排序、取整、忽略无关行', () => {
  const log = [
    'Input #0, mov,mp4 from sample.mp4',
    '[scdet @ 0x1] lavfi.scd.score: 25.391, lavfi.scd.time: 4',
    '[scdet @ 0x2] lavfi.scd.score: 19.274, lavfi.scd.time: 2',
    '[scdet @ 0x3] lavfi.scd.score: 7.5, lavfi.scd.time: -0.2',
  ].join('\n')
  assert.deepEqual(parseSceneDetectLog(log), [
    { atSec: 0, score: 7.5 },
    { atSec: 2, score: 19.274 },
    { atSec: 4, score: 25.391 },
  ])
})

void test('blackdetect 日志解析：裁剪到素材时长、合并重叠区间', () => {
  const log = [
    '[blackdetect @ 0x1] black_start:4 black_end:5.966667 black_duration:1.966667',
    '[blackdetect @ 0x1] black_start:2 black_end:2.4 black_duration:0.4',
    '[blackdetect @ 0x1] black_start:2.3 black_end:2.6 black_duration:0.3',
  ].join('\n')
  assert.deepEqual(parseBlackDetectLog(log, 6), [
    { startSec: 2, endSec: 2.6, durationSec: 0.6 },
    { startSec: 4, endSec: 5.967, durationSec: 1.967 },
  ])
  assert.deepEqual(parseBlackDetectLog(log, 5), [
    { startSec: 2, endSec: 2.6, durationSec: 0.6 },
    { startSec: 4, endSec: 5, durationSec: 1 },
  ])
})

void test('signalstats metadata 解析为帧差采样，并估计镜头运动', () => {
  const stdout = [
    'frame:0    pts:6144    pts_time:0.2',
    'lavfi.signalstats.YAVG=1.5',
    'frame:1    pts:15360   pts_time:0.5',
    'lavfi.signalstats.YAVG=2.5',
    'frame:2    pts:24576   pts_time:0.8',
    'lavfi.signalstats.YAVG=3.5',
  ].join('\n')
  const samples = parseMotionSamples(stdout)
  assert.deepEqual(samples, [
    { timeSec: 0.2, meanAbsDiff: 1.5 },
    { timeSec: 0.5, meanAbsDiff: 2.5 },
    { timeSec: 0.8, meanAbsDiff: 3.5 },
  ])
  const shots = buildSceneShots([], 1, samples)
  assert.equal(shots.length, 1)
  assert.ok(Math.abs(shots[0]!.motion - 2.5 / 255) < 0.0001)
})

void test('切点去抖：边界假切点丢弃，相邻帧双切点保留高分', () => {
  const shots = buildSceneShots([
    { atSec: 0.01, score: 50 },
    { atSec: 2, score: 20 },
    { atSec: 2.05, score: 30 },
    { atSec: 4, score: 42 },
    { atSec: 5.99, score: 60 },
  ], 6)
  assert.deepEqual(shots.map((item) => ({
    startSec: item.startSec, endSec: item.endSec, startScore: item.startScore,
  })), [
    { startSec: 0, endSec: 2, startScore: 0 },
    { startSec: 2, endSec: 4, startScore: 30 },
    { startSec: 4, endSec: 6, startScore: 42 },
  ])
  assert.deepEqual(sceneCutsOf(visualFixture({ shots })), [
    { atSec: 2, score: 30 },
    { atSec: 4, score: 42 },
  ])
})

void test('响度包络解析与起音/BPM 估计是确定性的', () => {
  const log = [
    '[Parsed_ebur128_0 @ 0x1] t: 0.0999792  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU',
    '[Parsed_ebur128_0 @ 0x1] t: 0.199979   TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU',
    '[Parsed_ebur128_0 @ 0x1] t: 0.299979   TARGET:-23 LUFS    M:-22.0 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU',
    '[Parsed_ebur128_0 @ 0x1] t: 0.399979   TARGET:-23 LUFS    M:-21.0 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU',
    '[Parsed_ebur128_0 @ 0x1] Summary:',
  ].join('\n')
  const envelope = parseLoudnessLog(log)
  assert.ok(envelope)
  assert.equal(envelope.stepSec, 0.1)
  assert.deepEqual(envelope.points, [
    { timeSec: 0.1, lufs: -120.7 },
    { timeSec: 0.2, lufs: -120.7 },
    { timeSec: 0.3, lufs: -22 },
    { timeSec: 0.4, lufs: -21 },
  ])
  assert.deepEqual(envelope.points, parseLoudnessLog(log)?.points)
  assert.deepEqual(buildBeatGrid(envelope), { onsetsSec: [0.3], source: 'loudness-onsets' })

  const points = Array.from({ length: 40 }, (_, index) => {
    const step = index + 1
    const timeSec = Math.round(step * 0.1 * 1000) / 1000
    return { timeSec, lufs: step % 5 === 0 ? -20 : -60 }
  })
  const periodic: LoudnessEnvelope = {
    stepSec: 0.1, points, minLufs: -60, maxLufs: -20, meanLufs: -52,
  }
  const grid = buildBeatGrid(periodic)
  assert.equal(grid.bpm, 120)
  assert.deepEqual(grid.onsetsSec, [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4])
})

void test('视觉基线：按镜头保留、合并过短镜头、reason 带指标', () => {
  const analysis = visualFixture({
    durationSec: 3.9,
    shots: [shot(1, 0, 0.4, 0.2), shot(2, 0.4, 3, 0.1), shot(3, 3, 3.9, 0.05)],
  })
  const result = buildVisualBaseline(analysis)
  assert.deepEqual(result.plan.ops.map((op) => {
    assert.equal(op.kind, 'keep')
    return [op.startSec, op.endSec]
  }), [[0, 3], [3, 3.9]])
  assert.equal(result.plan.mode, 'draft')
  assert.equal(result.plan.contentKind, 'visual')
  assert.equal(result.metrics.mergedShotCount, 1)
  assert.equal(result.metrics.keptClipCount, 2)
  assert.equal(result.metrics.keptDurationSec, 3.9)
  assert.match(result.plan.ops[0]!.reason ?? '', /合并 2 个连续镜头/)
  assert.match(result.plan.note, /3 个镜头/)
  assert.deepEqual(result, buildVisualBaseline(analysis))
})

void test('视觉基线：剔除黑帧、丢弃黑帧后的碎片，结果稳定', () => {
  const analysis = visualFixture({
    shots: [shot(1, 0, 2, 0.2), shot(2, 2, 4, 0.1), shot(3, 4, 6, 0.05)],
    blackFrames: [{ startSec: 4, endSec: 5.966667, durationSec: 1.966667 }],
  })
  const result = buildVisualBaseline(analysis)
  assert.deepEqual(result.plan.ops.map((op) => [op.startSec, op.endSec]), [[0, 2], [2, 4]])
  assert.equal(result.metrics.blackRangeCount, 1)
  assert.equal(result.metrics.droppedBlackSec, 1.967)
  assert.equal(result.metrics.droppedFragmentCount, 1)
  assert.equal(result.metrics.keptDurationSec, 4)
  assert.match(result.plan.note, /剔除 2.0s 黑帧/)
  assert.deepEqual(result, buildVisualBaseline(analysis))

  const keepBlack = buildVisualBaseline(analysis, { trimBlackFrames: false })
  assert.equal(keepBlack.plan.ops.length, 3)
  assert.equal(keepBlack.metrics.droppedBlackSec, 0)
})

void test('视觉基线兜底：无镜头或全黑时保留整段，不产出空计划', () => {
  const noShots = buildVisualBaseline(visualFixture({ durationSec: 5, shots: [] }))
  assert.equal(noShots.plan.ops.length, 1)
  assert.deepEqual([noShots.plan.ops[0]!.startSec, noShots.plan.ops[0]!.endSec], [0, 5])
  assert.equal(noShots.metrics.usedFallback, true)
  assert.match(noShots.plan.note, /未检测到镜头切点/)

  const allBlack = buildVisualBaseline(visualFixture({
    shots: [shot(1, 0, 6, 0)],
    blackFrames: [{ startSec: 0, endSec: 6, durationSec: 6 }],
  }))
  assert.equal(allBlack.plan.ops.length, 1)
  assert.deepEqual([allBlack.plan.ops[0]!.startSec, allBlack.plan.ops[0]!.endSec], [0, 6])
  assert.equal(allBlack.metrics.usedFallback, true)
  assert.match(allBlack.plan.ops[0]!.reason ?? '', /黑帧/)
})

void test('内容类型判定：词级转写→speech；无转写场景多→visual；静态长镜头→tutorial', () => {
  const speech = decideContentKind({ transcript })
  assert.equal(speech.contentKind, 'speech')
  assert.equal(speech.confidence, 'high')

  const sentenceOnly: Transcript = {
    assetId: 'asset', language: 'en',
    segments: [{ startSec: 0, endSec: 2, text: 'Hello', confidence: 1 }],
  }
  assert.equal(decideContentKind({ transcript: sentenceOnly }).contentKind, 'speech')
  assert.equal(decideContentKind({ transcript: sentenceOnly }).confidence, 'low')

  const montage = decideContentKind({
    visual: visualFixture({
      durationSec: 8,
      shots: [shot(1, 0, 2, 0.2), shot(2, 2, 4, 0.2), shot(3, 4, 6, 0.2), shot(4, 6, 8, 0.2)],
      motionScore: 0.2,
    }),
  })
  assert.equal(montage.contentKind, 'visual')
  assert.equal(montage.confidence, 'medium')

  const tutorial = decideContentKind({
    visual: visualFixture({
      durationSec: 10,
      shots: [shot(1, 0, 10, 0.002)],
      motionScore: 0.002,
    }),
  })
  assert.equal(tutorial.contentKind, 'tutorial')
  assert.equal(tutorial.confidence, 'low')
  assert.match(tutorial.reasons.join(''), /OCR/)

  const lowMotionMontage = decideContentKind({
    visual: visualFixture({
      durationSec: 8,
      shots: [shot(1, 0, 2, 0.001), shot(2, 2, 4, 0.001), shot(3, 4, 8, 0.001)],
      motionScore: 0.001,
    }),
  })
  assert.equal(lowMotionMontage.contentKind, 'visual')
  assert.equal(lowMotionMontage.confidence, 'low')
  assert.match(lowMotionMontage.reasons.join(''), /OCR/)

  const slowSingleShot = decideContentKind({
    visual: visualFixture({
      durationSec: 20,
      shots: [shot(1, 0, 20, 0.02)],
      motionScore: 0.02,
    }),
  })
  assert.equal(slowSingleShot.contentKind, 'mixed')
  assert.equal(slowSingleShot.confidence, 'low')

  const mixed = decideContentKind({
    visual: visualFixture({
      durationSec: 8,
      shots: [shot(1, 0, 4, 0.3), shot(2, 4, 8, 0.3)],
      motionScore: 0.3,
    }),
  })
  assert.equal(mixed.contentKind, 'mixed')
  assert.equal(decideContentKind({}).contentKind, 'mixed')
})

void test('VisualPlanner：无转写走视觉基线，有转写委托语音 planner，不重复分析', async () => {
  const visual = visualFixture({
    shots: [shot(1, 0, 2, 0.2), shot(2, 2, 4, 0.1), shot(3, 4, 6, 0.05)],
    motionScore: 0.12,
  })
  let analyzeCalls = 0
  const analyzer: VisualAnalyzer = {
    async analyze() {
      analyzeCalls += 1
      return visual
    },
  }
  const planner = new VisualPlanner({ analyzer, transcriptPlanner: new MockPlanner() })
  const draft = await planner.propose({
    mode: 'draft', contentKind: 'mixed', document: emptyEditDocument(),
    assets: [asset], settings,
  })
  assert.equal(analyzeCalls, 1)
  assert.equal(draft.contentKind, 'visual')
  assert.equal(draft.mode, 'draft')
  assert.ok(draft.ops.length > 0)
  assert.match(draft.note, /蒙太奇/)

  const document = applyPlan(emptyEditDocument(), draft, { assets: [asset], contentKind: draft.contentKind })
  const compiled = compile(document)
  assert.ok(compiled.videoClips.length > 0)
  assert.equal(compiled.videoClips[0]?.role, 'broll')

  const reuse = await planner.propose({
    mode: 'draft', contentKind: 'mixed', document: emptyEditDocument(),
    visual, assets: [asset], settings,
  })
  assert.equal(analyzeCalls, 1)
  assert.equal(reuse.contentKind, 'visual')

  const speechDraft = await planner.propose({
    mode: 'draft', contentKind: 'speech', document: emptyEditDocument(),
    transcript, assets: [asset], settings,
  })
  assert.equal(analyzeCalls, 1)
  assert.equal(speechDraft.contentKind, 'speech')
  assert.ok(speechDraft.ops.length > 0)
})

function hasFfmpeg(): boolean {
  try {
    execFileSync(resolveFfmpeg(), ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function withGeneratedMontage(run: (file: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'pimko-visual-'))
  try {
    const file = path.join(root, 'montage.mp4')
    await execFileAsync(resolveFfmpeg(), [
      '-y', '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]',
      '-map', '[v]', '-map', '3:a',
      '-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      file,
    ], { maxBuffer: 16 * 1024 * 1024 })
    await run(file)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

void test('ffmpeg 视觉分析：镜头/黑帧/响度/运动，可序列化且重复运行一致', { skip: !hasFfmpeg() }, async () => {
  await withGeneratedMontage(async (file) => {
    const analyzer = new FfmpegSceneAnalyzer()
    const source = { ...asset, absolutePath: file }
    const first = await analyzer.analyze(source)
    const second = await analyzer.analyze(source)
    assert.deepEqual(second, first)
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first)

    assert.equal(first.shots.length, 3)
    assert.equal(first.shots[0]!.startSec, 0)
    assert.ok(Math.abs(first.shots[1]!.startSec - 2) < 0.05)
    assert.ok(Math.abs(first.shots[2]!.startSec - 4) < 0.05)
    assert.equal(first.shots[0]!.startScore, 0)
    assert.ok(first.shots[1]!.startScore > 8)
    assert.ok(first.shots[0]!.motion > 0)
    assert.equal(first.motionScore > 0, true)

    assert.equal(first.blackFrames.length, 1)
    assert.ok(first.blackFrames[0]!.startSec > 3.9)
    assert.ok(first.blackFrames[0]!.endSec > 5.9)

    assert.equal(first.audioAnalyzed, true)
    assert.ok((first.loudness?.points.length ?? 0) > 0)
    assert.ok(first.beats.onsetsSec.length >= 1)
  })
})

void test('无语音路径端到端：真实分析 → VisualPlanner → applyPlan → 编译非空', { skip: !hasFfmpeg() }, async () => {
  await withGeneratedMontage(async (file) => {
    const source = { ...asset, absolutePath: file }
    const planner = new VisualPlanner({
      analyzer: new FfmpegSceneAnalyzer(),
      transcriptPlanner: new MockPlanner(),
    })
    const plan = await planner.propose({
      mode: 'draft', contentKind: 'mixed', document: emptyEditDocument(),
      assets: [source], settings,
    })
    assert.equal(plan.contentKind, 'visual')
    assert.ok(plan.ops.length >= 2)
    assert.match(plan.note, /镜头|蒙太奇/)
    const document = applyPlan(emptyEditDocument(), plan, { assets: [source], contentKind: plan.contentKind })
    const compiled = compile(document)
    assert.ok(compiled.videoClips.length >= 2)
    assert.ok(compiled.durationSec > 3)
    assert.equal(compiled.warnings.length, 0)
  })
})

void test('Editor 无音轨时降级到视觉 planner，保持 visual contentKind', async () => {
  const revisions: import('../src/domain/project').ProjectRevision[] = []
  const store: import('../src/ports/store').ProjectStore = {
    async save(revision) { revisions.push(revision) },
    async latest(projectId) { return revisions.filter((revision) => revision.project.id === projectId).at(-1) },
    async get(projectId, revisionId) { return revisions.find((revision) => revision.project.id === projectId && revision.id === revisionId) },
    async list() { return revisions },
  }
  const analyzer: VisualAnalyzer = {
    async analyze() {
      return visualFixture({ shots: [shot(1, 0, 2), shot(2, 2, 4), shot(3, 4, 6)] })
    },
  }
  const editor = new (await import('../src/services/editor')).Editor({
    store,
    prober: { async probe() { return asset } },
    transcriber: { async transcribe() { throw new Error('这段视频没有音轨，无法转写。') } },
    silenceAnalyzer: { async analyze() { return [] } },
    intelligence: {
      async draftTimeline() { throw new Error('no-audio must not use legacy intelligence') },
      async reviseTimeline() { throw new Error('no-audio must not use legacy intelligence') },
    },
    visualPlanner: new VisualPlanner({ analyzer, transcriptPlanner: new MockPlanner() }),
    renderer: { async render() { throw new Error('test does not render') } },
  })
  const draft = await editor.createDraft('/unused.mp4', 'visual regression')
  assert.equal(draft.project.analysis?.contentKind, 'visual')
  assert.ok(draft.project.document)
  const compiled = compile(draft.project.document!, {})
  assert.ok(compiled.videoClips.length >= 2)
  assert.ok(compiled.durationSec > 3)
})
