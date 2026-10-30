import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compile } from '../src/domain/compiler'
import { emptyEditDocument } from '../src/domain/document'
import { applyPlan, validatePlan, type EditPlan } from '../src/domain/edit-plan'
import { baselinePlan } from '../src/domain/baseline'
import type { ProjectRevision } from '../src/domain/project'
import type { Transcript } from '../src/domain/transcript'
import { MockPlanner } from '../src/infra/mock-planner'
import { Editor } from '../src/services/editor'
import type { ProjectStore } from '../src/ports/store'

const asset = { id: 'asset', kind: 'video' as const, absolutePath: '/unused.mp4', durationSec: 6, width: 640, height: 360 }
const settings = { width: 640, height: 360, fps: 30, subtitleStyle: 'bold-center' as const }
const transcript: Transcript = {
  assetId: 'asset',
  language: 'en',
  segments: [{
    startSec: 0,
    endSec: 6,
    text: 'Hello um world again',
    confidence: 1,
    words: [
      { word: 'Hello', startSec: 0, endSec: 1.2 },
      { word: 'um', startSec: 1.2, endSec: 1.6 },
      { word: 'world', startSec: 1.6, endSec: 3 },
      { word: 'again', startSec: 3, endSec: 6 },
    ],
  }],
}

function context() {
  return { assets: [asset], contentKind: 'speech' as const }
}

test('baselinePlan 是确定性的：静音压缩后 applyPlan 产出可编译文档', () => {
  // 用一个真实词间停顿：沉默落在词与词之间，才能既压缩停顿又不切词。
  const gapTranscript: Transcript = {
    ...transcript,
    segments: [{
      startSec: 0,
      endSec: 6,
      text: 'Hello world again',
      confidence: 1,
      words: [
        { word: 'Hello', startSec: 0, endSec: 1.2 },
        { word: 'world', startSec: 2, endSec: 4 },
        { word: 'again', startSec: 5, endSec: 6 },
      ],
    }],
  }
  const silences = [{ startSec: 1.2, endSec: 2 }]
  const first = baselinePlan(gapTranscript, silences)
  const second = baselinePlan(gapTranscript, silences)
  assert.deepEqual(first, second)
  const document = applyPlan(emptyEditDocument(), first, { ...context(), transcript: gapTranscript })
  const compiled = compile(document, { transcript: gapTranscript, silences })
  assert.ok(compiled.videoClips.length >= 2)
  assert.equal(compiled.videoClips[0]?.speed, 1)
  assert.ok(compiled.durationSec > 0)
})

test('MockPlanner draft + revise 只产生补丁，applyPlan 才改文档', async () => {
  const planner = new MockPlanner()
  const draft = await planner.propose({
    mode: 'draft', contentKind: 'speech', document: emptyEditDocument(),
    transcript, silences: [], assets: [asset], settings,
  })
  assert.equal(draft.mode, 'draft')
  const document = applyPlan(emptyEditDocument(), draft, context())
  const before = compile(document, { transcript })
  const firstClip = before.videoClips[0]!
  const revised = await planner.propose({
    mode: 'revise', contentKind: 'speech', document, compiled: before,
    transcript, silences: [], assets: [asset], settings,
    feedback: { text: '第一段 1.5 倍速' },
  })
  assert.equal(revised.mode, 'revise')
  assert.ok(revised.ops.some((op) => op.kind === 'speed'))
  const next = applyPlan(document, revised, context())
  const after = compile(next, { transcript })
  assert.equal(after.videoClips[0]?.speed, 1.5)
  assert.ok(after.durationSec < before.durationSec)
  assert.equal(after.videoClips[0]?.id, firstClip.id)
})

test('非法补丁整份拒绝：越界、切空、坏速度', () => {
  const document = applyPlan(emptyEditDocument(), baselinePlan(transcript, []), context())
  const badRange: EditPlan = {
    mode: 'revise', contentKind: 'speech', note: 'bad',
    ops: [{ kind: 'keep', assetId: 'asset', startSec: 2, endSec: 99 }],
  }
  assert.match(validatePlan(document, badRange, context())[0] ?? '', /超出素材/)
  const badSpeed: EditPlan = {
    mode: 'revise', contentKind: 'speech', note: 'bad',
    ops: [{ kind: 'keep', assetId: 'asset', startSec: 0, endSec: 1, speed: 99 }],
  }
  assert.match(validatePlan(document, badSpeed, context())[0] ?? '', /变速/)
  const empty: EditPlan = {
    mode: 'revise', contentKind: 'speech', note: 'bad',
    ops: [{ kind: 'drop', clipIds: document.tracks[0]!.clips.map((clip) => clip.id) }],
  }
  assert.match(validatePlan(document, empty, context())[0] ?? '', /变空/)
})

