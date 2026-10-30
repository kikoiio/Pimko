import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compile } from '../src/domain/compiler'
import type { EditDocument } from '../src/domain/document'
import {
  compileProject,
  documentFromTimeline,
  legacyBgmAssetId,
  normalizeProject,
  timelineFromDocument,
} from '../src/domain/legacy'
import type { Project } from '../src/domain/project'
import { timelineDurationSec, type Timeline } from '../src/domain/timeline'
import type { Transcript } from '../src/domain/transcript'

const transcript: Transcript = {
  assetId: 'asset',
  language: 'en',
  segments: [{
    startSec: 0,
    endSec: 5,
    text: 'Hello um world again',
    confidence: 1,
    words: [
      { word: 'Hello', startSec: 0, endSec: 1 },
      { word: 'um', startSec: 1, endSec: 2 },
      { word: 'world', startSec: 2, endSec: 3 },
      { word: 'again', startSec: 3, endSec: 5 },
    ],
  }],
}

const timeline: Timeline = {
  clips: [
    { assetId: 'asset', sourceStartSec: 2, sourceEndSec: 5, speed: 2 },
    { assetId: 'asset', sourceStartSec: 0, sourceEndSec: 1 },
  ],
  subtitles: [
    { startSec: 0, endSec: 1, text: 'Hello' },
    { startSec: 2, endSec: 5, text: 'world again' },
  ],
  subtitleAppearance: { position: 'top', size: 'large', visible: true },
  bgm: { path: '/music.mp3', gainDb: -24 },
  transitions: [{ type: 'crossfade', durationSec: 0.2 }],
}

function project(timelineValue: Timeline = timeline): Project {
  return {
    id: 'project',
    name: 'document regression',
    assets: [{ id: 'asset', kind: 'video', absolutePath: '/unused.mp4', durationSec: 5, width: 640, height: 360 }],
    transcript,
    settings: { width: 640, height: 360, fps: 30, subtitleStyle: 'bold-center' },
    timeline: timelineValue,
  }
}

void test('旧时间线只读迁移为 document：视频/音频轨、转场、字幕策略与迁移字幕', () => {
  const before = structuredClone(timeline)
  const document = documentFromTimeline(timeline)
  assert.deepEqual(timeline, before)
  assert.equal(document.schemaVersion, 2)

  const video = document.tracks.find((track) => track.kind === 'video')
  assert.ok(video)
  assert.equal(video.clips.length, 2)
  assert.deepEqual(video.clips[0], {
    type: 'video', id: 'clip-1', assetId: 'asset',
    sourceStartSec: 2, sourceEndSec: 5, speed: 2, role: 'speech',
  })
  assert.deepEqual(video.clips[1]?.transitionIn, { type: 'crossfade', durationSec: 0.2 })

  const audio = document.tracks.find((track) => track.kind === 'audio')
  assert.ok(audio)
  const bgm = audio.clips[0]
  assert.equal(bgm?.type, 'audio')
  assert.equal(bgm?.type === 'audio' ? bgm.role : undefined, 'bgm')
  assert.equal(bgm?.assetId, legacyBgmAssetId('/music.mp3'))
  assert.equal(bgm?.type === 'audio' ? bgm.gainDb : undefined, -24)

  assert.deepEqual(document.subtitle, {
    enabled: true,
    appearance: { position: 'top', size: 'large', visible: true },
  })
  assert.deepEqual(document.legacySubtitles, timeline.subtitles)
})

void test('document → 兼容 timeline 视图可无损往返，旧字幕只作迁移 fallback', () => {
  const document = documentFromTimeline(timeline)
  assert.deepEqual(timelineFromDocument(document), timeline)
  const translated = documentFromTimeline(timeline, { bgmAssetId: 'external-bgm' })
  assert.equal(
    translated.tracks.find((track) => track.kind === 'audio')?.clips[0]?.assetId,
    'external-bgm',
  )
})

void test('编译顺序/变速/转场重叠：输出时间与时长和旧口径一致', () => {
  const document = documentFromTimeline(timeline)
  const compiled = compile(document, { transcript })
  assert.equal(compiled.videoClips.length, 2)
  assert.equal(compiled.videoClips[0]?.outputStartSec, 0)
  assert.equal(compiled.videoClips[0]?.outputEndSec, 1.5)
  assert.equal(compiled.videoClips[1]?.outputStartSec, 1.3)
  assert.equal(compiled.videoClips[1]?.outputEndSec, 2.3)
  assert.equal(compiled.durationSec, 2.3)
  assert.equal(timelineDurationSec(timeline), 2.3)
  assert.equal(compiled.warnings.length, 0)
  assert.deepEqual(compiled.tracks.map((track) => track.kind), ['video', 'audio'])
})

