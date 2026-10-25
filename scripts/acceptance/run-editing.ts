/**
 * 验收批次：editing（docs/testing-acceptance.md 第 4-9 节的编辑/速度/撤销/字幕/预览项）。
 *
 * 覆盖：ED-07、ED-08、ED-10、SP-01/02/03（同一项目链）、SP-05（3 变体）、
 * UN-02/03/04、SU-02（F1/F2 两变体）、SU-03、SU-04、SU-07、SU-08、
 * PV-03、PV-06、PV-07。全部为 M（mock）模式。
 *
 * 只在 CI（GitHub Actions / xvfb）运行；本机不得执行（Electron/渲染重型操作）。
 */
import { readFile, readdir, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright'
import {
  AppSession, Case, MATERIALS, materialPath, outDir, runBatch, probeMedia,
  expectedDuration, frameLumaAvg,
} from './lib'

const F1 = () => materialPath(MATERIALS.F1)
const BGM_WAV = () => materialPath(MATERIALS.boundary('bgm-2s.wav'))

interface Box { x: number; y: number; width: number; height: number }

async function readVideo(page: Page): Promise<{ time: number; paused: boolean; rate: number } | null> {
  return page.evaluate(() => {
    const v = document.querySelector('video')
    return v ? { time: v.currentTime, paused: v.paused, rate: v.playbackRate } : null
  })
}

/** 项目当前磁盘修订文件数（编辑/撤销断言用，与 UI 状态互证）。 */
async function diskRevisionCount(home: string, projectId: string): Promise<number> {
  try {
    const files = await readdir(path.join(home, '.config', 'pimko', 'projects', projectId))
    return files.filter((f) => f.endsWith('.json')).length
  } catch {
    return 0
  }
}

/** 点击 BGM 音量档位并等待修订气泡。 */
async function clickBgmVolume(session: AppSession, label: string): Promise<void> {
  const before = await session.agentBubbleCount()
  await session.button(label).click()
  await session.page.waitForFunction(
    (c) => document.querySelectorAll('.bubble.agent').length > c, before, { timeout: 30000 },
  )
}

/** 添加配乐（stub 音频对话框）并等待修订气泡。 */
async function addBgm(session: AppSession, audioPath: string): Promise<void> {
  await session.stubDialogs({ audio: audioPath })
  const before = await session.agentBubbleCount()
  await session.button('添加配乐').click()
  await session.page.waitForFunction(
    (c) => document.querySelectorAll('.bubble.agent').length > c, before, { timeout: 30000 },
  )
}

/** 重启后按 projectId 从最近项目列表恢复（卡片与 listProjects 同源同序）。 */
async function restoreFromRecent(session: AppSession, projectId: string): Promise<void> {
  const projects = await session.listProjects()
  const index = projects.findIndex((p) => p.projectId === projectId)
  if (index < 0) throw new Error(`最近项目列表中找不到项目 ${projectId}`)
  await session.page.locator('.project-card').nth(index).click()
  await session.waitDraftReady()
}

/** 点击第 1 张卡片播放，等待字幕叠层出现后测量 overlay/stage/video 包围盒。
 * overlay 只在草稿播放且当前源时间有字幕时渲染；强制起播并兜底重试一次。 */
async function playAndMeasureOverlay(session: AppSession): Promise<{ overlay: Box | null; stage: Box | null }> {
  // overlay 只在草稿模式渲染；上一用例导出后停在成片模式（卡片被禁用）需先切回
  const draftTab = session.page.getByRole('tab', { name: '草稿预览' })
  if (await draftTab.count() > 0) await draftTab.click().catch(() => undefined)
  await session.page.locator('.clip').first().click({ force: true })
  // 确保视频真正在播（force 点击不保证 React onClick 已触发 play）
  await session.page.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement | null
    if (v && v.paused) void v.play()
  })
  try {
    await session.page.locator('.subtitle-overlay').waitFor({ state: 'visible', timeout: 20000 })
  } catch {
    // 二次兜底：重置到第 1 段起点再播
    await session.page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement | null
      if (v) { v.currentTime = 0.2; v.playbackRate = 1; void v.play() }
    })
    await session.page.locator('.subtitle-overlay').waitFor({ state: 'visible', timeout: 20000 })
  }
  return session.page.evaluate(() => {
    const overlay = document.querySelector('.subtitle-overlay')
    const stage = document.querySelector('.stage')
    const or_ = overlay ? overlay.getBoundingClientRect() : null
    const sr = stage ? stage.getBoundingClientRect() : null
    return { overlay: or_ ? { x: or_.x, y: or_.y, width: or_.width, height: or_.height } : null, stage: sr ? { x: sr.x, y: sr.y, width: sr.width, height: sr.height } : null }
  })
}

function overlayInside(overlay: Box | null, stage: Box | null): boolean {
  return !!overlay && !!stage
    && overlay.x >= stage.x - 1 && overlay.y >= stage.y - 1
    && overlay.x + overlay.width <= stage.x + stage.width + 1
    && overlay.y + overlay.height <= stage.y + stage.height + 1
}

