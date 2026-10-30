import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { compile } from '../src/domain/compiler'
import type { EditDocument, VideoClip } from '../src/domain/document'
import type { MediaAsset } from '../src/domain/media'
import type { ProjectRevision } from '../src/domain/project'
import type { Transcript } from '../src/domain/transcript'
import type { ProjectStore } from '../src/ports/store'
import { FfmpegProber } from '../src/infra/ffmpeg-prober'
import { FfmpegRenderer } from '../src/infra/ffmpeg-renderer'
import { MockPlanner } from '../src/infra/mock-planner'
import { resolveFfmpeg, resolveFfprobe } from '../src/infra/ffmpeg-bin'
import { Editor } from '../src/services/editor'

const execFileAsync = promisify(execFile)

function memoryStore(): { store: ProjectStore; revisions: ProjectRevision[] } {
  const revisions: ProjectRevision[] = []
  return {
    revisions,
    store: {
      async save(revision) { revisions.push(revision) },
      async latest(projectId) {
        return revisions.filter((revision) => revision.project.id === projectId).at(-1)
      },
      async get(projectId, revisionId) {
        return revisions.find((revision) => revision.project.id === projectId && revision.id === revisionId)
      },
      async list() { return revisions },
    },
  }
}

const unavailable = () => {
  throw new Error('这条路径不应调用旧 intelligence')
}

function transcriptFor(asset: MediaAsset, label: string): Transcript {
  return {
    assetId: asset.id,
    language: 'zh-CN',
    segments: [{
      startSec: 0,
      endSec: asset.durationSec,
      text: label,
      confidence: 1,
      words: [{ word: label, startSec: 0, endSec: asset.durationSec }],
    }],
  }
}

function videoClip(id: string, assetId: string, startSec: number, endSec: number, speed = 1): VideoClip {
  return { type: 'video', id, assetId, sourceStartSec: startSec, sourceEndSec: endSec, speed, role: 'speech' }
}