void test('字幕源时间 → 输出时间：重排与 2 倍速后仍对齐片段', () => {
  const compiled = compile(documentFromTimeline(timeline), { transcript })
  assert.deepEqual(compiled.subtitles.map((cue) => ({
    startSec: cue.startSec, endSec: cue.endSec, text: cue.text, clipId: cue.clipId,
  })), [
    { startSec: 0, endSec: 1.5, text: 'world again', clipId: 'clip-1' },
    { startSec: 1.3, endSec: 2.3, text: 'Hello', clipId: 'clip-2' },
  ])
  assert.equal(compiled.subtitlesEnabled, true)
  assert.deepEqual(compiled.subtitleAppearance, { position: 'top', size: 'large', visible: true })
})

void test('无 transcript 时字幕回退 legacySubtitles；禁用字幕只影响渲染开关', () => {
  const document = documentFromTimeline(timeline)
  const noTranscript = compile(document, {})
  assert.deepEqual(noTranscript.subtitles.map((cue) => cue.text), ['world again', 'Hello'])
  assert.ok(noTranscript.warnings.some((warning) => warning.includes('legacySubtitles')))

  const disabled: EditDocument = {
    ...document,
    subtitle: { ...document.subtitle, enabled: false },
  }
  const compiled = compile(disabled, { transcript })
  assert.equal(compiled.subtitlesEnabled, false)
  assert.equal(compiled.subtitles.length, 2)
})

void test('BGM 音轨编译为循环音频片段并保留增益', () => {
  const compiled = compile(documentFromTimeline(timeline), { transcript })
  assert.equal(compiled.audioClips.length, 1)
  assert.equal(compiled.bgm?.gainDb, -24)
  assert.equal(compiled.bgm?.loop, true)
  assert.equal(compiled.bgm?.outputStartSec, 0)
  assert.equal(compiled.bgm?.outputEndSec, compiled.durationSec)
})

void test('旧 Project 迁移：normalizeProject 生成 document/派生 timeline 并补齐 BGM 素材', () => {
  const legacyProject = project()
  const normalized = normalizeProject(legacyProject)
  assert.equal(normalized.document?.schemaVersion, 2)
  assert.deepEqual(normalized.timeline, legacyProject.timeline)
  const bgmAsset = normalized.assets.find((asset) => asset.id === legacyBgmAssetId('/music.mp3'))
  assert.equal(bgmAsset?.kind, 'audio')
  assert.equal(bgmAsset?.absolutePath, '/music.mp3')

  const compiled = compileProject(legacyProject)
  assert.equal(compiled.durationSec, 2.3)
  assert.deepEqual(compiled.subtitles.map((cue) => cue.text), ['world again', 'Hello'])
})

void test('非法速度按原速处理并给出 warning，不让渲染器拿到坏参数', () => {
  const document = documentFromTimeline({
    clips: [{ assetId: 'asset', sourceStartSec: 0, sourceEndSec: 2, speed: 99 }],
    subtitles: [],
    transitions: [],
  })
  const compiled = compile(document)
  assert.equal(compiled.videoClips[0]?.speed, 1)
  assert.equal(compiled.durationSec, 2)
  assert.ok(compiled.warnings.some((warning) => warning.includes('超出 0.5–4')))
})

void test('叠化超过相邻短片段时收窄，避免负时长', () => {
  const document = documentFromTimeline({
    clips: [
      { assetId: 'asset', sourceStartSec: 0, sourceEndSec: 0.2, speed: 2 },
      { assetId: 'asset', sourceStartSec: 2, sourceEndSec: 2.2, speed: 2 },
    ],
    subtitles: [],
    transitions: [{ type: 'crossfade', durationSec: 0.3 }],
  })
  const compiled = compile(document)
  assert.ok(Math.abs(compiled.durationSec - 0.1) < 1e-9)
  assert.equal(compiled.videoClips[1]?.outputStartSec, 0)
  assert.ok(compiled.warnings.some((warning) => warning.includes('已收窄')))
})

void test('多视频轨只编译第一条并显式 warning；空文档时长为零', () => {
  const document: EditDocument = {
    schemaVersion: 2,
    tracks: [
      {
        id: 'video-1', kind: 'video',
        clips: [{ type: 'video', id: 'a', assetId: 'asset', sourceStartSec: 0, sourceEndSec: 2, speed: 1, role: 'speech' }],
      },
      {
        id: 'video-2', kind: 'video',
        clips: [{ type: 'video', id: 'b', assetId: 'asset', sourceStartSec: 2, sourceEndSec: 4, speed: 1, role: 'broll' }],
      },
    ],
    subtitle: { enabled: true, appearance: {} },
  }
  const compiled = compile(document)
  assert.deepEqual(compiled.videoClips.map((clip) => clip.id), ['a'])
  assert.ok(compiled.warnings.some((warning) => warning.includes('第一条视频轨')))

  const empty = compile({ schemaVersion: 2, tracks: [], subtitle: { enabled: true, appearance: {} } })
  assert.equal(empty.durationSec, 0)
  assert.deepEqual(empty.videoClips, [])
  assert.deepEqual(empty.subtitles, [])
})
