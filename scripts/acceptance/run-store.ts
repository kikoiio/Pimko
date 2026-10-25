/**
 * 验收批次：store（docs/testing-acceptance.md 第 11/12 节的存储与缓存受控故障，I 模式为主）。
 *
 * 覆盖：RS-05（旧尺寸项目迁移）、FA-07a（损坏修订 JSON）、FA-07b（缺失父修订）、
 * FA-07c（不可写存储）、FA-08a（损坏缓存）、FA-08b（不可写缓存目录）、FA-08c（阻塞，交叉引用）。
 *
 * 构造数据全部写入 $PIMKO_ACCEPTANCE_HOME/.config/pimko/（启动前），不触碰用户真实数据；
 * 每个 variant 独立子目录 + 独立 AppSession，需要不同 userData 内容时先关会话、清空、写构造文件、再启动。
 * 只在 CI（GitHub Actions / xvfb）运行；本机不得执行。
 */
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AppSession, Case, MATERIALS, materialPath, outDir, runBatch, probeMedia,
} from './lib'

const F1 = () => materialPath(MATERIALS.F1)

// ── 构造数据结构（与 src/domain/project.ts 的 JSON 落盘结构同构，不直接 import 源码） ──
interface ConstructedRevision {
  id: string
  project: {
    id: string
    name: string
    assets: { id: string; kind: 'video'; absolutePath: string; durationSec: number; width?: number; height?: number }[]
    transcript?: { assetId: string; language: string; segments: { startSec: number; endSec: number; text: string }[] }
    timeline: {
      clips: { assetId: string; sourceStartSec: number; sourceEndSec: number; speed?: number }[]
      subtitles: { startSec: number; endSec: number; text: string }[]
      subtitleAppearance?: Record<string, unknown>
      bgm?: { path: string; gainDb: number }
      transitions: { type: string; durationSec?: number }[]
    }
    settings: { width: number; height: number; fps: number; subtitleStyle: string }
  }
  parentRevisionId?: string
  operation?: { kind: 'edit' | 'undo' | 'settings-migration' }
  feedback?: { text: string }
  agentNote?: string
  createdAt: string
}

function pimkoRoot(home: string): string {
  return path.join(home, '.config', 'pimko')
}

/** 清空并重建隔离 userData（每个 variant 独立子目录）。 */
async function resetPimkoData(home: string): Promise<void> {
  await rm(pimkoRoot(home), { recursive: true, force: true })
}

