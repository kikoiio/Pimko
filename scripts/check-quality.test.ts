import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { compile, type CompiledTimeline } from '../src/domain/compiler'
import { documentFromTimeline } from '../src/domain/legacy'
import type { MediaAsset } from '../src/domain/media'
import type { Project, ProjectRevision } from '../src/domain/project'
import type { QualityReport } from '../src/domain/quality'
import type { Transcript } from '../src/domain/transcript'
import { resolveFfmpeg } from '../src/infra/ffmpeg-bin'
import { FfmpegInspector } from '../src/infra/ffmpeg-inspector'
import type { Inspector, InspectRequest } from '../src/ports/inspector'
import type { ProjectStore } from '../src/ports/store'
import type { Renderer } from '../src/ports/renderer'
import { Editor } from '../src/services/editor'
import { QualityError, QualityGate } from '../src/services/quality-gate'

const execFileAsync = promisify(execFile)

const asset: MediaAsset = {
  id: 'asset',
  kind: 'video',
  absolutePath: '/unused.mp4',
  durationSec: 2,
  width: 320,
  height: 180,
}
const settings = { width: 320, height: 180, fps: 30, subtitleStyle: 'bold-center' as const }

function transcriptWith(words: Array<[string, number, number]>): Transcript {
  const endSec = Math.max(...words.map(([, , end]) => end))
  return {
    assetId: 'asset',
    language: 'en',
    segments: [{
      startSec: 0,
      endSec,
      text: words.map(([word]) => word).join(' '),
      confidence: 1,
      words: words.map(([word, startSec, wordEndSec]) => ({ word, startSec, endSec: wordEndSec })),
    }],
  }
}

function compiledFor(clips: Array<[number, number]>, transcript?: Transcript): CompiledTimeline {
  return compile(documentFromTimeline({
    clips: clips.map(([sourceStartSec, sourceEndSec]) => ({ assetId: 'asset', sourceStartSec, sourceEndSec })),
    subtitles: [],
    transitions: [],
  }), transcript ? { transcript } : {})
}

function requestFor(compiled: CompiledTimeline, outputPath: string, transcript?: Transcript): InspectRequest {
  return {
    compiled,
    assets: [asset],
    contentKind: 'speech',
    outputPath,
    settings,
    ...(transcript ? { transcript } : {}),
  }
}

function fakeInspector(report: Partial<QualityReport>): Inspector {
  return {
    async inspect(request) {
      return {
        revisionId: request.revisionId ?? '',
        outputHash: 'fake-hash',
        verdict: 'pass',
        expectedSec: request.compiled.durationSec,
        actualSec: request.compiled.durationSec,
        checks: [],
        cuts: [],
        ...report,
      }
    },
  }
}

async function withTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pimko-quality-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 生成 2 秒、带正弦音轨的真实 MP4，供 Inspector 读取。 */
async function makeOutput(dir: string, seconds = 2): Promise<string> {
  const outputPath = path.join(dir, `output-${seconds}.mp4`)
  await execFileAsync(resolveFfmpeg(), [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    '-shortest',
    outputPath,
  ])
  return outputPath
}

function memoryStore(revision: ProjectRevision): ProjectStore {
  const revisions = new Map([[revision.id, revision]])
  return {
    async save(next) {
      revisions.set(next.id, next)
    },
    async latest(projectId) {
      return projectId === revision.project.id ? revisions.get(revision.id) : undefined
    },
    async get(projectId, revisionId) {
      return projectId === revision.project.id ? revisions.get(revisionId) : undefined
    },
    async list() {
      return [...revisions.values()]
    },
  }
}

void test('QualityGate 把 fail 转成 QualityError，verdict 不能由 Inspector 自报', async () => {
  const compiled = compiledFor([[0, 2]])
  const outputPath = '/tmp/never-written.mp4'
  const gate = new QualityGate(fakeInspector({
    verdict: 'pass',
    checks: [{ kind: 'duration', status: 'fail', detail: '成片 1.00s 与预期 2.00s 不符' }],
  }))
  await assert.rejects(
    gate.verify(requestFor(compiled, outputPath)),
    (error: unknown) => {
      assert.ok(error instanceof QualityError)
      assert.equal(error.outputPath, outputPath)
      assert.equal(error.report.verdict, 'fail')
      assert.match(error.message, /时长/)
      return true
    },
  )
})

