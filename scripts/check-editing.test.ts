import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenAiIntelligence } from '../src/infra/openai-intelligence'
import { buildAss, toAssTime } from '../src/infra/subtitles-ass'
import { subtitleAtTime, subtitlesForClips } from '../src/domain/subtitles'
import { timelineDurationSec, type TimelineClip } from '../src/domain/timeline'
import type { Transcript } from '../src/domain/transcript'
import type { Project } from '../src/domain/project'
import { MockIntelligence } from '../src/infra/mock-intelligence'

const transcript: Transcript = {
  assetId: 'asset', language: 'en', segments: [{
    startSec: 0, endSec: 5, text: 'Hello um world again', confidence: 1,
    words: [
      { word: 'Hello', startSec: 0, endSec: 1 },
      { word: 'um', startSec: 1, endSec: 2 },
      { word: 'world', startSec: 2, endSec: 3 },
      { word: 'again', startSec: 3, endSec: 5 },
    ],
  }],
}
const settings: Project['settings'] = { width: 640, height: 360, fps: 30, subtitleStyle: 'bold-center' }
const clip = (start: number, end: number, speed = 1): TimelineClip => ({
  assetId: 'asset', sourceStartSec: start, sourceEndSec: end, speed,
})
function project(clips: TimelineClip[] = [clip(0, 5)]): Project {
  return {
    id: 'project', name: 'regression',
    assets: [{ id: 'asset', kind: 'video', absolutePath: '/unused.mp4', durationSec: 5, width: 640, height: 360 }],
    transcript, settings,
    timeline: { clips, subtitles: subtitlesForClips(transcript, clips), transitions: [] },
  }
}
const intelligence = () => new OpenAiIntelligence({
  provider: 'openai', apiKey: 'test-only', model: 'test-only', baseUrl: 'https://openrouter.ai/api/v1',
})

