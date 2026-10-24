import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PreviewService } from '../src/services/preview'
import type { Renderer } from '../src/ports/renderer'
import type { ProjectRevision } from '../src/domain/project'

function revision(id = 'revision'): ProjectRevision {
  return { id, createdAt: '2026-10-24T00:00:00Z', project: {
    id: 'project', name: 'preview', assets: [],
    settings: { width: 640, height: 360, fps: 30, subtitleStyle: 'bold-center' },
    timeline: { clips: [{ assetId: 'asset', sourceStartSec: 0, sourceEndSec: 2 }], subtitles: [], transitions: [] },
  } }
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.resolve(__dirname, '..', '.preview-check-'))
  try { await run(root) } finally { await rm(root, { force: true, recursive: true }) }
}

void test('同版本并发预览共享编码，完成后跨实例复用缓存', async () => withRoot(async (root) => {
  let calls = 0
  const renderer: Renderer = { async render(_project, outputPath) {
    calls++
    await writeFile(outputPath, 'rendered')
    return { outputPath, durationSec: 2 }
  } }
  const service = new PreviewService(renderer, root)
  const [a, b] = await Promise.all([service.render(revision()), service.render(revision())])
  assert.deepEqual(a, b)
  assert.equal(calls, 1)
  assert.equal(await readFile(a.outputPath, 'utf8'), 'rendered')
  assert.deepEqual(await new PreviewService(renderer, root).render(revision()), a)
  assert.equal(calls, 1)
}))

void test('新修订单独渲染，多个预览串行且使用调用时的项目快照', async () => withRoot(async (root) => {
  let active = 0
  let maxActive = 0
  const renderer: Renderer = { async render(project, outputPath) {
    active++
    maxActive = Math.max(active, maxActive)
    await writeFile(outputPath, project.name)
    active--
    return { outputPath, durationSec: 2 }
  } }
  const service = new PreviewService(renderer, root)
  const source = revision()
  const first = service.render(source)
  source.project.name = 'changed after request'
  const second = service.render(revision('next'))
  const [a, b] = await Promise.all([first, second])
  assert.notEqual(a.outputPath, b.outputPath)
  assert.equal(await readFile(a.outputPath, 'utf8'), 'preview')
  assert.equal(maxActive, 1)
}))

void test('编码失败清理半成品且可重试，不阻塞后续预览', async () => withRoot(async (root) => {
  let calls = 0
  const renderer: Renderer = { async render(_project, outputPath) {
    calls++
    await writeFile(outputPath, 'partial')
    if (calls === 1) throw new Error('encoder failed')
    return { outputPath, durationSec: 2 }
  } }
  const service = new PreviewService(renderer, root)
  await assert.rejects(service.render(revision()), /encoder failed/)
  assert.deepEqual(await readdir(root), [])
  const result = await service.render(revision())
  assert.equal(result.revisionId, 'revision')
  assert.equal(calls, 2)
  assert.equal((await readdir(root)).length, 1)
}))
