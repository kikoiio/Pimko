import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { compile } from '../src/domain/compiler'
import { emptyEditDocument, type EditDocument } from '../src/domain/document'
import { timelineFromDocument } from '../src/domain/legacy'
import type { Project, ProjectRevision } from '../src/domain/project'
import type { ProjectStore } from '../src/ports/store'
import { resolveFfmpeg, resolveFfprobe } from '../src/infra/ffmpeg-bin'
import { FfmpegRenderer } from '../src/infra/ffmpeg-renderer'
import { Editor } from '../src/services/editor'

const execFileAsync = promisify(execFile)
const settings = { width: 320, height: 180, fps: 30, subtitleStyle: 'bold-center' as const }
const mainAsset = { id: 'main', kind: 'video' as const, absolutePath: '/unused-main.mp4', durationSec: 4, width: 320, height: 180 }
const brollAsset = { id: 'broll', kind: 'video' as const, absolutePath: '/unused-broll.mp4', durationSec: 1.2, width: 320, height: 180 }

function withOverlayDocument(): EditDocument {
  return {
    schemaVersion: 2,
    tracks: [
      {
        id: 'video-1', kind: 'video',
        clips: [{ type: 'video', id: 'clip-1', assetId: 'main', sourceStartSec: 0, sourceEndSec: 4, speed: 1, role: 'speech' }],
      },
      {
        id: 'overlay-1', kind: 'overlay',
        clips: [{
          type: 'video', id: 'broll-1', assetId: 'broll',
          sourceStartSec: 0, sourceEndSec: 1.2, speed: 1, role: 'broll', atSec: 1,
        }],
      },
    ],
    subtitle: { enabled: false, appearance: {} },
  }
}

function projectWith(document: EditDocument): Project {
  return {
    id: 'overlay-project', name: 'overlay regression',
    assets: [mainAsset, brollAsset], settings,
    document,
    timeline: timelineFromDocument(document),
  }
}

void test('compile 输出 overlay 轨道与输出时间，不改变主轨时长', () => {
  const compiled = compile(withOverlayDocument())
  assert.equal(compiled.videoClips.length, 1)
  assert.equal(compiled.durationSec, 4)
  assert.equal(compiled.overlays.length, 1)
  assert.equal(compiled.overlays[0]?.outputStartSec, 1)
  assert.equal(compiled.overlays[0]?.outputEndSec, 2.2)
  assert.deepEqual(compiled.tracks.map((track) => track.kind), ['video', 'overlay'])
  assert.equal(compiled.warnings.length, 0)
})

void test('Editor.addBroll 追加 overlay 轨、补齐素材并进入修订链', async () => {
  const revisions: ProjectRevision[] = []
  const store: ProjectStore = {
    async save(revision) { revisions.push(revision) },
    async latest(projectId) { return revisions.filter((revision) => revision.project.id === projectId).at(-1) },
    async get(projectId, revisionId) { return revisions.find((revision) => revision.project.id === projectId && revision.id === revisionId) },
    async list() { return revisions },
  }
  const baseDocument = withOverlayDocument()
  baseDocument.tracks = baseDocument.tracks.filter((track) => track.kind !== 'overlay')
  const base: ProjectRevision = {
    id: 'base', schemaVersion: 2,
    project: { ...projectWith(baseDocument), assets: [mainAsset] },
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  await store.save(base)
  const editor = new Editor({
    store,
    prober: { async probe(absolutePath) { return { ...brollAsset, absolutePath } } },
    transcriber: { async transcribe() { throw new Error('not used') } },
    intelligence: {
      async draftTimeline() { throw new Error('not used') },
      async reviseTimeline() { throw new Error('not used') },
    },
    renderer: { async render() { throw new Error('not used') } },
  })
  const revised = await editor.addBroll(base.project.id, '/broll.mp4', 1, 1.2)
  assert.equal(revised.parentRevisionId, base.id)
  assert.equal(revised.project.assets.some((asset) => asset.id === 'broll'), true)
  const compiled = compile(revised.project.document!, {})
  assert.equal(compiled.overlays.length, 1)
  assert.equal(compiled.overlays[0]?.assetId, 'broll')
  assert.equal(compiled.overlays[0]?.outputStartSec, 1)
  assert.match(revised.agentNote ?? '', /B-roll/)
})

function hasFfmpeg(): boolean {
  try {
    execFileSync(resolveFfmpeg(), ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

void test('真实渲染：B-roll overlay 合成后时长/分辨率不变', { skip: !hasFfmpeg() }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pimko-overlay-'))
  try {
    const mainPath = path.join(root, 'main.mp4')
    const brollPath = path.join(root, 'broll.mp4')
    await execFileAsync(resolveFfmpeg(), [
      '-y', '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mainPath,
    ])
    await execFileAsync(resolveFfmpeg(), [
      '-y', '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1.2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', brollPath,
    ])
    const assets = [
      { ...mainAsset, absolutePath: mainPath },
      { ...brollAsset, absolutePath: brollPath },
    ]
    const compiled = compile(withOverlayDocument())
    const out = path.join(root, 'out.mp4')
    const result = await new FfmpegRenderer().render({
      compiled, assets, settings, outputPath: out, mode: 'export',
    })
    assert.equal(result.durationSec, 4)
    const probe = await execFileAsync(resolveFfprobe(), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out,
    ])
    const actual = Number(probe.stdout.trim())
    assert.ok(Math.abs(actual - 4) < 0.2, `output duration ${actual}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('真实渲染：B-roll 与叠化同时存在时仍走 overlay 合成', { skip: !hasFfmpeg() }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pimko-overlay-fade-'))
  try {
    const a = path.join(root, 'a.mp4')
    const b = path.join(root, 'b.mp4')
    const broll = path.join(root, 'broll.mp4')
    for (const [file, color] of [[a, 'blue'], [b, 'green']] as const) {
      await execFileAsync(resolveFfmpeg(), [
        '-y', '-hide_banner', '-v', 'error',
        '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=2`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
      ])
    }
    await execFileAsync(resolveFfmpeg(), [
      '-y', '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', broll,
    ])
    const document: EditDocument = {
      schemaVersion: 2,
      tracks: [
        {
          id: 'video-1', kind: 'video',
          clips: [
            { type: 'video', id: 'a', assetId: 'main', sourceStartSec: 0, sourceEndSec: 2, speed: 1, role: 'speech' },
            { type: 'video', id: 'b', assetId: 'b', sourceStartSec: 0, sourceEndSec: 2, speed: 1, role: 'speech', transitionIn: { type: 'crossfade', durationSec: 0.3 } },
          ],
        },
        {
          id: 'overlay-1', kind: 'overlay',
          clips: [{ type: 'video', id: 'broll-1', assetId: 'broll', sourceStartSec: 0, sourceEndSec: 1, speed: 1, role: 'broll', atSec: 1 }],
        },
      ],
      subtitle: { enabled: false, appearance: {} },
    }
    const assets = [
      { ...mainAsset, absolutePath: a },
      { id: 'b', kind: 'video' as const, absolutePath: b, durationSec: 2, width: 320, height: 180 },
      { ...brollAsset, absolutePath: broll, durationSec: 1 },
    ]
    const compiled = compile(document)
    assert.equal(compiled.overlays.length, 1)
    const out = path.join(root, 'out.mp4')
    await new FfmpegRenderer().render({ compiled, assets, settings, outputPath: out, mode: 'export' })
    const probe = await execFileAsync(resolveFfprobe(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out])
    const actual = Number(probe.stdout.trim())
    assert.ok(Math.abs(actual - 3.7) < 0.25, `output duration ${actual}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