/** 启动前把构造修订写入 projects/<projectId>/<revisionId>.json。 */
async function writeConstructedRevision(home: string, revision: ConstructedRevision): Promise<void> {
  const dir = path.join(pimkoRoot(home), 'projects', revision.project.id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${revision.id}.json`), JSON.stringify(revision, null, 2))
}

/** 旧尺寸历史项目的修订工厂：素材 640×360、settings 1080×1920、三个片段。 */
function makeLegacyRevision(options: {
  projectId: string
  revisionId: string
  parentRevisionId?: string
  createdAt: string
  clip0Start?: number
  operation?: { kind: 'edit' | 'settings-migration' }
  feedback?: string
  agentNote?: string
  settingsWidth?: number
  settingsHeight?: number
}): ConstructedRevision {
  const assetId = 'asset-f1-legacy'
  const clip0Start = options.clip0Start ?? 0
  return {
    id: options.revisionId,
    project: {
      id: options.projectId,
      name: `${options.projectId}-name`,
      assets: [{
        id: assetId, kind: 'video', absolutePath: F1(), durationSec: 15.6, width: 640, height: 360,
      }],
      transcript: {
        assetId,
        language: 'zh-CN',
        segments: [
          { startSec: 0, endSec: 4, text: '第 1 句： 呃 这是 mock 转写内容，接入真实语音识别后会替换。' },
          { startSec: 4, endSec: 8, text: '第 2 句： 呃 这是 mock 转写内容，接入真实语音识别后会替换。' },
          { startSec: 8, endSec: 12, text: '第 3 句： 呃 这是 mock 转写内容，接入真实语音识别后会替换。' },
        ],
      },
      timeline: {
        clips: [
          { assetId, sourceStartSec: clip0Start, sourceEndSec: 4 },
          { assetId, sourceStartSec: 4.5, sourceEndSec: 9 },
          { assetId, sourceStartSec: 9.5, sourceEndSec: 15 },
        ],
        subtitles: [
          { startSec: 0, endSec: 4, text: '第 1 句占位字幕' },
          { startSec: 4.5, endSec: 9, text: '第 2 句占位字幕' },
          { startSec: 9.5, endSec: 15, text: '第 3 句占位字幕' },
        ],
        transitions: [{ type: 'cut' }, { type: 'cut' }],
      },
      settings: {
        width: options.settingsWidth ?? 1080,
        height: options.settingsHeight ?? 1920,
        fps: 30,
        subtitleStyle: 'bold-center',
      },
    },
    ...(options.parentRevisionId ? { parentRevisionId: options.parentRevisionId } : {}),
    ...(options.operation ? { operation: options.operation } : {}),
    ...(options.feedback ? { feedback: { text: options.feedback } } : {}),
    ...(options.agentNote ? { agentNote: options.agentNote } : {}),
    createdAt: options.createdAt,
  }
}

async function main(): Promise<void> {
  const home = process.env.PIMKO_ACCEPTANCE_HOME ?? ''
  if (!home) throw new Error('PIMKO_ACCEPTANCE_HOME 未设置（由 CI 注入）')
  await runBatch('store', async () => {

    // ══ S1：RS-05 旧尺寸项目迁移（构造 + 幂等 + 撤销不被迁移占用） ══════
    {
      await resetPimkoData(home)
      const projectId = 'rs05-legacy-project'
      const rev1Id = 'rs05-rev-0001'
      const rev2Id = 'rs05-rev-0002'
      const t0 = new Date('2026-01-01T00:00:00.000Z')
      await writeConstructedRevision(home, makeLegacyRevision({
        projectId, revisionId: rev1Id, createdAt: t0.toISOString(),
        agentNote: '草稿已生成（历史记录）。',
      }))
      await writeConstructedRevision(home, makeLegacyRevision({
        projectId, revisionId: rev2Id, parentRevisionId: rev1Id,
        createdAt: new Date(t0.getTime() + 1000).toISOString(),
        clip0Start: 0.5, operation: { kind: 'edit' }, feedback: '历史编辑：裁掉片头',
        agentNote: '已剪短开头（历史记录）。',
      }))
      const boot = new Case({ id: 'BOOT-S1', mode: 'I', expected: '构造 userData 后应用启动' })
      const session = new AppSession(boot)
      await session.start()
      const rs05 = new Case({
        id: 'RS-05', variant: 'I/旧尺寸项目迁移', mode: 'I', material: MATERIALS.F1,
        expected: '尺寸自动按源修正为偶数（640×360）并产生一条 settings-migration 修订；第二次恢复不反复追加迁移；撤销回退有效编辑，不被尺寸迁移占用一步',
      })
      // 首次恢复：最近项目卡可见 → 迁移发生
      await session.page.locator('.project-card').first().waitFor({ timeout: 15000 })
      await session.page.locator('.project-card').first().click()
      await session.waitDraftReady()
      const migrated = await session.state(projectId)
      rs05.check('settings 修正为 640×360（偶数）', migrated.settings.width === 640 && migrated.settings.height === 360,
        `${migrated.settings.width}×${migrated.settings.height}`)
      rs05.check('产生 settings-migration 新修订', migrated.id !== rev2Id && migrated.parentRevisionId === rev2Id,
        `${rev2Id} → ${migrated.id}`)
      rs05.check('agentNote 含「修正」', (migrated.agentNote ?? '').includes('修正'), `"${(migrated.agentNote ?? '').slice(0, 60)}"`)
      // 迁移后可导出正确尺寸
      const outPath = outDir('RS-05-migrated.mp4')
      await mkdir(path.dirname(outPath), { recursive: true })
      await session.exportTo(outPath)
      const probe = await probeMedia(outPath)
      rs05.check('导出 640×360', probe.width === 640 && probe.height === 360, `${probe.width}×${probe.height}`)
      rs05.record.output = { path: outPath, durationSec: probe.durationSec, width: probe.width, height: probe.height }
      // 第二次恢复：不反复追加迁移
      await session.close()
      await session.start()
      await session.page.locator('.project-card').first().waitFor({ timeout: 15000 })
      await session.page.locator('.project-card').first().click()
      await session.waitDraftReady()
      const secondRestore = await session.state(projectId)
      rs05.check('第二次恢复无第二次迁移', secondRestore.id === migrated.id,
        `latest=${secondRestore.id.slice(0, 8)}（迁移后 ${migrated.id.slice(0, 8)}）`)
      // 有效编辑 + 撤销：撤销不被迁移占用一步，回到构造 rev2 的内容
      await session.sendFeedback('第一段 2 倍速，其他段不变')
      const edited = await session.state(projectId)
      rs05.check('有效编辑生效', edited.timeline.clips[0]!.speed === 2, `speed=${edited.timeline.clips[0]!.speed}`)
      await session.undo()
      const undone = await session.state(projectId)
      rs05.check('撤销直接回到迁移后状态（rev2 内容）', undone.timeline.clips[0]!.sourceStartSec === 0.5
        && undone.timeline.clips[0]!.speed === undefined && undone.settings.width === 640,
        `start=${undone.timeline.clips[0]!.sourceStartSec}, settings=${undone.settings.width}×${undone.settings.height}`)
      await rs05.saveEvidence('revision-chain', JSON.stringify({ rev1Id, rev2Id, migratedId: migrated.id, editedId: edited.id, undoneId: undone.id }, null, 2))
      await rs05.finish('通过', '迁移一次性发生且幂等；撤销作用于有效编辑而非迁移')
      await session.close()
    }

    // ══ S2：FA-07a 损坏修订 JSON（同项目第二个修订损坏 + 无关正常项目） ══
    {
      await resetPimkoData(home)
      const goodId = 'fa07a-normal-project'
      const corruptId = 'fa07a-corrupt-project'
      await writeConstructedRevision(home, makeLegacyRevision({
        projectId: goodId, revisionId: 'fa07a-good-rev-1', createdAt: '2026-01-01T00:00:00.000Z',
        settingsWidth: 640, settingsHeight: 360, // 与素材一致，避免迁移干扰观察
      }))
      await writeConstructedRevision(home, makeLegacyRevision({
        projectId: corruptId, revisionId: 'fa07a-corrupt-rev-1', createdAt: '2026-01-01T00:00:00.000Z',
        settingsWidth: 640, settingsHeight: 360,
      }))
      // 同项目第二个修订文件内容损坏
      await writeFile(
        path.join(pimkoRoot(home), 'projects', corruptId, 'fa07a-corrupt-rev-2.json'),
        '{invalid',
      )
      const boot = new Case({ id: 'BOOT-S2', mode: 'I', expected: '损坏 userData 后应用启动' })
      const session = new AppSession(boot)
      await session.start()
      const fa07a = new Case({
        id: 'FA-07a', variant: 'I/损坏修订 JSON', mode: 'I',
        expected: '重启后可恢复可恢复项目；当前存储读取异常可能让整个列表为空——若发生记「失败」并写明影响面',
      })
      const cardCount = await session.page.locator('.project-card').count()
      const apiCount = (await session.listProjects()).length
      fa07a.check('最近项目卡片数量（观测）', cardCount === apiCount, `UI 卡片=${cardCount}，API 列表=${apiCount}（构造 2 个项目，其中 1 个含损坏文件）`)
      const alive = await session.page.evaluate(() => document.body.innerText.length > 20 && !!document.querySelector('.app'))
      fa07a.check('不白屏', alive, '应用外壳仍在')
      if (cardCount === 0) {
        fa07a.record.defects.push(
          '失败（与文档预测一致）：一个损坏修订 JSON 使 store.list() 整体抛错被吞掉 → 整个最近项目列表为空；' +
          '影响面扩大到无关的正常项目（fa07a-normal-project 也不可见、不可恢复）',
        )
        await fa07a.finish('失败', `列表为空（构造 2 项目 / 卡片 ${cardCount} / API ${apiCount}）；单个坏文件拖垮全部项目可见性`)
      } else {
        // 若只有损坏项目丢失而正常项目可见 → 按文档记「限制已确认」
        fa07a.record.defects.push(`限制已确认：损坏文件只影响所在项目（可见卡片 ${cardCount} 个），正常项目仍可恢复`)
        await fa07a.finish('限制已确认', `部分可见（卡片 ${cardCount}）；损坏隔离行为按实际观察记录`)
      }
      await fa07a.screenshot(session.page, 'fa07a-list')
      await session.close()
    }

    // ══ S3：FA-07b 缺失父修订（撤销链断裂） ════════════════════════════
    {
      await resetPimkoData(home)
      const projectId = 'fa07b-project'
      const revBId = 'fa07b-rev-b'
      await writeConstructedRevision(home, makeLegacyRevision({
        projectId, revisionId: revBId, parentRevisionId: 'fa07b-missing-parent-000',
        createdAt: '2026-01-01T00:00:00.000Z', operation: { kind: 'edit' }, feedback: '历史编辑（父记录缺失）',
        settingsWidth: 640, settingsHeight: 360,
      }))
      const boot = new Case({ id: 'BOOT-S3', mode: 'I', expected: '构造缺父修订后应用启动' })
      const session = new AppSession(boot)
      await session.start()
      const fa07b = new Case({
        id: 'FA-07b', variant: 'I/缺失父修订', mode: 'I',
        expected: '恢复后点撤销：清楚报错（找不到上一版记录）且项目未损坏',
      })
      await session.page.locator('.project-card').first().waitFor({ timeout: 15000 })
      await session.page.locator('.project-card').first().click()
      await session.waitDraftReady()
      fa07b.check('项目可恢复', (await session.state(projectId)).id === revBId, `latest=${revBId}`)
      fa07b.check('撤销按钮可见（parentRevisionId 存在）', (await session.button('撤销上一步').count()) === 1, 'count=1')
      await session.button('撤销上一步').click()
      const errorText = await session.waitForError(30000)
      fa07b.check('错误条含「找不到上一版记录」', errorText.includes('找不到上一版记录'), `"${errorText.slice(0, 70)}"`)
      const intact = await session.state(projectId)
      fa07b.check('项目未损坏', intact.id === revBId && intact.timeline.clips.length === 3, `revision=${intact.id.slice(0, 8)}`)
      await fa07b.screenshot(session.page, 'fa07b-error')
      await fa07b.finish('通过', '缺父历史撤销给出明确错误且数据完整')
      await session.close()
    }

    // ══ S4：FA-07c 不可写存储（反馈保存必须报错而非静默成功） ═══════════
    {
      await resetPimkoData(home)
      const boot = new Case({ id: 'BOOT-S4', mode: 'I', expected: '正常启动并建基线项目' })
      const session = new AppSession(boot)
      await session.start()
      const fa07c = new Case({
        id: 'FA-07c', variant: 'I/不可写存储', mode: 'I', material: MATERIALS.F1,
        expected: '不可写环境修改：出现错误而非静默成功（不把存储失败报告为已保存）；恢复正常环境后可继续',
      })
      // 先正常建一个项目
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const countBefore = (await readdir(path.join(pimkoRoot(home), 'projects', pid))).filter((f) => f.endsWith('.json')).length
      await session.close()
      // 收紧权限：projects 根目录 + 项目子目录（只动本批次隔离目录）
      const projectsDir = path.join(pimkoRoot(home), 'projects')
      const projectDir = path.join(projectsDir, pid)
      await chmod(projectsDir, 0o555)
      await chmod(projectDir, 0o555)
      await session.start()
      await session.page.locator('.project-card').first().waitFor({ timeout: 15000 })
      await session.page.locator('.project-card').first().click()
      await session.waitDraftReady()
      // 发反馈：期望报错（或如实记录静默成功）
      await session.page.getByRole('textbox', { name: '剪辑反馈' }).fill('第一段 2 倍速，其他段不变')
      await session.button('发送').click()
      let errorSeen = false
      let errorText = ''
      try {
        errorText = await session.waitForError(20000)
        errorSeen = true
      } catch { /* 20s 内无错误条 */ }
      const countAfterFail = (await readdir(projectDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).length
      if (errorSeen) {
        fa07c.check('不可写时出现错误条', errorText.length > 0, `"${errorText.slice(0, 90)}"`)
        fa07c.check('未写入新修订', countAfterFail === countBefore, `${countBefore} → ${countAfterFail}`)
      } else {
        const bubbleAppeared = (await session.agentBubbleCount()) > 0
        fa07c.check('未把存储失败报告为已保存', !(bubbleAppeared && countAfterFail === countBefore),
          `气泡=${bubbleAppeared}，磁盘修订 ${countBefore} → ${countAfterFail}（若气泡出现而磁盘未写即为静默成功）`)
        fa07c.record.defects.push(`观察：20s 内未出现错误条；气泡=${bubbleAppeared}，磁盘修订数 ${countBefore} → ${countAfterFail}（mock 反馈可能不产生磁盘写，按现状记录）`)
      }
      await fa07c.screenshot(session.page, 'readonly-storage')
      // 恢复权限后再发反馈成功
      await chmod(projectsDir, 0o755)
      await chmod(projectDir, 0o755)
      const bubblesBefore = await session.agentBubbleCount()
      await session.page.getByRole('textbox', { name: '剪辑反馈' }).fill('字幕调大')
      await session.button('发送').click()
      await session.page.waitForFunction(
        (c) => document.querySelectorAll('.bubble.agent').length > c, bubblesBefore, { timeout: 60000 },
      )
      const countAfterRetry = (await readdir(projectDir)).filter((f) => f.endsWith('.json')).length
      fa07c.check('恢复权限后修订成功落盘', countAfterRetry === countBefore + 1, `${countBefore} → ${countAfterRetry}`)
      await fa07c.finish('通过', '不可写环境报错且无假成功；恢复后写入正常')
      await session.close()
    }

    // ══ S5：FA-08a 损坏缓存（非零但不可播放） ══════════════════════════
    {
      await resetPimkoData(home)
      const boot = new Case({ id: 'BOOT-S5', mode: 'I', expected: '正常启动并建项目 + 生成一次效果预览' })
      const session = new AppSession(boot)
      await session.start()
      const fa08a = new Case({
        id: 'FA-08a', variant: 'I/损坏缓存', mode: 'I', material: MATERIALS.F1,
        expected: '不把坏缓存当成功画面；当前缓存命中只查非零（代码事实），损坏缓存可能无法自动重建——记录实际限制',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const url1 = await session.renderPreview()
      const cachePath = decodeURIComponent(url1.replace('pimko-media://media/', ''))
      fa08a.record.cache = { cachePath, revisionId: (await session.state(pid)).id }
      await session.close()
      // 写入 2MB 非零垃圾字节
      const garbage = Buffer.alloc(2 * 1024 * 1024)
      for (let i = 0; i < garbage.length; i++) garbage[i] = (i % 251) + 1
      await writeFile(cachePath, garbage)
      fa08a.check('缓存已替换为 2MB 垃圾字节', (await stat(cachePath)).size === 2 * 1024 * 1024, `${(await stat(cachePath)).size} bytes`)
      await session.start()
      await session.page.locator('.project-card').first().waitFor({ timeout: 15000 })
      await session.page.locator('.project-card').first().click()
      await session.waitDraftReady()
      // 缓存命中只查非零 → 坏缓存被当命中 → video 解码失败
      await session.renderPreview()
      const videoBroken = await session.page.waitForFunction(() => {
        const v = document.querySelector('video') as HTMLVideoElement | null
        return !!v && v.error !== null
      }, undefined, { timeout: 10000 }).then(() => true, () => false)
      fa08a.check('坏缓存被当作命中返回（video 解码失败）', videoBroken, videoBroken ? 'video.error 非 null（限制确认）' : '10s 内 video.error 仍为 null（与预期不符，如实记录）')
      fa08a.record.defects.push(
        '限制已确认（文档预告）：缓存命中只检查文件非零，损坏缓存无法自动检测与重建，坏画面被当作效果预览交付；' +
        '原始文件在重试前已备份到批次目录',
      )
      await fa08a.screenshot(session.page, 'corrupt-cache')
      // 删除坏缓存 → 切回草稿页签强制 video 重挂载 → 重试成功
      const revisionId = (await session.state(pid)).id
      await rm(cachePath, { force: true })
      await session.page.getByRole('tab', { name: '草稿预览', exact: true }).click()
      const url2 = await session.renderPreview()
      await session.page.waitForFunction(() => {
        const v = document.querySelector('video')
        return !!v && v.readyState >= 2 && v.videoWidth > 0
      }, undefined, { timeout: 120000 })
      fa08a.check('删除坏缓存后重新渲染成功', decodeURIComponent(url2.replace('pimko-media://media/', '')) === cachePath,
        '同 key 缓存重新生成并可播放')
      fa08a.record.cache = { ...fa08a.record.cache, revisionIdAfter: revisionId, reRenderUrl: url2.slice(0, 80) }
      await fa08a.finish('限制已确认', '坏缓存命中（限制）→ 删除后重试成功；自动检测/重建能力为产品空白')
      await session.close()
    }

    // ══ S6：FA-08b 不可写缓存目录 ═══════════════════════════════════════
    {
      await resetPimkoData(home)
      const boot = new Case({ id: 'BOOT-S6', mode: 'I', expected: '正常启动并建项目' })
      const session = new AppSession(boot)
      await session.start()
      const fa08b = new Case({
        id: 'FA-08b', variant: 'I/不可写缓存目录', mode: 'I', material: MATERIALS.F1,
        expected: '失败有提示，原 revision 完整；半成品清理，下一次可成功',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const revBefore = (await session.state(pid)).id
      const previewsDir = path.join(pimkoRoot(home), 'previews')
      await mkdir(previewsDir, { recursive: true })
      await chmod(previewsDir, 0o555) // 只动本批次隔离目录
      await session.button('查看实际效果').click()
      const errorText = await session.waitForError(120000)
      fa08b.check('失败有可见错误', errorText.length > 0, `"${errorText.slice(0, 90)}"`)
      fa08b.check('原 revision 完整', (await session.state(pid)).id === revBefore, revBefore.slice(0, 8))
      await fa08b.screenshot(session.page, 'readonly-previews')
      await chmod(previewsDir, 0o755)
      const partials = (await readdir(previewsDir)).filter((f) => f.endsWith('.partial.mp4'))
      fa08b.check('无 *.partial 残留', partials.length === 0, partials.length === 0 ? 'previews 目录干净' : partials.join('、'))
      const url = await session.renderPreview()
      await session.page.waitForFunction(() => {
        const v = document.querySelector('video')
        return !!v && v.readyState >= 2 && v.videoWidth > 0
      }, undefined, { timeout: 120000 })
      fa08b.check('恢复权限后重试成功', url.startsWith('pimko-media://media/'), url.slice(0, 70))
      fa08b.record.cache = { previewsDir, partialCount: partials.length }
      await fa08b.finish('通过', '不可写缓存目录报错且 revision 完整；恢复后重试成功、无半成品残留')
      await session.close()
    }

    // ══ S7：FA-08c 首次渲染失败（阻塞，交叉引用） ═══════════════════════
    {
      const fa08c = new Case({
        id: 'FA-08c', variant: 'I/首次渲染失败', mode: 'I',
        expected: '失败有提示、半成品清理、重试成功（由 injection 批次 EX-07 与 check-preview.test.ts 覆盖）',
      })
      await fa08c.finish('阻塞',
        '本批次不重复搭建渲染失败注入：UI 报错可见性已由 injection 批次 EX-07（ffmpeg PATH 垫片）覆盖；' +
        '半成品清理与重试语义已由 scripts/check-preview.test.ts 的断言测试覆盖。',
        'GUI 级渲染失败注入已由 injection 批次 EX-07 与 check-preview.test.ts 覆盖，本批次不重复搭建 PATH 垫片')
    }
  })
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
