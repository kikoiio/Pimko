import assert from 'node:assert/strict'
import { test } from 'node:test'
import { baselinePlan } from '../src/domain/baseline'
import { compile } from '../src/domain/compiler'
import { emptyEditDocument } from '../src/domain/document'
import { applyPlan, type PlanContext } from '../src/domain/edit-plan'
import type { ProjectRevision } from '../src/domain/project'
import type { Transcript } from '../src/domain/transcript'
import { createPlanner } from '../src/infra/ai-factory'
import type { LlmConfig } from '../src/infra/llm-config'
import { MockPlanner } from '../src/infra/mock-planner'
import { OpenAiPlanner } from '../src/infra/openai-planner'
import type { PlannerInput } from '../src/ports/planner'
import type { ProjectStore } from '../src/ports/store'
import { Editor } from '../src/services/editor'

const asset = {
  id: 'asset',
  kind: 'video' as const,
  absolutePath: '/unused.mp4',
  durationSec: 7,
  width: 640,
  height: 360,
}
const settings = { width: 640, height: 360, fps: 30, subtitleStyle: 'bold-center' as const }
const transcript: Transcript = {
  assetId: 'asset',
  language: 'zh',
  segments: [
    {
      startSec: 0,
      endSec: 3,
      text: '大家好 今天聊剪辑',
      confidence: 1,
      words: [
        { word: '大家好', startSec: 0, endSec: 1 },
        { word: '今天', startSec: 1, endSec: 1.8 },
        { word: '聊剪辑', startSec: 1.8, endSec: 3 },
      ],
    },
    {
      startSec: 3.5,
      endSec: 7,
      text: '我们先看开头',
      confidence: 1,
      words: [
        { word: '我们', startSec: 3.5, endSec: 4.2 },
        { word: '先看', startSec: 4.2, endSec: 5.3 },
        { word: '开头', startSec: 5.3, endSec: 7 },
      ],
    },
  ],
}
const context: PlanContext = { assets: [asset], contentKind: 'speech' }
const config: LlmConfig = {
  provider: 'openai',
  apiKey: 'test-only',
  model: 'test-model',
  baseUrl: 'https://openrouter.ai/api/v1',
}

function draftInput(): PlannerInput {
  return {
    mode: 'draft',
    contentKind: 'speech',
    document: emptyEditDocument(),
    transcript,
    silences: [],
    assets: [asset],
    settings,
  }
}

function reviseInput(): PlannerInput {
  const document = applyPlan(emptyEditDocument(), baselinePlan(transcript, []), context)
  return {
    mode: 'revise',
    contentKind: 'speech',
    document,
    compiled: compile(document, { transcript }),
    transcript,
    silences: [],
    assets: [asset],
    settings,
    feedback: { text: '第二段 1.5 倍速' },
  }
}

interface FakeResponse {
  status?: number
  /** 直接作为 assistant content 返回（用于非法 JSON/围栏）。 */
  content?: string
  /** 作为 assistant content 的 JSON。 */
  plan?: unknown
  /** HTTP 错误响应体。 */
  error?: string
  /** 原生响应 JSON（Responses API 等非 chat/completions 形状）。 */
  body?: unknown
  headers?: Record<string, string>
}