test('Editor 使用 planner 时新修订写 document，compile 结果与 timeline 视图一致', async () => {
  const revisions: ProjectRevision[] = []
  const store: ProjectStore = {
    async save(revision) { revisions.push(revision) },
    async latest(projectId) { return revisions.filter((revision) => revision.project.id === projectId).at(-1) },
    async get(projectId, revisionId) { return revisions.find((revision) => revision.project.id === projectId && revision.id === revisionId) },
    async list() { return revisions },
  }
  const editor = new Editor({
    store,
    prober: { async probe() { return asset } },
    transcriber: { async transcribe() { return transcript } },
    silenceAnalyzer: { async analyze() { return [] } },
    intelligence: {
      async draftTimeline() { throw new Error('planner path must not use legacy intelligence') },
      async reviseTimeline() { throw new Error('planner path must not use legacy intelligence') },
    },
    planner: new MockPlanner(),
    renderer: { async render() { throw new Error('test does not render') } },
  })
  const draft = await editor.createDraft('/unused.mp4', 'planner regression')
  assert.equal(draft.schemaVersion, 2)
  assert.ok(draft.project.document)
  assert.equal(draft.project.analysis?.contentKind, 'speech')
  const compiledDraft = compile(draft.project.document!, { transcript })
  assert.ok(compiledDraft.videoClips.length > 0)

  const revised = await editor.revise(draft.project.id, { text: '第一段 1.5 倍速' })
  assert.equal(revised.parentRevisionId, draft.id)
  assert.ok(revised.project.document)
  const compiled = compile(revised.project.document!, { transcript })
  assert.equal(compiled.videoClips[0]?.speed, 1.5)
  assert.equal(compiled.durationSec, revised.project.timeline.clips.reduce((sum, clip) => sum + (clip.sourceEndSec - clip.sourceStartSec) / (clip.speed ?? 1), 0))
})

test('baseline 按素材时长夹紧转写溢出的时间戳', () => {
  const plan = baselinePlan(transcript, [], 'speech', 5.145)
  assert.ok(plan.ops.length > 0)
  for (const op of plan.ops) {
    if (op.kind === 'keep') assert.ok(op.endSec <= 5.145 + 1e-9)
  }
  const document = applyPlan(emptyEditDocument(), plan, { assets: [{ ...asset, durationSec: 5.145 }], contentKind: 'speech' })
  assert.ok(compile(document, { transcript }).durationSec > 0)
})

test('keep/trim 切在词内部时吸附到词边界，留 30ms 余量', () => {
  const ctx = { assets: [asset], contentKind: 'speech' as const, transcript }
  const plan: EditPlan = {
    mode: 'draft', contentKind: 'speech', note: 'snap',
    ops: [{ kind: 'keep', assetId: 'asset', startSec: 1.5, endSec: 2.5 }],
  }
  const document = applyPlan(emptyEditDocument(), plan, ctx)
  const clip = document.tracks[0]!.clips[0]!
  assert.ok(clip.sourceStartSec <= 1.2 + 1e-9) // 「um」1.2–1.6，入点 1.5 在词内 → 扩到 1.17
  assert.ok(clip.sourceEndSec >= 3 - 1e-9) // 「world」1.6–3，出点 2.5 在词内 → 扩到 3.03
  const trimmed = applyPlan(document, {
    mode: 'revise', contentKind: 'speech', note: 'trim snap',
    ops: [{ kind: 'trim', clipId: clip.id, edge: 'in', amountSec: 0.2 }],
  }, ctx)
  const next = trimmed.tracks[0]!.clips[0]!
  assert.ok(next.sourceStartSec <= 1.2 + 1e-9)
})


test('修订期 keep 不能重复覆盖已有片段', () => {
  const document = applyPlan(emptyEditDocument(), baselinePlan(transcript, []), context())
  const duplicate: EditPlan = {
    mode: 'revise', contentKind: 'speech', note: 'duplicate',
    ops: [{ kind: 'keep', assetId: 'asset', startSec: 0, endSec: 4 }],
  }
  assert.match(validatePlan(document, duplicate, context())[0] ?? '', /重叠/)
})