function hasBinary(binary: string): boolean {
  try {
    execFileSync(binary, ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const canUseFfmpeg = hasBinary(resolveFfmpeg()) && hasBinary(resolveFfprobe())

async function makeVideo(file: string, seconds: number): Promise<void> {
  await execFileAsync(resolveFfmpeg(), [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=s=160x90:r=30:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-c:a', 'aac', '-shortest',
    file,
  ])
}

void test('编译按 clip.assetId 取各自转写：字幕时间映射到各自源区间', () => {
  const document: EditDocument = {
    schemaVersion: 2,
    tracks: [{
      id: 'video-1',
      kind: 'video',
      clips: [
        videoClip('clip-1', 'asset-a', 0, 2),
        videoClip('clip-2', 'asset-b', 1, 3),
      ],
    }],
    subtitle: { enabled: true, appearance: {} },
  }
  const transcriptA: Transcript = {
    assetId: 'asset-a',
    language: 'zh',
    segments: [{
      startSec: 0, endSec: 2, text: 'A 段', confidence: 1,
      words: [{ word: 'A 段', startSec: 0, endSec: 2 }],
    }],
  }
  const transcriptB: Transcript = {
    assetId: 'asset-b',
    language: 'zh',
    segments: [{
      startSec: 0, endSec: 4, text: 'B 段', confidence: 1,
      words: [{ word: 'B 段', startSec: 1, endSec: 3 }],
    }],
  }
  const compiled = compile(document, {
    transcripts: { 'asset-a': transcriptA, 'asset-b': transcriptB },
  })
  assert.equal(compiled.durationSec, 4)
  assert.deepEqual(compiled.subtitles.map((cue) => ({
    startSec: cue.startSec, endSec: cue.endSec, text: cue.text, clipId: cue.clipId,
  })), [
    { startSec: 0, endSec: 2, text: 'A 段', clipId: 'clip-1' },
    { startSec: 2, endSec: 4, text: 'B 段', clipId: 'clip-2' },
  ])

  // 只有 A 的转写时，B 片段不应借用 A 的字幕。
  const partial = compile(document, { transcripts: { 'asset-a': transcriptA } })
  assert.deepEqual(partial.subtitles.map((cue) => cue.text), ['A 段'])
})

void test('多素材且个别无音轨时降级 visualPlanner，仍按顺序追加到同一视频轨', async () => {
  const assetA: MediaAsset = {
    id: 'asset-a', kind: 'video', absolutePath: '/videos/first.mp4',
    durationSec: 2, width: 640, height: 360,
  }
  const assetB: MediaAsset = {
    id: 'asset-b', kind: 'video', absolutePath: '/videos/second.mp4',
    durationSec: 3, width: 640, height: 360,
  }
  const { store } = memoryStore()
  const editor = new Editor({
    store,
    prober: {
      async probe(absolutePath) {
        const asset = [assetA, assetB].find((candidate) => candidate.absolutePath === absolutePath)
        if (!asset) throw new Error(`unknown probe: ${absolutePath}`)
        return asset
      },
    },
    transcriber: {
      async transcribe(asset) {
        if (asset.id === assetB.id) throw new Error('这个文件没有音轨，无法转写。')
        return transcriptFor(asset, '有声素材')
      },
    },
    intelligence: { draftTimeline: unavailable, reviseTimeline: unavailable },
    visualPlanner: {
      async propose(input) {
        const asset = input.assets[0]!
        return {
          mode: 'draft',
          contentKind: 'visual',
          note: '视觉兜底草稿',
          ops: [{
            kind: 'keep',
            assetId: asset.id,
            startSec: 0,
            endSec: asset.durationSec,
            reason: '视觉兜底保留整段',
          }],
        }
      },
    },
    renderer: { async render() { throw new Error('test does not render') } },
  })

  const revision = await editor.createDraftFromPaths(['/videos/first.mp4', '/videos/second.mp4'])
  const document = revision.project.document!
  const clips = document.tracks.flatMap((track) => track.clips).filter((clip) => clip.type === 'video')
  assert.deepEqual(clips.map((clip) => clip.assetId), ['asset-a', 'asset-b'])
  assert.deepEqual(Object.keys(revision.project.transcripts ?? {}), ['asset-a'])
  assert.equal(revision.project.analysis?.contentKind, 'mixed')
  assert.match(revision.agentNote ?? '', /first\.mp4 → second\.mp4/)
  const compiled = compile(document, revision.project.transcripts ? { transcripts: revision.project.transcripts } : {})
  assert.equal(compiled.durationSec, 5)
  assert.deepEqual(compiled.subtitles.map((cue) => cue.text), ['有声素材'])
})

void test('两段真实素材：createDraftFromPaths → 两条 clip → 时长与各自字幕', { skip: !canUseFfmpeg }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pimko-multi-'))
  try {
    const partA = path.join(root, 'part-a.mp4')
    const partB = path.join(root, 'part-b.mp4')
    await makeVideo(partA, 2)
    await makeVideo(partB, 3)

    const { store } = memoryStore()
    const editor = new Editor({
      store,
      prober: new FfmpegProber(),
      transcriber: {
        async transcribe(asset) {
          return transcriptFor(asset, asset.absolutePath.includes('part-b') ? '素材B' : '素材A')
        },
      },
      intelligence: { draftTimeline: unavailable, reviseTimeline: unavailable },
      planner: new MockPlanner(),
      renderer: { async render() { throw new Error('this test does not render') } },
    })

    // 故意逆序传入，验证合成顺序等于用户给的顺序。
    const revision = await editor.createDraftFromPaths([partB, partA], '多素材回归')
    const assets = revision.project.assets
    assert.deepEqual(assets.map((asset) => asset.absolutePath), [partB, partA])
    const assetB = assets[0]!
    const assetA = assets[1]!

    const document = revision.project.document!
    const videoTrack = document.tracks.find((track) => track.kind === 'video')
    assert.ok(videoTrack)
    assert.deepEqual(
      videoTrack.clips.filter((clip) => clip.type === 'video').map((clip) => clip.assetId),
      [assetB.id, assetA.id],
    )

    const transcripts = revision.project.transcripts ?? {}
    assert.deepEqual(Object.keys(transcripts).sort(), [assetA.id, assetB.id].sort())
    assert.equal(revision.project.transcript, undefined)

    const compiled = compile(document, {
      transcripts,
    })
    assert.ok(Math.abs(compiled.durationSec - (assetA.durationSec + assetB.durationSec)) < 0.01)
    assert.deepEqual(compiled.subtitles.map((cue) => cue.text), ['素材B', '素材A'])
    assert.ok(Math.abs(compiled.subtitles[1]!.startSec - assetB.durationSec) < 0.01)
    assert.ok(Math.abs(compiled.subtitles[1]!.endSec - compiled.durationSec) < 0.01)

    // 兼容 timeline 视图同步带出多素材字幕，不再是空数组。
    assert.deepEqual(revision.project.timeline.clips.map((clip) => clip.assetId), [assetB.id, assetA.id])
    assert.deepEqual(
      revision.project.timeline.subtitles.map((cue) => cue.text).sort(),
      ['素材A', '素材B'],
    )

    // 多素材项目必须继续可修订：变速只改片段，不丢逐素材转写与字幕归属。
    const revised = await editor.revise(revision.project.id, { text: '第一段 2 倍速' })
    const revisedCompiled = compile(revised.project.document!, { transcripts: revised.project.transcripts })
    assert.equal(revisedCompiled.videoClips.length, 2)
    assert.equal(revisedCompiled.videoClips[0]?.speed, 2)
    assert.deepEqual(revisedCompiled.subtitles.map((cue) => cue.text), ['素材B', '素材A'])
    assert.equal(Object.keys(revised.project.transcripts ?? {}).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('两段素材真实导出：成片时长等于两段之和', { skip: !canUseFfmpeg }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pimko-multi-export-'))
  try {
    const partA = path.join(root, 'part-a.mp4')
    const partB = path.join(root, 'part-b.mp4')
    await makeVideo(partA, 2)
    await makeVideo(partB, 2)

    const { store } = memoryStore()
    const editor = new Editor({
      store,
      prober: new FfmpegProber(),
      transcriber: {
        async transcribe(asset) {
          return transcriptFor(asset, asset.absolutePath.includes('part-b') ? '素材B' : '素材A')
        },
      },
      intelligence: { draftTimeline: unavailable, reviseTimeline: unavailable },
      renderer: new FfmpegRenderer(),
    })
    const revision = await editor.createDraftFromPaths([partA, partB], '多素材导出')
    const outputPath = path.join(root, 'multi.mp4')
    const outcome = await editor.export(revision.project.id, outputPath)
    const info = await stat(outputPath)
    assert.ok(info.size > 0)
    const expected = revision.project.assets.reduce((sum, asset) => sum + asset.durationSec, 0)
    assert.ok(Math.abs(outcome.durationSec - expected) < 0.3, `成片 ${outcome.durationSec}s ≠ ${expected}s`)
    const { stdout } = await execFileAsync(resolveFfprobe(), [
      '-v', 'error', '-print_format', 'json', '-show_format', outputPath,
    ])
    const probed = Number((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration)
    assert.ok(Number.isFinite(probed) && Math.abs(probed - expected) < 0.6)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