// 只替代外部付费/限流边界；转换、字幕映射、序列化均运行实际实现。
async function withResponses(
  responses: Array<{ status?: number; plan?: unknown; content?: string; error?: string }>,
  run: (requests: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const previous = globalThis.fetch
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = async (_input, init) => {
    assert.equal(typeof init?.body, 'string')
    requests.push(JSON.parse(String(init?.body)))
    const response = responses[requests.length - 1]
    assert.ok(response, 'unexpected extra API request')
    return new Response(response.error ?? JSON.stringify({
      choices: [{ message: { content: response.content ?? JSON.stringify(response.plan) } }],
    }), { status: response.status ?? 200 })
  }
  try { await run(requests) } finally { globalThis.fetch = previous }
}

void test('删除句中口癖后，两边保留内容都有字幕，重复播放不产生重叠字幕', () => {
  const clips = [clip(0, 1), clip(2, 5), clip(0, 1)]
  const cues = subtitlesForClips(transcript, clips)
  assert.deepEqual(cues.map((cue) => cue.text), ['Hello', 'world again'])
  assert.equal(subtitleAtTime(cues, 0.5), 'Hello')
  assert.equal(subtitleAtTime(cues, 1.5), '')
  assert.equal(subtitleAtTime(cues, 2.5), 'world again')
  assert.equal(subtitleAtTime(cues, 5), '')
  const foreign = subtitlesForClips(transcript, [{ ...clip(0, 5), assetId: 'other' }])
  assert.deepEqual(foreign, [])
})

void test('中文字幕按词保留且不插入汉字间空格', () => {
  const zh: Transcript = { ...transcript, language: 'zh', segments: [{
    startSec: 0, endSec: 3, text: '今天嗯继续', confidence: 1,
    words: [
      { word: '今天', startSec: 0, endSec: 1 },
      { word: '嗯', startSec: 1, endSec: 2 },
      { word: '继续', startSec: 2, endSec: 3 },
    ],
  }] }
  assert.deepEqual(subtitlesForClips(zh, [clip(0, 1), clip(2, 3)]).map((cue) => cue.text), ['今天', '继续'])
})

void test('重排、重复、变速后的 ASS 时间对应输出，花括号不能注入样式', () => {
  const p = project([clip(2, 5, 2), clip(0, 1), clip(0, 1)])
  p.timeline.transitions = [{ type: 'crossfade', durationSec: 0.2 }, { type: 'cut' }]
  const ass = buildAss(p)
  assert.ok(ass.includes('0:00:00.00,0:00:01.50,Default,,0,0,0,,world again'))
  assert.ok(ass.includes('0:00:01.30,0:00:02.30,Default,,0,0,0,,Hello'))
  assert.ok(ass.includes('0:00:02.30,0:00:03.30,Default,,0,0,0,,Hello'))
  assert.equal(timelineDurationSec(p.timeline), 3.3)
  p.timeline.subtitles = [{ startSec: 0, endSec: 1, text: '{\\pos(0,0)}hello\nworld' }]
  const escaped = buildAss(p)
  assert.ok(!escaped.includes('{\\pos'))
  assert.ok(escaped.includes('｛＼pos(0,0)｝hello\\Nworld'))
  assert.equal(toAssTime(59.999), '0:01:00.00')
  assert.equal(toAssTime(3599.999), '1:00:00.00')
})

void test('mock 修订裁边后保留源坐标字幕，2 倍速可恢复 1 倍速', async () => {
  const ai = new MockIntelligence()
  const p = project()
  const trimmed = await ai.reviseTimeline(p, { text: '开头太拖' })
  assert.ok(trimmed.timeline.subtitles.length > 0)
  assert.ok(trimmed.timeline.subtitles.every((cue) => cue.startSec >= trimmed.timeline.clips[0]!.sourceStartSec))
  const fast = await ai.reviseTimeline(p, { text: '第一段 2 倍速' })
  const normal = await ai.reviseTimeline({ ...p, timeline: fast.timeline }, { text: '第一段 1 倍速' })
  assert.equal(normal.timeline.clips[0]?.speed, 1)
})

void test('真实 adapter 连续修订保留 BGM，并向模型提供现有速度、转场和词时间', async () => {
  const p = project([clip(0, 1, 1.5), clip(2, 5)])
  p.timeline.bgm = { path: '/music.mp3', gainDb: -24 }
  p.timeline.transitions = [{ type: 'crossfade', durationSec: 0.3 }]
  const plan = { clips: [
    { segmentIndex: 0, startSec: 0, endSec: 1, speed: 1.5 },
    { segmentIndex: 0, startSec: 2, endSec: 5 },
  ], transitions: ['crossfade'], reply: '已去掉口癖' }
  await withResponses([{ plan }], async (requests) => {
    const result = await intelligence().reviseTimeline(p, { text: '去掉口癖，其余不变' })
    assert.deepEqual(result.timeline.bgm, p.timeline.bgm)
    assert.deepEqual(result.timeline.subtitles.map((cue) => cue.text), ['Hello', 'world again'])
    const body = JSON.stringify(requests[0])
    assert.ok(body.includes('1.5倍速'))
    assert.ok(body.includes('随后叠化'))
    assert.ok(body.includes('词级时间'))
    assert.deepEqual(requests[0]?.provider, { require_parameters: true })
  })
})

void test('不支持结构化输出时重试；围栏 JSON 仍经本地校验', async () => {
  const plan = { clips: [{ segmentIndex: 0, startSec: 0, endSec: 5 }], reply: '保持原文' }
  await withResponses([
    { status: 404, error: 'No endpoints found supporting response_format' },
    { content: `以下是结果：\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` },
  ], async (requests) => {
    const result = await intelligence().reviseTimeline(project(), { text: '保持原文' })
    assert.equal(result.timeline.clips.length, 1)
    assert.equal(requests[1]?.response_format, undefined)
    assert.equal(requests[1]?.provider, undefined)
  })
})

void test('空时间线被拒绝，不能静默恢复原片', async () => {
  await withResponses([{ plan: { clips: [], reply: '全部删除' } }], async () => {
    await assert.rejects(intelligence().reviseTimeline(project(), { text: '全部删除' }), /变空/)
  })
})

void test('不存在的段、越界、超范围速度、错转场数量和缺少回复都不能通过', async () => {
  const cases = [
    { clips: [{ segmentIndex: 99, startSec: 0, endSec: 1 }], reply: '无效' },
    { clips: [{ segmentIndex: 0, startSec: 0, endSec: 6 }], reply: '无效' },
    { clips: [{ segmentIndex: 0, startSec: 0, endSec: 1, speed: 4 }], reply: '无效' },
    { clips: [{ segmentIndex: 0, startSec: 0, endSec: 1 }], transitions: ['crossfade'], reply: '无效' },
    { clips: [{ segmentIndex: 0, startSec: 0, endSec: 1 }] },
  ]
  for (const plan of cases) {
    await withResponses([{ plan }, { plan }, { plan }], async (requests) => {
      await assert.rejects(intelligence().reviseTimeline(project(), { text: '修改' }), /无效结果/)
      assert.equal(requests.length, 3)
    })
  }
})

void test('部分重播和相邻片段分别显示各自保留的词', () => {
  const cues = subtitlesForClips(transcript, [clip(0, 5), clip(0, 1)])
  assert.equal(subtitleAtTime(cues, 0.5), 'Hello')
  assert.equal(subtitleAtTime(cues, 2.5), 'um world again')
  const adjacent = subtitlesForClips(transcript, [clip(0, 1), clip(1, 5)])
  assert.deepEqual(adjacent.map((cue) => cue.text), ['Hello', 'um world again'])
})

void test('模型按两位小数返回边界时容忍舍入误差并钳回原始区间', async () => {
  const p = project()
  p.transcript = { ...transcript, segments: [{ ...transcript.segments[0]!, startSec: 0.004, endSec: 4.996 }] }
  await withResponses([{ plan: {
    clips: [{ segmentIndex: 0, startSec: 0, endSec: 5 }], reply: '保留',
  } }], async () => {
    const result = await intelligence().reviseTimeline(p, { text: '保留' })
    assert.equal(result.timeline.clips[0]?.sourceStartSec, 0.004)
    assert.equal(result.timeline.clips[0]?.sourceEndSec, 4.996)
  })
})

void test('初稿模型返回空计划时确定性建稿，修订空计划仍拒绝', async () => {
  await withResponses([{ plan: { clips: [], reply: '全部删除' } }], async () => {
    const draft = await intelligence().draftTimeline(transcript, settings)
    assert.ok(draft.timeline.clips.length > 0)
    assert.ok(draft.note?.includes('预剪'))
  })
})

void test('短片段叠化按片段长度限制，避免负时长', async () => {
  const plan = { clips: [
    { segmentIndex: 0, startSec: 0, endSec: 0.2, speed: 2 },
    { segmentIndex: 0, startSec: 2, endSec: 2.2, speed: 2 },
  ], transitions: ['crossfade'], reply: '叠化' }
  await withResponses([{ plan }], async () => {
    const result = await intelligence().reviseTimeline(project(), { text: '叠化' })
    assert.deepEqual(result.timeline.transitions, [{ type: 'crossfade', durationSec: 0.05 }])
    assert.ok(timelineDurationSec(result.timeline) > 0)
  })
})
