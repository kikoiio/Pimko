import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findFillerWords } from '../src/domain/fillers'
import { applyPauseCompressions, planPauseCompressions } from '../src/domain/pause-compress'
import { OpenAiIntelligence } from '../src/infra/openai-intelligence'
import type { Project } from '../src/domain/project'

const project: Project = {
  id: 'boundary-project', name: 'boundary',
  assets: [{ id: 'asset', kind: 'video', absolutePath: '/unused.mp4', durationSec: 8, width: 320, height: 180 }],
  settings: { width: 320, height: 180, fps: 30, subtitleStyle: 'bold-center' },
  transcript: { assetId: 'asset', language: 'en', segments: [{
    startSec: 0, endSec: 8, text: 'Hello um world', confidence: 1,
    words: [{ word: 'Hello', startSec: 0, endSec: 2 }, { word: 'um', startSec: 2, endSec: 3 }, { word: 'world', startSec: 3, endSec: 8 }],
  }] },
  timeline: { clips: [{ assetId: 'asset', sourceStartSec: 0, sourceEndSec: 8 }], subtitles: [], transitions: [] },
}

void test('停顿阈值两侧、无静音、相邻压缩和已有速度', () => {
  assert.deepEqual(planPauseCompressions(undefined), [])
  assert.deepEqual(planPauseCompressions([{ startSec: 1, endSec: 1.649 }]), [])
  assert.equal(planPauseCompressions([{ startSec: 1, endSec: 1.651 }]).length, 1)
  const clips = [{ assetId: 'asset', sourceStartSec: 0, sourceEndSec: 8, speed: 2 }]
  const edits = planPauseCompressions([{ startSec: 1, endSec: 3 }, { startSec: 3, endSec: 5 }])
  const output = applyPauseCompressions(clips, edits)
  assert.ok(output.length > 0)
  for (const clip of output) {
    assert.equal(clip.speed, 2)
    assert.ok(clip.sourceEndSec > clip.sourceStartSec)
    for (const edit of edits) assert.ok(clip.sourceEndSec <= edit.cutStartSec || clip.sourceStartSec >= edit.cutEndSec)
  }
  assert.deepEqual(applyPauseCompressions(clips, edits), output)
  assert.equal(clips[0]?.sourceEndSec, 8)
})

void test('固定口癖只匹配完整词，标点大小写归一，不删包含 um 的有效词', () => {
  const transcript = structuredClone(project.transcript!)
  transcript.segments[0]!.words = ['UM,', '“嗯”', 'umbrella', 'album', 'uh!'].map((word, index) => ({ word, startSec: index, endSec: index + 0.5 }))
  assert.deepEqual(findFillerWords(transcript).map((hit) => hit.word), ['UM,', '“嗯”', 'uh!'])
})

void test('真实 adapter 的剪辑转换保留 0.5x/1x/2x 与倒序，不修改事实源', async () => {
  const previous = globalThis.fetch
  const before = structuredClone(project)
  const plan = { clips: [
    { segmentIndex: 0, startSec: 6, endSec: 8, speed: 0.5 },
    { segmentIndex: 0, startSec: 0, endSec: 2, speed: 1 },
    { segmentIndex: 0, startSec: 3, endSec: 6, speed: 2 },
  ], reply: '已调整' }
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }))
  try {
    const result = await new OpenAiIntelligence({ provider: 'openai', apiKey: 'test' }).reviseTimeline(project, { text: '按计划调整' })
    assert.deepEqual(result.timeline.clips.map((clip) => clip.sourceStartSec), [6, 0, 3])
    assert.deepEqual(result.timeline.clips.map((clip) => clip.speed ?? 1), [0.5, 1, 2])
    assert.deepEqual(project, before)
  } finally { globalThis.fetch = previous }
})

void test('HTTP 401/402/403/500 和网络失败不能伪报修订成功', async () => {
  const previous = globalThis.fetch
  const ai = new OpenAiIntelligence({ provider: 'openai', apiKey: 'test' })
  try {
    for (const status of [401, 402, 403, 500]) {
      globalThis.fetch = async () => new Response('test failure', { status })
      await assert.rejects(ai.reviseTimeline(project, { text: '修改' }), new RegExp(String(status)))
    }
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    await assert.rejects(ai.reviseTimeline(project, { text: '修改' }), /fetch failed/)
  } finally { globalThis.fetch = previous }
})