void test('QualityGate 允许 warn 交付；全部 skip 时判 warn 而不是伪造 pass', async () => {
  const compiled = compiledFor([[0, 2]])
  const warnGate = new QualityGate(fakeInspector({
    verdict: 'warn',
    checks: [{ kind: 'pop', status: 'warn', detail: '切点波形突变偏大' }],
  }))
  const warned = await warnGate.verify(requestFor(compiled, '/tmp/warn.mp4'))
  assert.equal(warned.verdict, 'warn')

  const skipGate = new QualityGate(fakeInspector({
    checks: [{ kind: 'wordCut', status: 'skip', detail: '没有词级转写' }],
  }))
  const skipped = await skipGate.verify(requestFor(compiled, '/tmp/skip.mp4'))
  assert.equal(skipped.verdict, 'warn')
})

void test('QualityGate 不把 Inspector 的 fail 降级成 pass（即使明细里没有 fail）', async () => {
  const gate = new QualityGate(fakeInspector({
    verdict: 'fail',
    checks: [{ kind: 'duration', status: 'pass', detail: '看起来正常' }],
  }))
  await assert.rejects(
    gate.verify(requestFor(compiledFor([[0, 2]]), '/tmp/self-fail.mp4')),
    QualityError,
  )
})

void test('真实成片：时长/分辨率/黑帧/字幕检查通过，输出哈希绑定文件', async () => withTemp(async (dir) => {
  const outputPath = await makeOutput(dir)
  const transcript = transcriptWith([['hello', 0, 1], ['world', 1, 2]])
  const compiled = compiledFor([[0, 2]], transcript)
  const report = await new FfmpegInspector().inspect(requestFor(compiled, outputPath, transcript))
  assert.equal(report.verdict, 'pass')
  assert.match(report.outputHash, /^[0-9a-f]{64}$/)
  assert.ok(Math.abs(report.actualSec - 2) < 0.1, `actualSec=${report.actualSec}`)
  assert.equal(report.checks.find((check) => check.kind === 'duration')?.status, 'pass')
  assert.equal(report.checks.find((check) => check.kind === 'resolution')?.status, 'pass')
  assert.equal(report.checks.find((check) => check.kind === 'blackFrame')?.status, 'pass')
  assert.equal(report.checks.find((check) => check.kind === 'subtitleTiming')?.status, 'pass')
}))

void test('无 transcript 时 wordCut 标 skip；有词且切在词内时 fail 并阻止导出', async () => withTemp(async (dir) => {
  const outputPath = await makeOutput(dir)
  const inspector = new FfmpegInspector()
  const withoutTranscript = await inspector.inspect(requestFor(compiledFor([[0, 1], [1, 2]]), outputPath))
  const skippedCut = withoutTranscript.cuts[0]
  assert.ok(skippedCut)
  const skipped = skippedCut.checks.find((check) => check.kind === 'wordCut')
  assert.equal(skipped?.status, 'skip')
  assert.notEqual(withoutTranscript.verdict, 'fail')

  const transcript = transcriptWith([['hello', 0, 2], ['world', 2, 3]])
  const compiled = compiledFor([[0, 1], [1, 2]], transcript)
  const report = await inspector.inspect(requestFor(compiled, outputPath, transcript))
  const cut = report.cuts[0]
  assert.ok(cut)
  assert.equal(cut.checks.find((check) => check.kind === 'wordCut')?.status, 'fail')
  assert.equal(report.verdict, 'fail')

  const gate = new QualityGate(new FfmpegInspector())
  await assert.rejects(
    gate.verify(requestFor(compiled, outputPath, transcript)),
    (error: unknown) => {
      assert.ok(error instanceof QualityError)
      assert.equal(error.report.verdict, 'fail')
      return true
    },
  )
  // 失败时保留成片供排查。
  await access(outputPath)
}))