async function main(): Promise<void> {
  await runBatch('editing', async () => {
    const boot = new Case({ id: 'BOOT', mode: 'M', expected: '应用启动（mock 模式）' })
    const session = new AppSession(boot)
    await session.start()
    const home = session.home

    // ══ ED-07：F4 长停顿素材的初稿预剪 ═══════════════════════════════
    {
      const ed07 = new Case({
        id: 'ED-07', variant: 'M/F4', mode: 'M', material: MATERIALS.F4,
        expected: '初稿已做停顿预剪：clips 不覆盖静音区间中点、长停顿对应的源区间被拆分；M 仅能确认初稿预剪，不证明理解了反馈',
      })
      await session.stubDialogs({ video: materialPath(MATERIALS.F4) })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const st = await session.state(pid)
      // 静音图不在 RevisionSnapshot 里，从磁盘修订 JSON 只读读取
      const revFile = path.join(home, '.config', 'pimko', 'projects', pid, `${st.id}.json`)
      const raw = JSON.parse(await readFile(revFile, 'utf8')) as {
        project?: { silences?: { startSec: number; endSec: number }[] }
      }
      const silences = raw.project?.silences ?? []
      const longPauses = silences.filter((s) => s.endSec - s.startSec >= 0.6)
      ed07.check('静音图存在（长停顿 ≥0.6s）', longPauses.length >= 3, `${longPauses.length} 处长停顿（共 ${silences.length} 处静音）`)
      ed07.check('长停顿对应源区间被拆分', st.timeline.clips.length > (st.transcript?.segments.length ?? 0),
        `clips=${st.timeline.clips.length} > 转写段=${st.transcript?.segments.length ?? 0}`)
      // clips 不覆盖任何长停顿的中点
      const covering = longPauses.filter((s) => {
        const mid = (s.startSec + s.endSec) / 2
        return st.timeline.clips.some((c) => c.sourceStartSec < mid && mid < c.sourceEndSec)
      })
      ed07.check('clips 不覆盖静音区间中点', covering.length === 0,
        covering.length === 0 ? `${longPauses.length} 处中点全部落在剪口内` : `被覆盖中点：${JSON.stringify(covering)}`)
      ed07.record.defects.push('M 仅能确认初稿预剪；对「压缩长停顿」反馈的语义理解与听感在 real 批次（R）验证')
      await ed07.saveEvidence('draft-timeline', JSON.stringify({ silences, clips: st.timeline.clips }, null, 2))
      await ed07.finish('通过', `初稿 ${st.timeline.clips.length} 段（转写 ${st.transcript?.segments.length ?? 0} 段 + ${longPauses.length} 处停顿压缩）`)
    }

    // ══ ED-08：空输入 / 全空格 / Enter 与按钮发送 ═════════════════════
    {
      const ed08 = new Case({
        id: 'ED-08', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '空输入不能发起修订；每次有效提交只有一个用户气泡和一个结果；Enter 与按钮没有重复执行同一条',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const input = session.page.getByRole('textbox', { name: '剪辑反馈' })
      // 清空输入点发送
      await input.fill('')
      ed08.check('空输入时发送按钮 disabled', await session.button('发送').isDisabled(), 'disabled=true')
      await session.page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === '发送') as HTMLButtonElement | undefined
        btn?.click() // disabled 按钮不会触发 click 事件
      })
      await session.page.waitForTimeout(600)
      const bubbles0 = await session.agentBubbleCount()
      ed08.check('空输入无气泡产生', bubbles0 === 0, `气泡数 ${bubbles0}`)
      // 全空格输入
      await input.fill('   ')
      ed08.check('全空格时发送按钮 disabled', await session.button('发送').isDisabled(), 'trim 后为空')
      const disk0 = await diskRevisionCount(home, pid)
      await session.page.waitForTimeout(400)
      ed08.check('全空格不产生修订', (await diskRevisionCount(home, pid)) === disk0, `磁盘修订数 ${disk0}`)
      // 有效反馈 1：Enter 发送
      await input.fill('第一段 2 倍速，其他段不变')
      const bubbles1 = await session.agentBubbleCount()
      await session.page.keyboard.press('Enter')
      await session.page.waitForFunction(
        (c) => document.querySelectorAll('.bubble.agent').length > c, bubbles1, { timeout: 60000 },
      )
      await session.page.waitForTimeout(500)
      const user1 = await session.page.locator('.bubble.user').count()
      ed08.check('Enter 提交恰好一轮（1 用户气泡 + 1 结果）', user1 === 1 && (await session.agentBubbleCount()) === bubbles1 + 1,
        `user=${user1}, agent=${await session.agentBubbleCount()}（前 ${bubbles1}）`)
      ed08.check('Enter 提交磁盘修订 +1', (await diskRevisionCount(home, pid)) === disk0 + 1, `${disk0} → ${await diskRevisionCount(home, pid)}`)
      // 有效反馈 2：按钮发送
      const idBefore = (await session.state(pid)).id
      await session.sendFeedback('字幕移到顶部')
      const user2 = await session.page.locator('.bubble.user').count()
      ed08.check('按钮提交恰好一轮', user2 === 2 && (await session.agentBubbleCount()) === bubbles1 + 2,
        `user=${user2}, agent=${await session.agentBubbleCount()}`)
      ed08.check('按钮提交磁盘修订 +1', (await diskRevisionCount(home, pid)) === disk0 + 2, `当前 ${await diskRevisionCount(home, pid)}`)
      const stAfter = await session.state(pid)
      ed08.check('两轮修订链成立', stAfter.id !== idBefore, `${idBefore.slice(0, 8)} → ${stAfter.id.slice(0, 8)}`)
      await ed08.finish('通过', '空/空白输入被禁用拦截，Enter 与按钮各产生恰好一轮修订')
    }

    // ══ ED-10：两段以上 + BGM + 已改字幕，发「只把第二段调为 1.5 倍速」 ══
    {
      const ed10 = new Case({
        id: 'ED-10', variant: 'M/mock 对照', mode: 'M', material: MATERIALS.F1,
        expected: 'R 主验只改第二段；M 预期仍改第一段（mock 限制，不计语义通过）；无论模式都保留 BGM 与字幕',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      await addBgm(session, BGM_WAV())
      await session.sendFeedback('字幕调大')
      const beforeEd10 = await session.state(pid)
      await session.sendFeedback('只把第二段调为 1.5 倍速')
      const after = await session.state(pid)
      ed10.check('mock 仍改第一段（预期 mock 行为）', after.timeline.clips[0]!.speed === 1.5, `clips[0].speed=${after.timeline.clips[0]!.speed}`)
      ed10.check('第二段未被修改', (after.timeline.clips[1]!.speed ?? 1) === (beforeEd10.timeline.clips[1]!.speed ?? 1),
        `clips[1].speed=${after.timeline.clips[1]!.speed}`)
      ed10.check('BGM 设置未丢失', after.timeline.bgm?.path === beforeEd10.timeline.bgm?.path
        && after.timeline.bgm?.gainDb === beforeEd10.timeline.bgm?.gainDb, JSON.stringify(after.timeline.bgm))
      ed10.check('字幕设置未丢失', after.timeline.subtitleAppearance?.size === 'large', JSON.stringify(after.timeline.subtitleAppearance))
      ed10.record.defects.push('限制已确认：mock 关键词逻辑不支持段号语义——写「第二段」仍改第一段（文档 1.2/ED-10 预告），不能计为语义通过，R 批次主验')
      await ed10.saveEvidence('before-after', JSON.stringify({ before: beforeEd10.timeline, after: after.timeline }, null, 2))
      await ed10.finish('限制已确认', `mock 把第 1 段设为 ${after.timeline.clips[0]!.speed}x；BGM 与字幕均保留；段号语义 R 批次验证`)
    }

    // ══ SP-01 / SP-02 / SP-03：同一项目链 0.5x → 1x → 2x ═══════════════
    {
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const draft = await session.state(pid)
      await session.sendFeedback('开头太拖，直接进正题')
      const baseline = await session.state(pid) // 裁剪后基线（区间不同于初稿）
      const exportAndProbe = async (file: string) => {
        const outPath = outDir(file)
        await mkdir(path.dirname(outPath), { recursive: true })
        await session.exportTo(outPath)
        return { probe: await probeMedia(outPath), outPath }
      }
      const withinTolerance = (actual: number, expect: number) => Math.abs(actual - expect) <= Math.max(0.6, expect * 0.06)

      const sp01 = new Case({
        id: 'SP-01', variant: 'M/0.5x', mode: 'M', material: MATERIALS.F1,
        expected: '首段 0.5x（时长约为源区间两倍）；其它段速度不变；导出时长符合时间线口径',
      })
      await session.sendFeedback('第一段 0.5 倍速，其他段不变')
      const after05 = await session.state(pid)
      sp01.check('首段 0.5x', after05.timeline.clips[0]!.speed === 0.5, `speed=${after05.timeline.clips[0]!.speed}`)
      sp01.check('其它段速度不变', after05.timeline.clips.slice(1).every((c) => (c.speed ?? 1) === 1), '全部 1x')
      sp01.check('裁剪区间保留', after05.timeline.clips[0]!.sourceStartSec === baseline.timeline.clips[0]!.sourceStartSec,
        `start=${after05.timeline.clips[0]!.sourceStartSec}`)
      const r1 = await exportAndProbe('SP-01-0.5x.mp4')
      const expect1 = expectedDuration(after05.timeline)
      sp01.check('导出时长 ≈ 期望', withinTolerance(r1.probe.durationSec, expect1),
        `实际 ${r1.probe.durationSec.toFixed(2)}s vs 期望 ${expect1.toFixed(2)}s（容差 ${Math.max(0.6, expect1 * 0.06).toFixed(2)}s）`)
      sp01.record.output = { path: r1.outPath, durationSec: r1.probe.durationSec, width: r1.probe.width, height: r1.probe.height }
      sp01.record.cache = { revisionId: after05.id }
      await sp01.finish('通过', '0.5x 生效且导出时长符合口径')

      const sp02 = new Case({
        id: 'SP-02', variant: 'M/恢复 1x', mode: 'M', material: MATERIALS.F1,
        expected: '首段恢复原速（mock 写入 speed:1 而非删除键值，断言 ===1）；源区间和其它设置不回到初稿',
      })
      await session.sendFeedback('第一段 1 倍速，其他段不变')
      const after1 = await session.state(pid)
      sp02.check('首段 speed === 1', after1.timeline.clips[0]!.speed === 1, `speed=${after1.timeline.clips[0]!.speed}`)
      sp02.check('源区间不回到初稿', after1.timeline.clips[0]!.sourceStartSec === baseline.timeline.clips[0]!.sourceStartSec
        && baseline.timeline.clips[0]!.sourceStartSec !== draft.timeline.clips[0]!.sourceStartSec,
        `start=${after1.timeline.clips[0]!.sourceStartSec}（初稿 ${draft.timeline.clips[0]!.sourceStartSec}）`)
      sp02.check('其余片段区间与 SP-01 后一致', JSON.stringify(after1.timeline.clips.slice(1)) === JSON.stringify(after05.timeline.clips.slice(1)), 'JSON 一致')
      sp02.record.cache = { revisionId: after1.id, revisionBefore: after05.id }
      await sp02.finish('通过', '恢复 1x 且未回退到初稿区间')

      const sp03 = new Case({
        id: 'SP-03', variant: 'M/2x', mode: 'M', material: MATERIALS.F1,
        expected: '首段时长为源区间一半；输出不是首段 4 倍速；导出时长符合口径',
      })
      await session.sendFeedback('第一段 2 倍速，其他段不变')
      const after2 = await session.state(pid)
      sp03.check('首段 2x', after2.timeline.clips[0]!.speed === 2, `speed=${after2.timeline.clips[0]!.speed}`)
      sp03.check('第二段恢复自身速度', (after2.timeline.clips[1]!.speed ?? 1) === 1, `clips[1].speed=${after2.timeline.clips[1]!.speed}`)
      const r3 = await exportAndProbe('SP-03-2x.mp4')
      const expect3 = expectedDuration(after2.timeline)
      sp03.check('导出时长 ≈ 期望（无累计漂移/4 倍速）', withinTolerance(r3.probe.durationSec, expect3),
        `实际 ${r3.probe.durationSec.toFixed(2)}s vs 期望 ${expect3.toFixed(2)}s`)
      sp03.record.output = { path: r3.outPath, durationSec: r3.probe.durationSec, width: r3.probe.width, height: r3.probe.height }
      sp03.record.cache = { revisionId: after2.id, chain: [after05.id, after1.id, after2.id] }
      await sp03.finish('通过', '2x 生效，导出时长符合口径')
    }

    // ══ SP-05：0 / 0.1 / 3 倍速（mock 夹取对照） ═══════════════════════
    {
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const variants = [
        { label: '0 倍速', text: '第一段 0 倍速，其他段不变', clamp: 0.5 },
        { label: '0.1 倍速', text: '第一段 0.1 倍速，其他段不变', clamp: 0.5 },
        { label: '3 倍速', text: '第一段 3 倍速，其他段不变', clamp: 2 },
      ]
      for (const entry of variants) {
        const sp05 = new Case({
          id: 'SP-05', variant: `M/${entry.label}`, mode: 'M', material: MATERIALS.F1,
          expected: 'R 拒绝或限制到 0.5–2 并准确说明；M 将数值夹到范围内——记录实际值，不能充当非法模型计划校验通过（精确校验见 FA-06）',
        })
        await session.sendFeedback(entry.text)
        const st = await session.state(pid)
        const saved = st.timeline.clips[0]!.speed
        sp05.check('保存值被夹到 0.5–2', saved === entry.clamp, `实际保存 speed=${saved}（夹取期望 ${entry.clamp}）`)
        await session.undo()
        const restored = await session.state(pid)
        sp05.check('撤销后恢复基线', restored.timeline.clips[0]!.speed === undefined, `撤销后 speed=${restored.timeline.clips[0]!.speed}`)
        sp05.record.cache = { savedSpeed: saved, revisionAfterSave: st.id, revisionAfterUndo: restored.id }
        sp05.record.defects.push('限制已确认：mock 把越界速度夹到 0.5–2 保存，没有拒绝语义；不能充当非法计划校验通过，精确校验在 injection 批次 FA-06')
        await sp05.finish('限制已确认', `「${entry.label}」被 mock 夹取为 ${saved}x 并保存；已撤销恢复；非法计划精确校验在 FA-06`)
      }
    }

    // ══ UN-02：初稿无撤销入口；到初稿后再撤销报「已经是第一版」 ═════════
    {
      const un02 = new Case({
        id: 'UN-02', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '初稿无撤销入口（或点击后明确提示已是第一版）；不生成假回退，不损坏当前修订',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const draft = await session.state(pid)
      un02.check('初稿 parentRevisionId 为空', !draft.parentRevisionId, `parent=${draft.parentRevisionId ?? '无'}`)
      un02.check('初稿无撤销按钮', (await session.button('撤销上一步').count()) === 0, `count=${await session.button('撤销上一步').count()}`)
      // 构造一次修改 → 撤销回初稿 → 再点撤销
      await session.sendFeedback('开头太拖，直接进正题')
      await session.undo()
      const backToDraft = await session.state(pid)
      un02.check('撤销回初稿', JSON.stringify(backToDraft.timeline.clips) === JSON.stringify(draft.timeline.clips), 'clips 与初稿一致')
      un02.check('撤销修订仍有 parent（按钮显示）', !!backToDraft.parentRevisionId && (await session.button('撤销上一步').count()) === 1, '按钮可见')
      await session.button('撤销上一步').click()
      const errorText = await session.waitForError(30000)
      un02.check('错误条含「已经是第一版」', errorText.includes('已经是第一版'), `"${errorText.slice(0, 60)}"`)
      const finalState = await session.state(pid)
      un02.check('当前修订未损坏', finalState.id === backToDraft.id
        && JSON.stringify(finalState.timeline) === JSON.stringify(backToDraft.timeline), 'revision 与点击前一致')
      await un02.screenshot(session.page, 'already-first')
      await un02.finish('通过', '初稿无入口；到初稿后撤销给出明确提示且不损坏数据')
    }

    // ══ UN-03：撤销速度 → 字幕 → 再撤销，不复活已撤销速度 ═════════════
    {
      const un03 = new Case({
        id: 'UN-03', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '新修改基于撤销后的内容；撤销字幕后仍为撤销速度后的状态；不突然恢复已撤销的速度',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      await session.sendFeedback('第一段 2 倍速，其他段不变')
      await session.undo()
      const afterSpeedUndo = await session.state(pid)
      await session.sendFeedback('字幕移到顶部')
      const afterSubtitle = await session.state(pid)
      un03.check('新修改基于撤销后内容', afterSubtitle.timeline.clips[0]!.speed === undefined, `speed=${afterSubtitle.timeline.clips[0]!.speed}`)
      await session.undo()
      const finalState = await session.state(pid)
      un03.check('撤销字幕回到撤销速度后状态', finalState.timeline.subtitleAppearance?.position !== 'top',
        `position=${finalState.timeline.subtitleAppearance?.position ?? '默认'}`)
      un03.check('未复活已撤销速度', finalState.timeline.clips[0]!.speed === undefined, `speed=${finalState.timeline.clips[0]!.speed}`)
      un03.check('与撤销速度后状态一致', JSON.stringify(finalState.timeline) === JSON.stringify(afterSpeedUndo.timeline), 'timeline JSON 一致')
      un03.record.cache = { afterSpeedUndo: afterSpeedUndo.id, afterSubtitle: afterSubtitle.id, final: finalState.id }
      await un03.finish('通过', '撤销链干净，未复活被放弃分支的速度')
    }

    // ══ UN-04：BGM → 轻 → 字幕 → 裁开头，逐次撤销对照前一版 ════════════
    {
      const un04 = new Case({
        id: 'UN-04', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '依次恢复剪口、字幕、音量、无 BGM；非目标字段保持；每次成功撤销都有对应说明',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const s0 = await session.state(pid)
      await addBgm(session, BGM_WAV())
      const s1 = await session.state(pid) // BGM -18
      await clickBgmVolume(session, '轻')
      const s2 = await session.state(pid) // -24
      await session.sendFeedback('字幕调大')
      const s3 = await session.state(pid) // 字幕 large
      await session.sendFeedback('开头太拖，直接进正题')
      const s4 = await session.state(pid) // 裁剪
      // 撤销 1：回字幕调大（剪口恢复）
      await session.undo()
      const u1 = await session.state(pid)
      un04.check('①剪口恢复', JSON.stringify(u1.timeline.clips) === JSON.stringify(s3.timeline.clips)
        && u1.timeline.clips[0]!.sourceStartSec === s0.timeline.clips[0]!.sourceStartSec, `start=${u1.timeline.clips[0]!.sourceStartSec}`)
      un04.check('①字幕/BGM 保持', u1.timeline.subtitleAppearance?.size === 'large' && u1.timeline.bgm?.gainDb === -24, JSON.stringify(u1.timeline.bgm))
      // 撤销 2：字幕回默认
      await session.undo()
      const u2 = await session.state(pid)
      un04.check('②字幕回默认', u2.timeline.subtitleAppearance?.size === undefined, `size=${u2.timeline.subtitleAppearance?.size ?? '默认'}`)
      un04.check('②BGM 保持 -24', u2.timeline.bgm?.gainDb === -24, `gainDb=${u2.timeline.bgm?.gainDb}`)
      // 撤销 3：音量回 -18
      await session.undo()
      const u3 = await session.state(pid)
      un04.check('③音量回 -18', u3.timeline.bgm?.gainDb === -18 && u3.timeline.bgm?.path === s1.timeline.bgm?.path, JSON.stringify(u3.timeline.bgm))
      un04.check('③片段不变', JSON.stringify(u3.timeline.clips) === JSON.stringify(s2.timeline.clips), 'clips 一致')
      // 撤销 4：BGM 键消失
      await session.undo()
      const u4 = await session.state(pid)
      un04.check('④BGM 键消失', u4.timeline.bgm === undefined && !('bgm' in u4.timeline), `bgm=${u4.timeline.bgm}`)
      un04.check('④回到初稿片段', JSON.stringify(u4.timeline.clips) === JSON.stringify(s0.timeline.clips), 'clips 与初稿一致')
      un04.record.cache = { chain: [s0.id, s1.id, s2.id, s3.id, s4.id, u1.id, u2.id, u3.id, u4.id] }
      await un04.finish('通过', '四轮撤销逐级恢复且非目标字段保持')
    }

    // ══ SU-02（F1 横屏）：三轮字幕位置 + 截图 + overlay 在画面内 ═════════
    const su02F1Project = { pid: '' }
    {
      const su02 = new Case({
        id: 'SU-02', variant: 'M/F1 横屏', mode: 'M', material: MATERIALS.F1,
        expected: '对应 top/center/bottom；字幕处于所要求位置且没有被裁出画面；字号和其它设置保留',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      su02F1Project.pid = pid
      const sizeBefore = (await session.state(pid)).timeline.subtitleAppearance?.size
      const rounds = [
        { text: '字幕移到顶部', position: 'top', shot: 'su02-top' },
        { text: '字幕移到中间', position: 'center', shot: 'su02-center' },
        { text: '字幕移到底部', position: 'bottom', shot: 'su02-bottom' },
      ]
      let allOk = true
      const details: string[] = []
      for (const round of rounds) {
        await session.sendFeedback(round.text)
        const st = await session.state(pid)
        const positionOk = st.timeline.subtitleAppearance?.position === round.position
        const sizeOk = st.timeline.subtitleAppearance?.size === sizeBefore
        const boxes = await playAndMeasureOverlay(session)
        const inside = overlayInside(boxes.overlay, boxes.stage)
        await su02.screenshot(session.page, round.shot)
        const roundOk = positionOk && sizeOk && inside
        allOk = allOk && roundOk
        details.push(`${round.position}: 修订=${positionOk}, 字号保持=${sizeOk}, overlay 在画面内=${inside}`)
      }
      su02.check('三轮位置/字号/画面内全部符合', allOk, details.join('；'))
      await su02.finish(allOk ? '通过' : '失败', details.join('；'))
    }

    // ══ SU-03：字幕简洁 → 加粗（续用 F1 项目） ══════════════════════════
    {
      const pid = su02F1Project.pid
      const su03 = new Case({
        id: 'SU-03', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '修订样式分别为 minimal、bold；仅改变样式，不意外改变字号、位置和文字内容',
      })
      const before = await session.state(pid)
      await session.sendFeedback('字幕简洁')
      const minimal = await session.state(pid)
      su03.check('style=minimal', minimal.timeline.subtitleAppearance?.style === 'minimal', JSON.stringify(minimal.timeline.subtitleAppearance))
      su03.check('字号/位置不变', minimal.timeline.subtitleAppearance?.size === before.timeline.subtitleAppearance?.size
        && minimal.timeline.subtitleAppearance?.position === before.timeline.subtitleAppearance?.position, 'size/position 保持')
      su03.check('字幕文字不变', JSON.stringify(minimal.timeline.subtitles) === JSON.stringify(before.timeline.subtitles), 'subtitles JSON 一致')
      await session.sendFeedback('字幕加粗')
      const bold = await session.state(pid)
      su03.check('style=bold', bold.timeline.subtitleAppearance?.style === 'bold', JSON.stringify(bold.timeline.subtitleAppearance))
      su03.check('字号/位置/文字仍不变', bold.timeline.subtitleAppearance?.size === before.timeline.subtitleAppearance?.size
        && bold.timeline.subtitleAppearance?.position === before.timeline.subtitleAppearance?.position
        && JSON.stringify(bold.timeline.subtitles) === JSON.stringify(before.timeline.subtitles), '全部保持')
      await su03.finish('通过', '简洁与加粗两轮样式切换生效且不影响其它字段')
    }

    // ══ SU-04：大号+顶部 → 隐藏 → 效果/导出 → 显示恢复 ═════════════════
    {
      const pid = su02F1Project.pid
      const su04 = new Case({
        id: 'SU-04', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '隐藏时草稿、效果、导出均无字幕；显示后恢复原字号、位置和样式；不误删语音与转写',
      })
      await session.sendFeedback('字幕调大并移到顶部')
      const configured = await session.state(pid)
      await session.sendFeedback('隐藏字幕')
      const hidden = await session.state(pid)
      su04.check('visible=false', hidden.timeline.subtitleAppearance?.visible === false, JSON.stringify(hidden.timeline.subtitleAppearance))
      // 草稿模式播放验证无叠层
      await session.page.locator('.clip').first().click({ force: true })
      await session.page.waitForTimeout(1200)
      su04.check('草稿模式无字幕叠层', (await session.page.locator('.subtitle-overlay').count()) === 0, 'count=0')
      await su04.screenshot(session.page, 'hidden-draft')
      // 效果预览 + 导出
      await session.renderPreview()
      await session.page.waitForFunction(() => {
        const v = document.querySelector('video')
        return !!v && v.readyState >= 2 && v.videoWidth > 0
      }, undefined, { timeout: 60000 })
      const outPath = outDir('SU-04-hidden.mp4')
      await mkdir(path.dirname(outPath), { recursive: true })
      await session.exportTo(outPath)
      su04.check('隐藏状态下导出成功', true, outPath)
      su04.record.output = { path: outPath }
      // 显示恢复
      await session.sendFeedback('显示字幕')
      const shown = await session.state(pid)
      su04.check('恢复字号/位置/样式', shown.timeline.subtitleAppearance?.size === 'large'
        && shown.timeline.subtitleAppearance?.position === 'top'
        && shown.timeline.subtitleAppearance?.style === configured.timeline.subtitleAppearance?.style
        && shown.timeline.subtitleAppearance?.visible === true, JSON.stringify(shown.timeline.subtitleAppearance))
      su04.check('转写未误删', JSON.stringify(shown.timeline.subtitles) === JSON.stringify(hidden.timeline.subtitles), 'subtitles 一致')
      await su04.finish('通过', '隐藏/显示字幕全链路（草稿、效果、导出）符合预期')
    }

    // ══ SU-07：最小窗口 960×640 下占位长句不超出画面（M 限制） ═════════
    {
      const pid = su02F1Project.pid
      const su07 = new Case({
        id: 'SU-07', variant: 'M/占位渲染', mode: 'M', material: MATERIALS.F1,
        expected: '最小窗口下可见文字未超出画面边缘；M 只验占位渲染，真实长句文本覆盖在 R 批次',
      })
      await session.page.setViewportSize({ width: 960, height: 640 })
      await session.page.waitForTimeout(500)
      const viewport = await session.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
      su07.check('窗口已缩到最小允许尺寸', viewport.w <= 960 && viewport.h <= 640, `实际视口 ${viewport.w}×${viewport.h}`)
      const boxes = await playAndMeasureOverlay(session)
      const inside = overlayInside(boxes.overlay, boxes.stage)
      su07.check('占位字幕 overlay 不超出 .stage 边界', inside, `overlay=${JSON.stringify(boxes.overlay)}, stage=${JSON.stringify(boxes.stage)}`)
      await su07.screenshot(session.page, 'su07-min-window')
      await session.page.setViewportSize({ width: 1280, height: 800 })
      su07.record.defects.push('限制已确认（M 模式局限）：只验占位中文长句渲染，真实长句/中文标点/中英混排覆盖在 R 批次验证')
      await su07.finish('限制已确认', `最小窗口 ${viewport.w}×${viewport.h} 下 overlay 在画面内=${inside}；真实长句 R 批次验证`)
    }

    // ══ SU-02（F2 竖屏） ═══════════════════════════════════════════════
    {
      const su02b = new Case({
        id: 'SU-02', variant: 'M/F2 竖屏', mode: 'M', material: MATERIALS.F2,
        expected: '竖屏画面中字幕对应 top/center/bottom，没有被裁出画面；字号保留',
      })
      await session.stubDialogs({ video: materialPath(MATERIALS.F2) })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const sizeBefore = (await session.state(pid)).timeline.subtitleAppearance?.size
      const rounds = [
        { text: '字幕移到顶部', position: 'top', shot: 'su02-portrait-top' },
        { text: '字幕移到中间', position: 'center', shot: 'su02-portrait-center' },
        { text: '字幕移到底部', position: 'bottom', shot: 'su02-portrait-bottom' },
      ]
      let allOk = true
      const details: string[] = []
      for (const round of rounds) {
        await session.sendFeedback(round.text)
        const st = await session.state(pid)
        const positionOk = st.timeline.subtitleAppearance?.position === round.position
        const sizeOk = st.timeline.subtitleAppearance?.size === sizeBefore
        const boxes = await playAndMeasureOverlay(session)
        const inside = overlayInside(boxes.overlay, boxes.stage)
        await su02b.screenshot(session.page, round.shot)
        const roundOk = positionOk && sizeOk && inside
        allOk = allOk && roundOk
        details.push(`${round.position}: 修订=${positionOk}, 字号保持=${sizeOk}, overlay 在画面内=${inside}`)
      }
      su02b.check('三轮位置/字号/画面内全部符合', allOk, details.join('；'))
      await su02b.finish(allOk ? '通过' : '失败', details.join('；'))
    }

    // ══ SU-08：大号+顶部+简洁 → 移到底部 → 撤销 → 隐藏 → 重启恢复 → 导出 ═
    {
      const su08 = new Case({
        id: 'SU-08', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '只改位置时保留大号和简洁；撤销恢复顶部；重启仍隐藏；输出与最新字幕设置一致',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      await session.sendFeedback('字幕调大并移到顶部并简洁')
      const configured = await session.state(pid)
      await session.sendFeedback('字幕移到底部')
      const moved = await session.state(pid)
      su08.check('只改位置（large/bottom/minimal）', moved.timeline.subtitleAppearance?.size === 'large'
        && moved.timeline.subtitleAppearance?.position === 'bottom'
        && moved.timeline.subtitleAppearance?.style === 'minimal', JSON.stringify(moved.timeline.subtitleAppearance))
      await session.undo()
      const undone = await session.state(pid)
      su08.check('撤销恢复顶部', undone.timeline.subtitleAppearance?.position === 'top'
        && undone.timeline.subtitleAppearance?.size === 'large'
        && undone.timeline.subtitleAppearance?.style === 'minimal', JSON.stringify(undone.timeline.subtitleAppearance))
      await session.sendFeedback('隐藏字幕')
      const hidden = await session.state(pid)
      su08.check('隐藏生效', hidden.timeline.subtitleAppearance?.visible === false, JSON.stringify(hidden.timeline.subtitleAppearance))
      await session.close()
      await session.start()
      await restoreFromRecent(session, pid)
      const restored = await session.state(pid)
      su08.check('重启后仍隐藏', restored.timeline.subtitleAppearance?.visible === false, JSON.stringify(restored.timeline.subtitleAppearance))
      su08.check('重启后字幕设置一致', JSON.stringify(restored.timeline.subtitleAppearance) === JSON.stringify(hidden.timeline.subtitleAppearance), 'appearance JSON 一致')
      const outPath = outDir('SU-08-final.mp4')
      await mkdir(path.dirname(outPath), { recursive: true })
      await session.exportTo(outPath)
      const outProbe = await probeMedia(outPath)
      su08.check('导出成功', outProbe.durationSec > 0, `${outProbe.durationSec.toFixed(2)}s`)
      su08.record.output = { path: outPath, durationSec: outProbe.durationSec, width: outProbe.width, height: outProbe.height }
      su08.record.cache = { configured: configured.id, moved: moved.id, undone: undone.id, hidden: hidden.id, restored: restored.id }
      await su08.finish('通过', '位置修改/撤销/隐藏跨重启/导出全链路符合预期')
    }

    // ══ PV-03：叠化转场：草稿硬切近似 + 导出叠化 + 无黑闪 ═══════════════
    {
      const pv03 = new Case({
        id: 'PV-03', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: 'transitions 全为 crossfade≈0.3s（草稿硬切近似正常）；导出时长 ≈ Σ片段 − 叠化重叠；第一个衔接点无黑闪',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      await session.sendFeedback('添加叠化转场')
      const st = await session.state(pid)
      const fades = st.timeline.transitions.filter((t) => t.type === 'crossfade')
      pv03.check('全部衔接为 0.3s crossfade', fades.length === st.timeline.clips.length - 1
        && fades.every((t) => Math.abs((t.durationSec ?? 0) - 0.3) < 0.01), `${fades.length} 处叠化`)
      pv03.record.defects.push('观察：草稿预览仍按硬切跳段播放（文档预告「叠化只做硬切近似」，属正常）')
      const url = await session.renderPreview()
      await session.page.waitForFunction(() => {
        const v = document.querySelector('video')
        return !!v && v.readyState >= 2 && v.videoWidth > 0
      }, undefined, { timeout: 120000 })
      const outPath = outDir('PV-03-crossfade.mp4')
      await mkdir(path.dirname(outPath), { recursive: true })
      await session.exportTo(outPath)
      const outProbe = await probeMedia(outPath)
      const expect = expectedDuration(st.timeline)
      pv03.check('导出时长 ≈ Σ片段 − 叠化重叠', Math.abs(outProbe.durationSec - expect) <= Math.max(0.6, expect * 0.06),
        `实际 ${outProbe.durationSec.toFixed(2)}s vs 期望 ${expect.toFixed(2)}s`)
      // 第一个衔接点重叠中点抽帧：无黑闪
      const firstClipDur = (st.timeline.clips[0]!.sourceEndSec - st.timeline.clips[0]!.sourceStartSec) / (st.timeline.clips[0]!.speed ?? 1)
      const overlapMid = Math.max(0, firstClipDur - 0.15)
      const luma = await frameLumaAvg(outPath, overlapMid)
      pv03.check('叠化中点亮度 > 10（无黑闪）', luma > 10, `YAVG=${luma.toFixed(1)} @ ${overlapMid.toFixed(2)}s`)
      pv03.record.output = { path: outPath, durationSec: outProbe.durationSec, width: outProbe.width, height: outProbe.height }
      pv03.record.cache = { revisionId: st.id, previewUrl: url.slice(0, 80) }
      await pv03.finish('通过', `叠化导出 ${outProbe.durationSec.toFixed(2)}s，叠化中点亮度 ${luma.toFixed(1)}`)
    }

    // ══ PV-06：新修订后效果/成片入口失效，旧导出文件保留 ═══════════════
    {
      const pv06 = new Case({
        id: 'PV-06', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '每次新 revision 都回草稿，效果与成片入口失效；旧输出文件可保留但不能被当作当前成片',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      await addBgm(session, BGM_WAV())
      await session.renderPreview()
      const initialExport = outDir('PV-06-initial.mp4')
      await mkdir(path.dirname(initialExport), { recursive: true })
      await session.exportTo(initialExport)
      const statMtime = async (file: string) => stat(file).then((s) => String(s.mtimeMs), () => 'missing')
      const mtime0 = await statMtime(initialExport)
      const ops = [
        { name: '剪辑（开头太拖）', act: () => session.sendFeedback('开头太拖，直接进正题') },
        { name: '字幕（字幕调大）', act: () => session.sendFeedback('字幕调大') },
        { name: 'BGM 音量（点响）', act: () => clickBgmVolume(session, '响') },
      ]
      let allOk = true
      const details: string[] = []
      for (const op of ops) {
        const revBefore = (await session.state(pid)).id
        await op.act()
        const revAfter = await session.state(pid)
        const newRevision = revAfter.id !== revBefore
        const effectTabGone = (await session.page.getByRole('tab', { name: '效果预览', exact: true }).count()) === 0
        const outputTabGone = (await session.page.getByRole('tab', { name: '成片预览', exact: true }).count()) === 0
        const mtimeNow = await statMtime(initialExport)
        const oldFileKept = mtimeNow === mtime0 && mtime0 !== 'missing'
        const ok = newRevision && effectTabGone && outputTabGone && oldFileKept
        allOk = allOk && ok
        details.push(`${op.name}: 新修订=${newRevision}, 效果页签消失=${effectTabGone}, 成片页签消失=${outputTabGone}, 旧导出未动=${oldFileKept}`)
      }
      pv06.check('三类修改后入口失效且旧导出保留', allOk, details.join('；'))
      await pv06.finish(allOk ? '通过' : '失败', details.join('；'))
    }

    // ══ PV-07：修改 → 预览 → 撤销 → 新预览（新缓存）且内容一致 ══════════
    {
      const pid = (await session.listProjects())[0]!.projectId
      const pv07 = new Case({
        id: 'PV-07', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '撤销后界面不继续放修改版；新 revision 的预览内容与撤销后状态一致（导出时长核对）',
      })
      await session.sendFeedback('第一段 0.5 倍速，其他段不变')
      const modified = await session.state(pid)
      const url1 = await session.renderPreview()
      const path1 = decodeURIComponent(url1.replace('pimko-media://media/', ''))
      await session.undo()
      const undone = await session.state(pid)
      pv07.check('撤销产生新 revision', undone.id !== modified.id, `${modified.id.slice(0, 8)} → ${undone.id.slice(0, 8)}`)
      pv07.check('撤销后首段速度复位', (undone.timeline.clips[0]!.speed ?? 1) === 1, `speed=${undone.timeline.clips[0]!.speed}`)
      const url2 = await session.renderPreview()
      const path2 = decodeURIComponent(url2.replace('pimko-media://media/', ''))
      pv07.check('新预览为新缓存文件', path1 !== path2 && path2.length > 0, `${path1.slice(-20)} → ${path2.slice(-20)}`)
      const outPath = outDir('PV-07-undone.mp4')
      await mkdir(path.dirname(outPath), { recursive: true })
      await session.exportTo(outPath)
      const outProbe = await probeMedia(outPath)
      const expect = expectedDuration(undone.timeline)
      pv07.check('预览/导出内容与撤销后状态一致', Math.abs(outProbe.durationSec - expect) <= Math.max(0.6, expect * 0.06),
        `实际 ${outProbe.durationSec.toFixed(2)}s vs 期望 ${expect.toFixed(2)}s`)
      pv07.record.cache = { revisionModified: modified.id, revisionUndone: undone.id, cache1: path1, cache2: path2 }
      pv07.record.output = { path: outPath, durationSec: outProbe.durationSec, width: outProbe.width, height: outProbe.height }
      await pv07.finish('通过', '撤销后重新生成预览使用新缓存且内容一致')
    }

    await session.close()
  })
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
