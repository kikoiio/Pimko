import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import type { ProjectRevision } from '../src/domain/project'
import { FsProjectStore } from '../src/infra/fs-store'
import { Editor } from '../src/services/editor'

function makeEditor(store: FsProjectStore): Editor {
  return new Editor({
    store,
    prober: { async probe() { throw new Error('Undo must not probe media') } },
    transcriber: { async transcribe() { throw new Error('Undo must not transcribe') } },
    intelligence: {
      async draftTimeline() { throw new Error('Undo must not draft') },
      async reviseTimeline(project, feedback) {
        return {
          timeline: { ...project.timeline, subtitles: [{ startSec: 0, endSec: 1, text: feedback.text }] },
        }
      },
    },
    renderer: { async render() { throw new Error('Undo must not render') } },
  })
}

function firstRevision(): ProjectRevision {
  return {
    id: 'A',
    project: {
      id: 'undo-project',
      name: 'Undo regression',
      assets: [{ id: 'asset', kind: 'video', absolutePath: '/unused.mp4', durationSec: 10, width: 1280, height: 720 }],
      settings: { width: 1280, height: 720, fps: 30, subtitleStyle: 'bold-center' },
      timeline: {
        clips: [{ assetId: 'asset', sourceStartSec: 0, sourceEndSec: 10 }],
        subtitles: [],
        transitions: [],
      },
    },
    createdAt: '2020-01-01T00:00:00.000Z',
  }
}