void test('叠化切点落在词内只 warn，不按硬切 fail 处理', async () => withTemp(async (dir) => {
  const outputPath = await makeOutput(dir, 1.6)
  const transcript = transcriptWith([['hello', 0.4, 1.6], ['world', 1.6, 2]])
  const compiled = compile(documentFromTimeline({
    clips: [
      { assetId: 'asset', sourceStartSec: 0, sourceEndSec: 1 },
      { assetId: 'asset', sourceStartSec: 1, sourceEndSec: 2 },
    ],
    subtitles: [],
    transitions: [{ type: 'crossfade', durationSec: 0.4 }],
  }), { transcript })
  const report = await new FfmpegInspector().inspect(requestFor(compiled, outputPath, transcript))
  const cut = report.cuts[0]
  assert.ok(cut)
  assert.ok(cut.atSec > 0.7 && cut.atSec < 0.9, `叠化中点 atSec=${cut.atSec}`)
  assert.equal(cut.checks.find((check) => check.kind === 'wordCut')?.status, 'warn')
  assert.notEqual(report.verdict, 'fail')
}))

void test('真实成片时长与编译预期不符时 fail，且不会因分辨率正常而放行', async () => withTemp(async (dir) => {
  const outputPath = await makeOutput(dir)
  const compiled = compiledFor([[0, 5]])
  const report = await new FfmpegInspector().inspect(requestFor(compiled, outputPath))
  assert.equal(report.checks.find((check) => check.kind === 'duration')?.status, 'fail')
  assert.equal(report.checks.find((check) => check.kind === 'resolution')?.status, 'pass')
  assert.equal(report.verdict, 'fail')
  await assert.rejects(new QualityGate(new FfmpegInspector()).verify(requestFor(compiled, outputPath)), QualityError)
}))

void test('Editor.export 返回 outputPath/durationSec/quality；失败时保留成片且不伪报成功', async () => withTemp(async (dir) => {
  const project: Project = {
    id: 'project',
    name: 'quality-gate',
    assets: [asset],
    transcript: transcriptWith([['hello', 0, 2]]),
    settings,
    timeline: { clips: [{ assetId: 'asset', sourceStartSec: 0, sourceEndSec: 2 }], subtitles: [], transitions: [] },
  }
  const revision: ProjectRevision = { id: 'revision', project, createdAt: '2026-10-29T00:00:00Z' }
  const outputPath = path.join(dir, 'export.mp4')
  const renderer: Renderer = {
    async render(request) {
      await writeFile(request.outputPath, 'rendered')
      return { outputPath: request.outputPath, durationSec: request.compiled.durationSec }
    },
  }
  const deps = {
    prober: { probe: async () => asset },
    transcriber: { transcribe: async () => project.transcript! },
    intelligence: {
      draftTimeline: async () => { throw new Error('unused') },
      reviseTimeline: async () => { throw new Error('unused') },
    },
    renderer,
    store: memoryStore(revision),
    inspector: fakeInspector({
      checks: [{ kind: 'wordCut', status: 'pass', detail: '切点位于词边界' }],
      cuts: [{ atSec: 1, checks: [] }],
    }),
  }
  const editor = new Editor(deps)
  const outcome = await editor.export(project.id, outputPath)
  assert.equal(outcome.outputPath, outputPath)
  assert.equal(outcome.durationSec, 2)
  assert.equal(outcome.quality.verdict, 'pass')
  assert.equal(outcome.quality.revisionId, revision.id)

  const failingEditor = new Editor({
    ...deps,
    inspector: fakeInspector({
      checks: [{ kind: 'duration', status: 'fail', detail: '成片时长不符' }],
    }),
  })
  await assert.rejects(
    failingEditor.export(project.id, outputPath),
    (error: unknown) => {
      assert.ok(error instanceof QualityError)
      assert.equal(error.outputPath, outputPath)
      return true
    },
  )
  assert.equal(await readFile(outputPath, 'utf8'), 'rendered')
}))