// 只替代外部付费/限流边界；计划解析、校验、应用、编译都运行真实实现。
async function withFetch(
  responses: FakeResponse[],
  run: (requests: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const previous = globalThis.fetch
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = async (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
    requests.push(JSON.parse(init.body))
    const response = responses[requests.length - 1]
    assert.ok(response, 'unexpected extra API request')
    const content = response.content !== undefined ? response.content : JSON.stringify(response.plan)
    const body = response.error ?? (response.body !== undefined
      ? JSON.stringify(response.body)
      : JSON.stringify({ choices: [{ message: { content } }] }))
    return new Response(body, {
      status: response.status ?? 200,
      ...(response.headers ? { headers: response.headers } : {}),
    })
  }
  try {
    await run(requests)
  } finally {
    globalThis.fetch = previous
  }
}

void test('OpenAiPlanner draft：模型 ops 追加到确定性初剪并应用到文档', async () => {
  const patch = {
    ops: [
      { kind: 'speed', clipIds: ['clip-2'], speed: 1.5, reason: '第二段略拖' },
      { kind: 'setSubtitle', appearance: { position: 'top' }, reason: '字幕上移' },
    ],
    note: '第二段 1.5 倍速，字幕移到顶部。',
  }
  await withFetch([{ plan: patch }], async (requests) => {
    const plan = await new OpenAiPlanner(config).propose(draftInput())
    assert.equal(plan.mode, 'draft')
    // baseline 的两段 keep + 模型的两个补丁
    assert.equal(plan.ops.length, 4)
    assert.ok(plan.note.includes(patch.note))
    assert.ok(plan.note.includes('确定性'))
    const document = applyPlan(emptyEditDocument(), plan, context)
    const compiled = compile(document, { transcript })
    assert.equal(compiled.videoClips.length, 2)
    assert.equal(compiled.videoClips[0]?.speed, 1)
    assert.equal(compiled.videoClips[1]?.speed, 1.5)
    assert.equal(document.subtitle.appearance.position, 'top')
    assert.equal(requests.length, 1)
    const body = JSON.stringify(requests[0])
    assert.ok(body.includes('词级'))
    assert.ok(body.includes('clip-2'))
    assert.ok(body.includes('只能引用'))
    assert.deepEqual(requests[0]?.response_format, { type: 'json_object' })
    assert.deepEqual(requests[0]?.provider, { require_parameters: true })
  })
})

void test('模型非法 JSON：draft 回退 baseline 并标注原因，revise 抛错保留旧版', async () => {
  const planner = new OpenAiPlanner(config)
  const baseline = baselinePlan(transcript, [])
  await withFetch(
    Array.from({ length: 3 }, () => ({ content: '这不是 JSON' })),
    async (requests) => {
      const plan = await planner.propose(draftInput())
      assert.deepEqual(plan.ops, baseline.ops)
      assert.match(plan.note, /模型语义补丁未生效/)
      assert.match(plan.note, /回退确定性草稿/)
      assert.equal(requests.length, 3)
    },
  )

  const input = reviseInput()
  const before = compile(input.document, { transcript })
  await withFetch(
    Array.from({ length: 3 }, () => ({ content: '还是不是 JSON' })),
    async (requests) => {
      await assert.rejects(planner.propose(input), /模型修订未生效，已保留上一版/)
      assert.equal(requests.length, 3)
    },
  )
  const after = compile(input.document, { transcript })
  assert.deepEqual(
    after.videoClips.map((clip) => [clip.id, clip.sourceStartSec, clip.sourceEndSec, clip.speed]),
    before.videoClips.map((clip) => [clip.id, clip.sourceStartSec, clip.sourceEndSec, clip.speed]),
  )
})

void test('模型引用未知 clipId：draft 回退初剪，revise 整份拒绝', async () => {
  const patch = { ops: [{ kind: 'drop', clipIds: ['clip-99'], reason: '删掉' }], note: '删掉' }
  await withFetch([{ plan: patch }], async () => {
    const plan = await new OpenAiPlanner(config).propose(draftInput())
    assert.match(plan.note, /模型语义补丁未生效/)
    assert.match(plan.note, /找不到片段 clip-99/)
    assert.deepEqual(plan.ops, baselinePlan(transcript, []).ops)
  })
  await withFetch([{ plan: patch }], async () => {
    await assert.rejects(
      new OpenAiPlanner(config).propose(reviseInput()),
      /已保留上一版.*找不到片段 clip-99/,
    )
  })
})

void test('revise 空 ops 可接受；清空全部片段的 ops 被拒绝', async () => {
  await withFetch([{ plan: { ops: [], note: '没有需要改的' } }], async () => {
    const plan = await new OpenAiPlanner(config).propose(reviseInput())
    assert.equal(plan.mode, 'revise')
    assert.equal(plan.ops.length, 0)
    assert.equal(plan.note, '没有需要改的')
  })
  const dropAll = {
    ops: [{ kind: 'drop', clipIds: ['clip-1', 'clip-2'], reason: '清空' }],
    note: '全部删除',
  }
  await withFetch([{ plan: dropAll }], async () => {
    await assert.rejects(new OpenAiPlanner(config).propose(reviseInput()), /变空.*已保留上一版/)
  })
})

void test('429 限流按 Retry-After 重试，最多两次；超过仍失败', async () => {
  const waits: number[] = []
  const planner = new OpenAiPlanner(config, {
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
  await withFetch(
    [
      { status: 429, error: 'rate limited', headers: { 'retry-after': '0.5' } },
      { status: 429, error: 'rate limited', headers: { 'retry-after': '0.5' } },
      { plan: { ops: [], note: '无需改动' } },
    ],
    async (requests) => {
      const plan = await planner.propose(reviseInput())
      assert.equal(plan.ops.length, 0)
      assert.equal(requests.length, 3)
      assert.deepEqual(waits, [500, 500])
    },
  )

  await withFetch(
    Array.from({ length: 3 }, () => ({ status: 429, error: 'rate limited' })),
    async (requests) => {
      await assert.rejects(
        new OpenAiPlanner(config, { sleep: async () => {} }).propose(reviseInput()),
        /429/,
      )
      assert.equal(requests.length, 3)
    },
  )
})

void test('422 结构化输出不兼容时降级重试并移除 response_format/provider', async () => {
  await withFetch(
    [
      { status: 422, error: 'response_format is not supported by this endpoint' },
      { plan: { ops: [], note: '保持原文' } },
    ],
    async (requests) => {
      const plan = await new OpenAiPlanner(config).propose(reviseInput())
      assert.equal(plan.ops.length, 0)
      assert.equal(requests.length, 2)
      assert.deepEqual(requests[0]?.response_format, { type: 'json_object' })
      assert.deepEqual(requests[0]?.provider, { require_parameters: true })
      assert.equal(requests[1]?.response_format, undefined)
      assert.equal(requests[1]?.provider, undefined)
    },
  )

  // 非 OpenRouter 的 OpenAI 兼容端点也可能用 422 表示不支持 response_format。
  const openaiConfig: LlmConfig = { provider: 'openai', apiKey: 'test-only', model: 'test-model' }
  await withFetch(
    [
      { status: 422, error: 'Unprocessable Entity' },
      { plan: { ops: [], note: '保持原文' } },
    ],
    async (requests) => {
      const plan = await new OpenAiPlanner(openaiConfig).propose(reviseInput())
      assert.equal(plan.ops.length, 0)
      assert.equal(requests.length, 2)
      assert.deepEqual(requests[0]?.response_format, { type: 'json_object' })
      assert.equal(requests[0]?.provider, undefined)
      assert.equal(requests[1]?.response_format, undefined)
    },
  )
})

void test('Editor.revise 模型失败时不写入新修订，旧文档保留', async () => {
  const revisions: ProjectRevision[] = []
  const store: ProjectStore = {
    async save(revision) {
      revisions.push(revision)
    },
    async latest(projectId) {
      return revisions.filter((revision) => revision.project.id === projectId).at(-1)
    },
    async get(projectId, revisionId) {
      return revisions.find(
        (revision) => revision.project.id === projectId && revision.id === revisionId,
      )
    },
    async list() {
      return revisions
    },
  }
  const editor = new Editor({
    store,
    prober: {
      async probe() {
        return asset
      },
    },
    transcriber: {
      async transcribe() {
        return transcript
      },
    },
    silenceAnalyzer: {
      async analyze() {
        return []
      },
    },
    intelligence: {
      async draftTimeline() {
        throw new Error('planner path must not use legacy intelligence')
      },
      async reviseTimeline() {
        throw new Error('planner path must not use legacy intelligence')
      },
    },
    planner: new OpenAiPlanner(config),
    renderer: {
      async render() {
        throw new Error('test does not render')
      },
    },
  })

  await withFetch([{ plan: { ops: [], note: '确定性初剪' } }], async () => {
    const draft = await editor.createDraft('/unused.mp4', 'real planner regression')
    assert.equal(revisions.length, 1)
    await withFetch(
      Array.from({ length: 3 }, () => ({ content: 'broken' })),
      async () => {
        await assert.rejects(editor.revise(draft.project.id, { text: '改一下' }), /已保留上一版/)
      },
    )
  })
  assert.equal(revisions.length, 1)
  assert.equal(compile(revisions[0]!.project.document!, { transcript }).videoClips.length, 2)
})

void test('createPlanner：mock 保持 MockPlanner，openai 使用 OpenAiPlanner', () => {
  assert.ok(createPlanner({ provider: 'mock' }) instanceof MockPlanner)
  assert.ok(createPlanner(config) instanceof OpenAiPlanner)
})


void test('400 json_validate_failed 时移除 response_format 重试一次', async () => {
  const openaiConfig: LlmConfig = { provider: 'openai', apiKey: 'test-only', model: 'test-model' }
  await withFetch(
    [
      { status: 400, error: '{"error":{"code":"json_validate_failed","message":"Failed to generate JSON"}}' },
      { plan: { ops: [], note: '保持原文' } },
    ],
    async (requests) => {
      const plan = await new OpenAiPlanner(openaiConfig).propose(reviseInput())
      assert.equal(plan.ops.length, 0)
      assert.equal(requests.length, 2)
      assert.deepEqual(requests[0]?.response_format, { type: 'json_object' })
      assert.equal(requests[1]?.response_format, undefined)
      assert.equal(requests[1]?.provider, undefined)
    },
  )
})


void test('Responses API 端点（讯飞 MaaS 等）使用 input 并解析 output_text', async () => {
  const responseConfig: LlmConfig = {
    provider: 'openai',
    apiKey: 'test-only',
    model: 'spark-x2.6',
    baseUrl: 'https://maas-api.cn-huabei-1.xf-yun.com/v1/responses',
  }
  const patch = { ops: [], note: 'Responses API 正常' }
  await withFetch(
    [{ body: { output: [{ content: [{ type: 'output_text', text: JSON.stringify(patch) }] }] } }],
    async (requests) => {
      const plan = await new OpenAiPlanner(responseConfig).propose(reviseInput())
      assert.equal(plan.note, patch.note)
      assert.equal(requests.length, 1)
      assert.ok(Array.isArray(requests[0]?.input))
      assert.equal(requests[0]?.messages, undefined)
      assert.equal(requests[0]?.response_format, undefined)
      assert.equal(requests[0]?.model, 'spark-x2.6')
    },
  )
})


void test('网络瞬断重试后成功', async () => {
  const waits: number[] = []
  const previous = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls <= 2) throw new TypeError('fetch failed')
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ops: [], note: '恢复' }) } }] }), { status: 200 })
  }
  try {
    const plan = await new OpenAiPlanner(config, {
      sleep: async (ms) => { waits.push(ms) },
    }).propose(reviseInput())
    assert.equal(plan.note, '恢复')
    assert.equal(calls, 3)
    assert.deepEqual(waits, [5000, 10000])
  } finally {
    globalThis.fetch = previous
  }
})

void test('鉴权失败的错误带 provider/model/baseUrl，且不回显 key', async () => {
  await withFetch([{ status: 401, error: 'invalid api key' }], async () => {
    await assert.rejects(
      new OpenAiPlanner(config).propose(reviseInput()),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /鉴权失败/)
        assert.match(error.message, /test-model/)
        assert.match(error.message, /openrouter\.ai/)
        assert.ok(!error.message.includes('test-only'))
        return true
      },
    )
  })
})