async function withStore(check: (store: FsProjectStore, root: string) => Promise<void>): Promise<void> {
  // Keep even the tiny JSON fixtures off the machine's quota-limited /tmp.
  const root = await mkdtemp(path.resolve(__dirname, '..', '.undo-check-'))
  try {
    await check(new FsProjectStore(root), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function seedHistory(store: FsProjectStore): Promise<[ProjectRevision, ProjectRevision, ProjectRevision]> {
  const a = firstRevision()
  const b: ProjectRevision = {
    ...a,
    id: 'B',
    project: { ...a.project, timeline: { ...a.project.timeline, bgm: { path: '/music.mp3', gainDb: -18 } } },
    parentRevisionId: a.id,
    feedback: { text: '添加配乐' },
    createdAt: '2020-01-01T00:00:01.000Z',
  }
  const c: ProjectRevision = {
    ...b,
    id: 'C',
    project: { ...b.project, timeline: { ...b.project.timeline, bgm: { path: '/music.mp3', gainDb: -6 } } },
    parentRevisionId: b.id,
    feedback: { text: '调大音量' },
    createdAt: '2020-01-01T00:00:02.000Z',
  }
  for (const revision of [a, b, c]) await store.save(revision)
  return [a, b, c]
}

test('A → B → C undoes twice to A and retains every revision', async () => {
  await withStore(async (store) => {
    const [a, b, c] = await seedHistory(store)
    const editor = makeEditor(store)
    const firstUndo = await editor.undo(a.project.id)
    assert.deepEqual(firstUndo.project.timeline, b.project.timeline)
    assert.equal(firstUndo.parentRevisionId, c.id)
    const secondUndo = await editor.undo(a.project.id)
    assert.deepEqual(secondUndo.project.timeline, a.project.timeline)
    assert.equal(secondUndo.parentRevisionId, firstUndo.id)
    await assert.rejects(editor.undo(a.project.id), /已经是第一版/)
    assert.equal((await store.list()).length, 5)
    for (const original of [a, b, c]) assert.deepEqual(await store.get(a.project.id, original.id), original)
  })
})

test('undo refuses an initial revision without appending history', async () => {
  await withStore(async (store) => {
    const a = firstRevision()
    await store.save(a)
    await assert.rejects(makeEditor(store).undo(a.project.id), /已经是第一版/)
    assert.equal((await store.list()).length, 1)
  })
})

test('undo then ordinary edits then undo restores the edited branch', async () => {
  await withStore(async (store) => {
    const [a, b] = await seedHistory(store)
    const editor = makeEditor(store)
    const restoredB = await editor.undo(a.project.id)
    const edit = await editor.revise(a.project.id, { text: 'new branch' })
    assert.equal(edit.parentRevisionId, restoredB.id)
    assert.equal(edit.project.timeline.subtitles[0]?.text, 'new branch')
    assert.deepEqual((await editor.undo(a.project.id)).project.timeline, b.project.timeline)
    assert.deepEqual((await editor.undo(a.project.id)).project.timeline, a.project.timeline)

    for (const apply of [
      () => editor.setBgm(a.project.id, '/new-music.mp3'),
      () => editor.setBgmVolume(a.project.id, -12),
      () => editor.removeBgm(a.project.id),
    ]) {
      // Start each branch from B, then verify both the edit's undo and the next undo.
      const reset = await editor.setBgm(a.project.id, '/music.mp3', -18)
      await apply()
      assert.deepEqual((await editor.undo(a.project.id)).project.timeline, reset.project.timeline)
      assert.deepEqual((await editor.undo(a.project.id)).project.timeline, a.project.timeline)
    }
  })
})

test('undo cursor survives filesystem persistence and a new Editor instance', async () => {
  await withStore(async (store, root) => {
    const [a, b] = await seedHistory(store)
    const firstUndo = await makeEditor(store).undo(a.project.id)
    const reopened = makeEditor(new FsProjectStore(root))
    const restored = await reopened.restore(a.project.id)
    assert.equal(restored?.id, firstUndo.id)
    assert.deepEqual(restored?.project.timeline, b.project.timeline)
    assert.deepEqual((await reopened.undo(a.project.id)).project.timeline, a.project.timeline)
    await assert.rejects(makeEditor(new FsProjectStore(root)).undo(a.project.id), /已经是第一版/)
  })
})

test('settings migration preserves the undo cursor and corrected dimensions', async () => {
  await withStore(async (store, root) => {
    const [a, b] = await seedHistory(store)
    const undo = await makeEditor(store).undo(a.project.id)
    // Simulate a saved project from before source-sized export settings.
    const legacy: ProjectRevision = {
      ...undo,
      id: 'legacy-settings',
      project: { ...undo.project, settings: { ...undo.project.settings, width: 1080, height: 1920 } },
      createdAt: '2099-01-01T00:00:00.000Z',
    }
    await store.save(legacy)
    const editor = makeEditor(new FsProjectStore(root))
    const repaired = await editor.restore(a.project.id)
    assert.deepEqual(repaired?.project.timeline, b.project.timeline)
    assert.equal(repaired?.project.settings.width, 1280)
    assert.equal(repaired?.project.settings.height, 720)
    assert.equal((await editor.restore(a.project.id))?.id, repaired?.id)
    const undone = await editor.undo(a.project.id)
    assert.deepEqual(undone.project.timeline, a.project.timeline)
    assert.equal(undone.project.settings.width, 1280)
    assert.equal(undone.project.settings.height, 720)
    await assert.rejects(editor.undo(a.project.id), /已经是第一版/)
  })
})

test('restoring a first-version project with old settings does not create an undo step', async () => {
  await withStore(async (store) => {
    const a = firstRevision()
    a.project.settings.width = 1080
    a.project.settings.height = 1920
    await store.save(a)
    const editor = makeEditor(store)
    await editor.restore(a.project.id)
    await assert.rejects(editor.undo(a.project.id), /已经是第一版/)
    assert.equal((await store.list()).length, 2)
  })
})

test('repeated old undo toggles resume from their actually saved state', async () => {
  await withStore(async (store) => {
    const [a, b, c] = await seedHistory(store)
    const first: ProjectRevision = {
      ...b,
      id: 'legacy-undo-1',
      parentRevisionId: c.id,
      feedback: { text: '撤销上一步' },
      agentNote: '已撤销「调大音量」，回到上一版。',
      createdAt: '2020-01-01T00:00:03.000Z',
    }
    const second: ProjectRevision = {
      ...first,
      id: 'legacy-undo-2',
      project: c.project,
      parentRevisionId: first.id,
      createdAt: '2020-01-01T00:00:04.000Z',
    }
    await store.save(first)
    await store.save(second)
    const editor = makeEditor(store)
    assert.deepEqual((await editor.undo(a.project.id)).project.timeline, b.project.timeline)
    assert.deepEqual((await editor.undo(a.project.id)).project.timeline, a.project.timeline)
    await assert.rejects(editor.undo(a.project.id), /已经是第一版/)
  })
})

test('missing or cyclic undo metadata fails without appending history', async () => {
  await withStore(async (store) => {
    const a = firstRevision()
    await store.save(a)
    const invalid: ProjectRevision = {
      ...a,
      id: 'invalid',
      operation: { kind: 'undo', restoredRevisionId: 'missing' },
      parentRevisionId: a.id,
      createdAt: '2020-01-01T00:00:01.000Z',
    }
    await store.save(invalid)
    await assert.rejects(makeEditor(store).undo(a.project.id), /找不到上一版记录/)
    const cyclic: ProjectRevision = {
      ...invalid,
      id: 'cycle',
      operation: { kind: 'undo', restoredRevisionId: 'cycle' },
      createdAt: '2020-01-01T00:00:02.000Z',
    }
    await store.save(cyclic)
    await assert.rejects(makeEditor(store).undo(a.project.id), /修订历史存在循环/)
    assert.equal((await store.list()).length, 3)
  })
})

test('legacy undo and settings-repair revisions remain traversable', async () => {
  await withStore(async (store) => {
    const [a, b, c] = await seedHistory(store)
    const legacyUndo: ProjectRevision = {
      ...b,
      id: 'old-undo',
      parentRevisionId: c.id,
      feedback: { text: '撤销上一步' },
      agentNote: '已撤销「调大音量」，回到上一版。',
      createdAt: '2020-01-01T00:00:03.000Z',
    }
    const legacyRepair: ProjectRevision = {
      ...legacyUndo,
      id: 'old-repair',
      parentRevisionId: legacyUndo.id,
      feedback: { text: '自动修正导出尺寸' },
      agentNote: '导出尺寸已按素材修正为 1280×720（原为 1080×1920）。',
      createdAt: '2020-01-01T00:00:04.000Z',
    }
    await store.save(legacyUndo)
    await store.save(legacyRepair)
    const editor = makeEditor(store)
    assert.deepEqual((await editor.undo(a.project.id)).project.timeline, a.project.timeline)
    await assert.rejects(editor.undo(a.project.id), /已经是第一版/)
  })
})
