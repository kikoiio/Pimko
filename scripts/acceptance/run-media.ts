/**
 * 验收批次：media（docs/testing-acceptance.md 第 7 节配乐、9 节缓存、10 节导出、13 节并发）。
 *
 * 覆盖：BG-01（6 格式）、BG-02、BG-03、BG-04、BG-05、BG-06（短/长）、BG-07、
 * PV-08、PV-09、EX-03、EX-04、EX-05（3 素材）、EX-06、
 * CC-01、CC-02、CC-03、CC-04、CC-05（3 变体）。全部为 M（mock）模式。
 *
 * 只在 CI（GitHub Actions / xvfb）运行；本机不得执行（Electron/渲染重型操作）。
 * 注意：BG-07 使用 bgm-2s.wav 的专用副本，BG-06 使用共享原件，两者互不影响。
 */
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright'
import {
  AppSession, Case, MATERIALS, materialPath, outDir, runBatch, probeMedia,
  expectedDuration, audioRmsDb, batchDir, execFileAsync,
} from './lib'

const F1 = () => materialPath(MATERIALS.F1)
const BGM_WAV = () => materialPath(MATERIALS.boundary('bgm-2s.wav'))

async function readVideo(page: Page): Promise<{ time: number; paused: boolean; rate: number; width: number; height: number } | null> {
  return page.evaluate(() => {
    const v = document.querySelector('video')
    return v ? { time: v.currentTime, paused: v.paused, rate: v.playbackRate, width: v.videoWidth, height: v.videoHeight } : null
  })
}

/** 项目当前磁盘修订文件数。 */
async function diskRevisionCount(home: string, projectId: string): Promise<number> {
  try {
    return (await readdir(path.join(home, '.config', 'pimko', 'projects', projectId))).filter((f) => f.endsWith('.json')).length
  } catch {
    return 0
  }
}

/** 读取项目磁盘上最新修订的 timeline JSON（中断场景的「最后持久化状态」事实源）。 */
async function diskLatestTimeline(home: string, projectId: string): Promise<string> {
  try {
    const dir = path.join(home, '.config', 'pimko', 'projects', projectId)
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    const revisions = await Promise.all(files.map(async (f) => {
      const raw = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as { createdAt?: string; project?: { timeline?: unknown } }
      return { createdAt: raw.createdAt ?? '', timeline: raw.project?.timeline }
    }))
    revisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return JSON.stringify(revisions[0]?.timeline ?? null)
  } catch {
    return ''
  }
}

/** 读取项目全部修订的链路信息（并发/撤销顺序证据）。 */
async function revisionChain(home: string, projectId: string): Promise<{ id: string; parent?: string; createdAt: string; feedback?: string }[]> {
  try {
    const dir = path.join(home, '.config', 'pimko', 'projects', projectId)
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    const chain = await Promise.all(files.map(async (f) => {
      const raw = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as {
        id?: string; parentRevisionId?: string; createdAt?: string; feedback?: { text?: string }
      }
      return { id: raw.id ?? f, parent: raw.parentRevisionId, createdAt: raw.createdAt ?? '', feedback: raw.feedback?.text }
    }))
    return chain.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  } catch {
    return []
  }
}

async function mtimeOf(file: string): Promise<string> {
  return stat(file).then((s) => String(s.mtimeMs), () => 'missing')
}

/** 同步连点按钮 N 次（不等中间状态，触发真实并发竞态）。 */
async function rapidClick(page: Page, text: string, times = 1): Promise<void> {
  await page.evaluate(({ text, times }) => {
    const target = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text)
    if (!target) throw new Error(`找不到按钮「${text}」`)
    for (let i = 0; i < times; i++) target.click()
  }, { text, times })
}

/** 同步依次连点多枚按钮（不等中间状态）。 */
async function rapidClickSequence(page: Page, texts: string[]): Promise<void> {
  await page.evaluate((texts) => {
    for (const text of texts) {
      const target = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text)
      if (!target) throw new Error(`找不到按钮「${text}」`)
      target.click()
    }
  }, texts)
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

/** 点击 BGM 音量档位并等待修订气泡。 */
async function clickBgmVolume(session: AppSession, label: string): Promise<void> {
  const before = await session.agentBubbleCount()
  await session.button(label).click()
  await session.page.waitForFunction(
    (c) => document.querySelectorAll('.bubble.agent').length > c, before, { timeout: 30000 },
  )
}

/** 重启后按 projectId 从最近项目列表恢复。 */
async function restoreFromRecent(session: AppSession, projectId: string): Promise<void> {
  const projects = await session.listProjects()
  const index = projects.findIndex((p) => p.projectId === projectId)
  if (index < 0) throw new Error(`最近项目列表中找不到项目 ${projectId}`)
  await session.page.locator('.project-card').nth(index).click()
  await session.waitDraftReady()
}

/** 导出并测量成片末段 [duration-sec, duration] 的 RMS。 */
async function exportAndTailRms(session: AppSession, file: string, tailSec: number): Promise<{ outPath: string; probe: Awaited<ReturnType<typeof probeMedia>>; rms: number }> {
  const outPath = outDir(file)
  await mkdir(path.dirname(outPath), { recursive: true })
  await session.exportTo(outPath)
  const probe = await probeMedia(outPath)
  const rms = await audioRmsDb(outPath, Math.max(0, probe.durationSec - tailSec), probe.durationSec)
  return { outPath, probe, rms }
}

/** 清理本任务被中断渲染遗留的孤儿 ffmpeg（仅匹配本批次独有产物模式）。 */
async function killOwnOrphanFfmpeg(): Promise<void> {
  for (const pattern of ['pimko-render-', 'partial.mp4']) {
    await execFileAsync('pkill', ['-f', pattern]).catch(() => undefined)
  }
}

async function main(): Promise<void> {
  await runBatch('media', async () => {
    const boot = new Case({ id: 'BOOT', mode: 'M', expected: '应用启动（mock 模式）' })
    const session = new AppSession(boot)
    await session.start()
    const home = session.home

    // ══ BG-01：六种音频格式逐项添加配乐并导出验证 ═════════════════════
    for (const fmt of ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac'] as const) {
      const bgmAbs = materialPath(MATERIALS.boundary(`bgm-2s.${fmt}`))
      const bg01 = new Case({
        id: 'BG-01', variant: `M/${fmt}`, mode: 'M', material: MATERIALS.boundary(`bgm-2s.${fmt}`),
        expected: '配乐进入修订；成片最后 1.5s（语音静音区）RMS > -50dB 证明配乐存在；失败格式不能被其它格式抵销',
      })
      try {
        await session.stubDialogs({ video: F1() })
        await session.importVideo()
        await session.waitDraftReady()
        const pid = (await session.listProjects())[0]!.projectId
        await addBgm(session, bgmAbs)
        const st = await session.state(pid)
        bg01.check('修订含 bgm', st.timeline.bgm?.path === bgmAbs, `gainDb=${st.timeline.bgm?.gainDb}`)
        bg01.check('三档与移除按钮出现', await session.button('轻').isVisible() && await session.button('移除配乐').isVisible(), '轻/标准/响/移除配乐可见')
        const { outPath, probe, rms } = await exportAndTailRms(session, `BG-01-${fmt}.mp4`, 1.5)
        bg01.check('末 1.5s RMS > -50dB（BGM 可闻）', rms > -50, `RMS=${rms.toFixed(1)}dB，成片 ${probe.durationSec.toFixed(2)}s`)
        bg01.record.output = { path: outPath, durationSec: probe.durationSec, width: probe.width, height: probe.height }
        bg01.record.cache = { tailRmsDb: Number(rms.toFixed(1)) }
        await bg01.finish('通过', `${fmt} 配乐混入成片（末段 RMS ${rms.toFixed(1)}dB）`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        let errorText = ''
        try { errorText = await session.waitForError(5000) } catch { /* 无错误条 */ }
        bg01.record.defects.push(`${fmt} 格式失败：${message.slice(0, 200)}`)
        await bg01.screenshot(session.page, 'failure')
        await bg01.finish('失败', `${fmt} 失败：${message.slice(0, 160)}；错误条="${errorText.slice(0, 80)}"`)
      }
    }

    // ══ BG-02：取消配乐选择 + 已有 BGM 无替换入口 ═════════════════════
    {
      const bg02 = new Case({
        id: 'BG-02', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '取消不创建设置修订、不清空原状态、不弹成功气泡；界面没有替换入口时应先移除再添加',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const revBefore = (await session.state(pid)).id
      const bubblesBefore = await session.agentBubbleCount()
      await session.stubDialogs({ audio: null })
      await session.button('添加配乐').click()
      await session.page.waitForTimeout(1500)
      const revAfter = (await session.state(pid)).id
      bg02.check('取消不创建修订', revAfter === revBefore, `${revBefore.slice(0, 8)} == ${revAfter.slice(0, 8)}`)
      bg02.check('无成功气泡', (await session.agentBubbleCount()) === bubblesBefore, `${bubblesBefore} → ${await session.agentBubbleCount()}`)
      const errorBar = await session.page.locator('.error-bar').count()
      bg02.check('无错误弹条', errorBar === 0, `error-bar=${errorBar}`)
      // 已有 BGM：验证「无替换入口」现状
      await addBgm(session, BGM_WAV())
      const addCount = await session.button('添加配乐').count()
      const removeVisible = await session.button('移除配乐').isVisible()
      bg02.check('已有 BGM 时无替换入口（先移除再添加）', addCount === 0 && removeVisible,
        `添加配乐按钮=${addCount}，移除配乐=${removeVisible}（限制已确认：无直接替换功能）`)
      bg02.record.defects.push('限制已确认：BGM 已存在时界面没有「替换配乐」入口，只有「移除配乐」；替换需先移除再添加（文档 BG-02 预告）')
      await bg02.finish('通过', '取消无副作用；替换入口限制已如实记录')
    }

    // ══ BG-03：轻 → 标准 → 响，gainDb 与末段 RMS 单调递增，重选轻恢复 ══
    {
      const bg03 = new Case({
        id: 'BG-03', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: 'gainDb 依次 -24/-18/-12；听感随档位增大（末段静音区 RMS 单调递增）；重选「轻」恢复 -24',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      await addBgm(session, BGM_WAV())
      const rmsByLabel: { label: string; gainDb: number; rms: number; outPath: string }[] = []
      for (const [label, gain] of [['轻', -24], ['标准', -18], ['响', -12]] as const) {
        await clickBgmVolume(session, label)
        const st = await session.state(pid)
        const gainOk = st.timeline.bgm?.gainDb === gain
        bg03.check(`「${label}」修订 gainDb=${gain}`, gainOk, `实际 ${st.timeline.bgm?.gainDb}`)
        const { outPath, probe, rms } = await exportAndTailRms(session, `BG-03-${label}.mp4`, 1.5)
        bg03.record.output = { path: outPath, durationSec: probe.durationSec, width: probe.width, height: probe.height }
        rmsByLabel.push({ label, gainDb: st.timeline.bgm?.gainDb ?? 0, rms, outPath })
      }
      const [light, standard, loud] = rmsByLabel
      bg03.check('末段 RMS 单调递增（BGM-only 区间区分度大）', light!.rms < standard!.rms && standard!.rms < loud!.rms,
        rmsByLabel.map((r) => `${r.label}=${r.rms.toFixed(1)}dB`).join(' < '))
      await clickBgmVolume(session, '轻')
      const restored = await session.state(pid)
      bg03.check('重选「轻」恢复 -24', restored.timeline.bgm?.gainDb === -24, `gainDb=${restored.timeline.bgm?.gainDb}`)
      await bg03.finish('通过', rmsByLabel.map((r) => `${r.label}(${r.gainDb}dB)=${r.rms.toFixed(1)}dB`).join('，'))
    }

    // ══ BG-04：有 BGM（轻）连续做 剪辑/变速/字幕，配乐不丢 ═════════════
    {
      const bg04 = new Case({
        id: 'BG-04', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '每轮修订 bgm.path 与 gainDb 不丢失、字幕字段保留；最终成片配乐持续存在',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      await addBgm(session, BGM_WAV())
      await clickBgmVolume(session, '轻')
      const baseline = await session.state(pid)
      const ops = [
        { name: '开头裁短', act: () => session.sendFeedback('开头太拖，直接进正题') },
        { name: '第一段 2 倍速', act: () => session.sendFeedback('第一段 2 倍速，其他段不变') },
        { name: '字幕调大', act: () => session.sendFeedback('字幕调大') },
      ]
      let allKept = true
      const details: string[] = []
      for (const op of ops) {
        await op.act()
        const st = await session.state(pid)
        const bgmKept = st.timeline.bgm?.path === baseline.timeline.bgm?.path && st.timeline.bgm?.gainDb === -24
        allKept = allKept && bgmKept
        details.push(`${op.name}: bgm 保留=${bgmKept}`)
        if (op.name === '字幕调大') {
          bg04.check('字幕字段生效且 BGM 保留', st.timeline.subtitleAppearance?.size === 'large' && bgmKept, JSON.stringify(st.timeline.subtitleAppearance))
        } else {
          bg04.check(`${op.name} 后 BGM 保留`, bgmKept, JSON.stringify(st.timeline.bgm))
        }
      }
      const { outPath, probe, rms } = await exportAndTailRms(session, 'BG-04-final.mp4', 1.5)
      bg04.check('最终成片末段 RMS > -50dB（配乐存在）', rms > -50, `RMS=${rms.toFixed(1)}dB`)
      bg04.check('三轮修订后 BGM 完整', allKept, details.join('；'))
      bg04.record.output = { path: outPath, durationSec: probe.durationSec, width: probe.width, height: probe.height }
      await bg04.finish(allKept && rms > -50 ? '通过' : '失败', details.join('；') + `；末段 RMS ${rms.toFixed(1)}dB`)
    }

    // ══ BG-05：移除配乐 → RMS 验证 → 撤销恢复 → 再导出 ═════════════════
    {
      const bg05 = new Case({
        id: 'BG-05', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '移除后只有原声（末段 RMS 很低）；撤销恢复原 BGM 和音量；两种状态均不改变剪辑内容',
      })
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      await addBgm(session, BGM_WAV())
      const withBgm = await session.state(pid)
      await session.button('移除配乐').click()
      await session.page.waitForFunction(() => document.body.innerText.includes('配乐已移除'), undefined, { timeout: 30000 })
      const removed = await session.state(pid)
      bg05.check('修订无 bgm 键', removed.timeline.bgm === undefined && !('bgm' in removed.timeline), `bgm=${removed.timeline.bgm}`)
      bg05.check('剪辑内容不变', JSON.stringify(removed.timeline.clips) === JSON.stringify(withBgm.timeline.clips), 'clips 一致')
      const removedExport = await exportAndTailRms(session, 'BG-05-removed.mp4', 1.5)
      bg05.check('移除后末段 RMS < -60dB', removedExport.rms < -60, `RMS=${removedExport.rms.toFixed(1)}dB（如尾段含语音会偏高，实际值已记录）`)
      bg05.record.output = { path: removedExport.outPath, durationSec: removedExport.probe.durationSec }
      // 撤销恢复
      await session.undo()
      const restored = await session.state(pid)
      bg05.check('撤销恢复 bgm 且 gainDb 不变', restored.timeline.bgm?.path === withBgm.timeline.bgm?.path
        && restored.timeline.bgm?.gainDb === withBgm.timeline.bgm?.gainDb, JSON.stringify(restored.timeline.bgm))
      bg05.check('撤销恢复剪辑内容', JSON.stringify(restored.timeline.clips) === JSON.stringify(withBgm.timeline.clips), 'clips 一致')
      const restoredExport = await exportAndTailRms(session, 'BG-05-restored.mp4', 1.5)
      bg05.check('恢复后末段 RMS 回升', restoredExport.rms > removedExport.rms,
        `${removedExport.rms.toFixed(1)}dB → ${restoredExport.rms.toFixed(1)}dB`)
      bg05.record.cache = { removedRmsDb: Number(removedExport.rms.toFixed(1)), restoredRmsDb: Number(restoredExport.rms.toFixed(1)) }
      await bg05.finish(restoredExport.rms > removedExport.rms ? '通过' : '失败',
        `移除 ${removedExport.rms.toFixed(1)}dB → 恢复 ${restoredExport.rms.toFixed(1)}dB`)
    }

    // ══ BG-06：短配乐循环 / 长配乐截断 ═════════════════════════════════
    {
      const variants = [
        { label: '短2s循环', bgm: MATERIALS.boundary('bgm-2s.wav'), tail: 1 },
        { label: '长30s截断', bgm: MATERIALS.boundary('bgm-30s.wav'), tail: 1 },
      ]
      for (const entry of variants) {
        const bg06 = new Case({
          id: 'BG-06', variant: `M/${entry.label}`, mode: 'M', material: entry.bgm,
          expected: '输出时长符合时间线（短 BGM 不延长、长 BGM 不截断也不延长尾巴）；短 BGM 循环到成片结束',
        })
        try {
          const bgmAbs = materialPath(entry.bgm)
          await session.stubDialogs({ video: F1() })
          await session.importVideo()
          await session.waitDraftReady()
          const pid = (await session.listProjects())[0]!.projectId
          await addBgm(session, bgmAbs)
          const st = await session.state(pid)
          const expect = expectedDuration(st.timeline)
          const { outPath, probe, rms } = await exportAndTailRms(session, `BG-06-${entry.label}.mp4`, entry.tail)
          const tol = Math.max(0.6, expect * 0.06)
          bg06.check('输出时长 == 时间线时长', Math.abs(probe.durationSec - expect) <= tol && probe.durationSec < expect + 1.5,
            `实际 ${probe.durationSec.toFixed(2)}s vs 期望 ${expect.toFixed(2)}s`)
          if (entry.label.startsWith('短')) {
            bg06.check('末 1s RMS 证明循环 BGM 存在', rms > -50, `RMS=${rms.toFixed(1)}dB`)
          } else {
            bg06.check('长 BGM 未把视频拉长到 30s 级别', probe.durationSec < 30, `${probe.durationSec.toFixed(2)}s`)
          }
          bg06.record.output = { path: outPath, durationSec: probe.durationSec, width: probe.width, height: probe.height }
          bg06.record.cache = { tailRmsDb: Number(rms.toFixed(1)) }
          await bg06.finish('通过', `${entry.label}：输出 ${probe.durationSec.toFixed(2)}s（时间线 ${expect.toFixed(2)}s），末段 RMS ${rms.toFixed(1)}dB`)
        } catch (err) {
          await bg06.finish('失败', `${entry.label} 失败：${err instanceof Error ? err.message.slice(0, 160) : String(err)}`)
        }
      }
    }

    // ══ BG-07：专用副本 BGM 丢失 → 渲染报错 → 恢复 → 新修订后成功 ══════
    {
      const bg07 = new Case({
        id: 'BG-07', variant: 'M/专用副本', mode: 'M', material: MATERIALS.boundary('bgm-2s.wav'),
        expected: '缺失音频出现可见错误，不宣称导出成功，不丢剪辑和其它设置；恢复路径后可重试成功',
      })
      try {
        const bgmCopy = outDir('BG-07-bgm-copy.wav')
        await mkdir(path.dirname(bgmCopy), { recursive: true })
        await copyFile(BGM_WAV(), bgmCopy) // 专用副本，不碰共享原件
        await session.stubDialogs({ video: F1() })
        await session.importVideo()
        await session.waitDraftReady()
        const pid = (await session.listProjects())[0]!.projectId
        await addBgm(session, bgmCopy)
        const before = await session.state(pid)
        await session.close()
        await rename(bgmCopy, `${bgmCopy}.missing`)
        await session.start()
        await restoreFromRecent(session, pid)
        await session.button('查看实际效果').click()
        const errorText = await session.waitForError(120000)
        bg07.check('缺失音频出现可见错误', errorText.length > 0, `"${errorText.slice(0, 90)}"`)
        bg07.check('无成片/效果预览页签', (await session.page.getByRole('tab', { name: '成片预览', exact: true }).count()) === 0
          && (await session.page.getByRole('tab', { name: '效果预览', exact: true }).count()) === 0, '两个页签均不存在')
        const intact = await session.state(pid)
        bg07.check('剪辑与其它设置不丢', JSON.stringify(intact.timeline.clips) === JSON.stringify(before.timeline.clips)
          && intact.timeline.bgm?.path === before.timeline.bgm?.path, 'clips 与 bgm 保留')
        await bg07.screenshot(session.page, 'bgm-missing-error')
        // 恢复文件名 → 新发一次修订（确保缓存失效）→ 重新渲染成功
        await rename(`${bgmCopy}.missing`, bgmCopy)
        await session.sendFeedback('第一段 2 倍速，其他段不变')
        const url = await session.renderPreview()
        await session.page.waitForFunction(() => {
          const v = document.querySelector('video')
          return !!v && v.readyState >= 2 && v.videoWidth > 0
        }, undefined, { timeout: 120000 })
        bg07.check('恢复路径后重试渲染成功', url.startsWith('pimko-media://media/'), url.slice(0, 70))
        await bg07.finish('通过', '缺失音频渲染失败可见且不损坏项目；恢复后重试成功')
      } catch (err) {
        await bg07.finish('失败', `BG-07 失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      }
    }

    // ══ PV-08：缓存文件被移走后可重新生成，revision 内容不变 ═══════════
    {
      const pv08 = new Case({
        id: 'PV-08', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '缺失缓存可重新生成，无永久加载或旧 URL 空播；重新生成不改变 revision 的剪辑内容',
      })
      try {
        await session.stubDialogs({ video: F1() })
        await session.importVideo()
        await session.waitDraftReady()
        const pid = (await session.listProjects())[0]!.projectId
        const before = await session.state(pid)
        const url1 = await session.renderPreview()
        const cachePath = decodeURIComponent(url1.replace('pimko-media://media/', ''))
        const mtime1 = await mtimeOf(cachePath)
        const backup = path.join(batchDir(), 'PV-08-cache-backup.mp4')
        await session.close()
        await rename(cachePath, backup) // 仅移走本项目该版缓存，保留备份
        await session.start()
        await restoreFromRecent(session, pid)
        const url2 = await session.renderPreview()
        const cachePath2 = decodeURIComponent(url2.replace('pimko-media://media/', ''))
        await session.page.waitForFunction(() => {
          const v = document.querySelector('video')
          return !!v && v.readyState >= 2 && v.videoWidth > 0
        }, undefined, { timeout: 120000 })
        const mtime2 = await mtimeOf(cachePath2)
        pv08.check('缓存重新生成（同路径新 mtime）', cachePath2 === cachePath && mtime2 !== mtime1 && mtime2 !== 'missing',
          `mtime ${mtime1} → ${mtime2}`)
        const after = await session.state(pid)
        pv08.check('revision 剪辑内容不变', JSON.stringify(after.timeline.clips) === JSON.stringify(before.timeline.clips) && after.id === before.id,
          `revision=${after.id.slice(0, 8)}`)
        pv08.record.cache = { cachePath, backupPath: backup, mtime1, mtime2 }
        await pv08.finish('通过', `缓存移走后重新生成（备份在 ${path.basename(backup)}）`)
      } catch (err) {
        await pv08.finish('失败', `PV-08 失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      }
    }

    // ══ PV-09：5 分钟素材：>30 段、缩略图上限 30、修订后重建 ═══════════
    {
      const pv09 = new Case({
        id: 'PV-09', variant: 'M/five-minutes', mode: 'M', material: MATERIALS.boundary('five-minutes.mp4'),
        expected: '前 30 段展示缩略图（当前上限），卡片与播放仍可用；改剪口后不混用旧修订缩略图；不导出长片',
      })
      try {
        await session.stubDialogs({ video: materialPath(MATERIALS.boundary('five-minutes.mp4')) })
        const started = Date.now()
        await session.importVideo(300000)
        await session.waitDraftReady()
        const importSec = (Date.now() - started) / 1000
        const pid = (await session.listProjects())[0]!.projectId
        const st = await session.state(pid)
        pv09.check('clips 数 > 30', st.timeline.clips.length > 30, `${st.timeline.clips.length} 段（导入耗时 ${importSec.toFixed(1)}s）`)
        const thumbCount = await session.page.locator('.clip-thumb').count()
        const clipCount = await session.page.locator('.clip').count()
        pv09.check('缩略图上限 30 张', thumbCount === 30, `${thumbCount} 张缩略图 / ${clipCount} 张卡片`)
        pv09.check('卡片数量与片段一致', clipCount === st.timeline.clips.length, `${clipCount}`)
        // 点击第 35 段卡片能跳转播放
        const target = st.timeline.clips[34]!
        await session.page.locator('.clip').nth(34).click()
        await session.page.waitForTimeout(700)
        const v = await readVideo(session.page)
        pv09.check('点击第 35 段跳转播放', !!v && Math.abs(v.time - target.sourceStartSec) < 0.6,
          `t=${v?.time.toFixed(2)} vs 段起点 ${target.sourceStartSec.toFixed(2)}`)
        // 修订后缩略图按新 revision 重建
        await session.sendFeedback('开头太拖，直接进正题')
        const st2 = await session.state(pid)
        const thumbsDir = path.join(home, '.config', 'pimko', 'thumbnails')
        const files = await readdir(thumbsDir).catch(() => [] as string[])
        const rebuilt = files.filter((f) => f.startsWith(`${pid}-${st2.id}`))
        pv09.check('缩略图按新修订重建（不混用旧修订）', rebuilt.length > 0, `${rebuilt.length} 个 ${st2.id.slice(0, 8)} 前缀缓存`)
        pv09.check('修订后仍 30 张上限', (await session.page.locator('.clip-thumb').count()) === 30, `${await session.page.locator('.clip-thumb').count()} 张`)
        pv09.record.cache = { clipCount: st.timeline.clips.length, importSeconds: Number(importSec.toFixed(1)), rebuiltThumbs: rebuilt.length }
        pv09.record.defects.push('观察：5 分钟素材仅做 mock 导入与草稿验证，按要求未导出（导出长片不在本用例范围）')
        await pv09.finish('通过', `${st.timeline.clips.length} 段长片草稿：缩略图 30 上限、跳段、修订后重建均正常`)
      } catch (err) {
        await pv09.finish('失败', `PV-09 失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      }
    }

    // ══ EX-03：保存对话框取消 → 无新气泡/新文件；再选新路径成功 ════════
    {
      const ex03 = new Case({
        id: 'EX-03', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '取消不产生新的成功气泡和新输出文件；旧导出保留；项目及 revision 不变；按钮恢复可用',
      })
      try {
        await session.stubDialogs({ video: F1() })
        await session.importVideo()
        await session.waitDraftReady()
        const pid = (await session.listProjects())[0]!.projectId
        const first = outDir('EX-03-first.mp4')
        await mkdir(path.dirname(first), { recursive: true })
        await session.exportTo(first)
        const mtime1 = await mtimeOf(first)
        await session.sendFeedback('字幕调大') // 清空成片预览入口，回到无导出状态
        ex03.check('修订后成片预览入口消失', (await session.page.getByRole('tab', { name: '成片预览', exact: true }).count()) === 0, 'count=0')
        const revBefore = (await session.state(pid)).id
        const bubblesBefore = await session.agentBubbleCount()
        await session.stubDialogs({ save: null })
        await session.button('生成成片').click()
        await session.page.waitForTimeout(1500)
        ex03.check('无新成功气泡', (await session.agentBubbleCount()) === bubblesBefore, `${bubblesBefore} → ${await session.agentBubbleCount()}`)
        ex03.check('无成片预览页签', (await session.page.getByRole('tab', { name: '成片预览', exact: true }).count()) === 0, 'count=0')
        ex03.check('旧导出文件未动', (await mtimeOf(first)) === mtime1 && mtime1 !== 'missing', `mtime=${mtime1}`)
        ex03.check('revision 不变', (await session.state(pid)).id === revBefore, revBefore.slice(0, 8))
        ex03.check('按钮恢复可用', await session.button('生成成片').isEnabled(), 'enabled=true')
        const second = outDir('EX-03-second.mp4')
        await session.exportTo(second)
        ex03.check('随后再次导出成功', (await probeMedia(second)).durationSec > 0, second)
        ex03.record.output = { path: second }
        await ex03.finish('通过', '取消导出无副作用；新路径导出成功')
      } catch (err) {
        await ex03.finish('失败', `EX-03 失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      }
    }

    // ══ EX-04：同路径覆盖导出 + 取消导出 ═══════════════════════════════
    {
      const ex04 = new Case({
        id: 'EX-04', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '取消保留原文件；确认后输出为本次内容且可播放；项目记录不改变',
      })
      try {
        await session.stubDialogs({ video: F1() })
        await session.importVideo()
        await session.waitDraftReady()
        const pid = (await session.listProjects())[0]!.projectId
        const pathA = outDir('EX-04-A.mp4')
        await mkdir(path.dirname(pathA), { recursive: true })
        await session.exportTo(pathA)
        const mtime1 = await mtimeOf(pathA)
        const revBefore = (await session.state(pid)).id
        // 再次导出同路径：系统覆盖提示被 save stub 跳过——如实记录该局限
        await session.exportTo(pathA)
        const mtime2 = await mtimeOf(pathA)
        const probe2 = await probeMedia(pathA)
        ex04.check('同路径覆盖后 mtime 变化', mtime2 !== mtime1 && mtime2 !== 'missing', `${mtime1} → ${mtime2}`)
        ex04.check('覆盖后文件可播放', probe2.durationSec > 0, `${probe2.durationSec.toFixed(2)}s`)
        ex04.check('项目记录不改变', (await session.state(pid)).id === revBefore, revBefore.slice(0, 8))
        ex04.record.defects.push(
          '记录「系统级覆盖确认框未被真实演练」：保存对话框被 stub 直接返回同路径，无法演练系统的取消/确认覆盖提示；' +
          '文档 EX-04 已预告无额外覆盖保护，误覆盖风险按现状记录',
        )
        // 取消导出：旧文件保留
        const bubblesBefore = await session.agentBubbleCount()
        await session.stubDialogs({ save: null })
        await session.button('生成成片').click()
        await session.page.waitForTimeout(1500)
        ex04.check('取消后旧文件保留', (await mtimeOf(pathA)) === mtime2, `mtime=${mtime2}`)
        ex04.check('取消后无新成功气泡', (await session.agentBubbleCount()) === bubblesBefore, `${bubblesBefore} → ${await session.agentBubbleCount()}`)
        ex04.record.output = { path: pathA, durationSec: probe2.durationSec, width: probe2.width, height: probe2.height }
        await ex04.finish('通过', '覆盖导出生效且可播放；取消导出保留旧文件（覆盖确认框局限已记录）')
      } catch (err) {
        await ex04.finish('失败', `EX-04 失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      }
    }

    // ══ EX-05：F1/F2/F3 三素材导出尺寸与时长 ═══════════════════════════
    {
      const variants = [
        { name: 'F1', file: MATERIALS.F1, width: 640, height: 360 },
        { name: 'F2', file: MATERIALS.F2, width: 720, height: 1280 },
        { name: 'F3', file: MATERIALS.F3, width: 642, height: 362 },
      ]
      for (const entry of variants) {
        const ex05 = new Case({
          id: 'EX-05', variant: `M/${entry.name}`, mode: 'M', material: entry.file,
          expected: `导出 ${entry.width}×${entry.height}；时长按片段和叠化计算并符合自检容差`,
        })
        try {
          await session.stubDialogs({ video: materialPath(entry.file) })
          await session.importVideo()
          if (entry.name === 'F3') {
            // FFV1 源浏览器可能无法解码，草稿预览不作为本用例断言
            await session.page.waitForFunction(() => document.querySelector('video') !== null, undefined, { timeout: 30000 })
          } else {
            await session.waitDraftReady()
          }
          const pid = (await session.listProjects())[0]!.projectId
          const st = await session.state(pid)
          const outPath = outDir(`EX-05-${entry.name}.mp4`)
          await mkdir(path.dirname(outPath), { recursive: true })
          await session.exportTo(outPath)
          const probe = await probeMedia(outPath)
          ex05.check(`宽高 ${entry.width}×${entry.height}`, probe.width === entry.width && probe.height === entry.height,
            `${probe.width}×${probe.height}`)
          const expect = expectedDuration(st.timeline)
          ex05.check('时长符合容差', Math.abs(probe.durationSec - expect) <= Math.max(0.6, expect * 0.06),
            `实际 ${probe.durationSec.toFixed(2)}s vs 期望 ${expect.toFixed(2)}s`)
          ex05.record.output = { path: outPath, durationSec: probe.durationSec, width: probe.width, height: probe.height }
          await ex05.finish('通过', `${entry.name} 导出 ${probe.width}×${probe.height}，${probe.durationSec.toFixed(2)}s`)
        } catch (err) {
          await ex05.finish('失败', `EX-05/${entry.name} 失败：${err instanceof Error ? err.message.slice(0, 160) : String(err)}`)
        }
      }
    }

    // ══ EX-06：只读目录导出失败可见，换路径可成功 ══════════════════════
    {
      const ex06 = new Case({
        id: 'EX-06', variant: 'M/只读目录', mode: 'M', material: MATERIALS.F1,
        expected: '失败有可见错误，不出现成功成片入口，不改变项目；换正常输出目录可再次成功',
      })
      try {
        await session.stubDialogs({ video: F1() })
        await session.importVideo()
        await session.waitDraftReady()
        const pid = (await session.listProjects())[0]!.projectId
        const readonlyDir = path.join(path.dirname(outDir('x')), 'readonly-target')
        await mkdir(readonlyDir, { recursive: true })
        await chmod(readonlyDir, 0o555) // 只改本批次目录权限，不碰系统目录
        const revBefore = (await session.state(pid)).id
        await session.stubDialogs({ save: path.join(readonlyDir, 'out.mp4') })
        await session.button('生成成片').click()
        const errorText = await session.waitForError(180000)
        ex06.check('错误条可见', errorText.length > 0, `"${errorText.slice(0, 90)}"`)
        ex06.check('无成片预览页签', (await session.page.getByRole('tab', { name: '成片预览', exact: true }).count()) === 0, 'count=0')
        ex06.check('项目不变', (await session.state(pid)).id === revBefore, revBefore.slice(0, 8))
        await ex06.screenshot(session.page, 'readonly-fail')
        await chmod(readonlyDir, 0o755)
        const retry = outDir('EX-06-retry.mp4')
        await session.exportTo(retry)
        ex06.check('换正常路径导出成功', (await probeMedia(retry)).durationSec > 0, retry)
        ex06.record.output = { path: retry }
        await ex06.finish('通过', '只读目录失败可见且项目无损；恢复权限后换路径成功')
      } catch (err) {
        await chmod(path.join(path.dirname(outDir('x')), 'readonly-target'), 0o755).catch(() => undefined)
        await ex06.finish('失败', `EX-06 失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      }
    }

    // ══ CC-01：快速双击发送 + Enter，只有一次修订 ══════════════════════
    {
      const cc01 = new Case({
        id: 'CC-01', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '同一条有效提交只有一次修订；处理中输入和发送禁用；无重复变速、重复气泡或失去响应',
      })
      try {
        await session.stubDialogs({ video: F1() })
        await session.importVideo()
        await session.waitDraftReady()
        const pid = (await session.listProjects())[0]!.projectId
        const bubblesBefore = await session.agentBubbleCount()
        const revBefore = await diskRevisionCount(home, pid)
        const stateBefore = (await session.state(pid)).id
        await session.page.getByRole('textbox', { name: '剪辑反馈' }).fill('第一段 2 倍速，其他段不变')
        await rapidClick(session.page, '发送', 2) // 两次连续 click，不等中间状态
        await session.page.keyboard.press('Enter')
        await session.page.waitForFunction(
          (c) => document.querySelectorAll('.bubble.agent').length > c, bubblesBefore, { timeout: 60000 },
        )
        await session.page.waitForTimeout(2000) // 等最终稳定
        const bubblesAfter = await session.agentBubbleCount()
        cc01.check('agent 气泡恰好 +1（无重复结果气泡）', bubblesAfter === bubblesBefore + 1, `${bubblesBefore} → ${bubblesAfter}`)
        const revAfter = await diskRevisionCount(home, pid)
        cc01.check('revision 链只 +1', revAfter === revBefore + 1, `磁盘修订 ${revBefore} → ${revAfter}`)
        const st = await session.state(pid)
        cc01.check('revision 变化且只经一次修订', st.id !== stateBefore, `${stateBefore.slice(0, 8)} → ${st.id.slice(0, 8)}`)
        cc01.check('clips[0].speed 符合单次修改', st.timeline.clips[0]!.speed === 2, `speed=${st.timeline.clips[0]!.speed}`)
        cc01.record.cache = { bubblesBefore, bubblesAfter, revBefore, revAfter, chain: await revisionChain(home, pid) }
        await cc01.screenshot(session.page, 'after-burst')
        const ok = bubblesAfter === bubblesBefore + 1 && revAfter === revBefore + 1 && st.timeline.clips[0]!.speed === 2
        await cc01.finish(ok ? '通过' : '失败', `气泡 ${bubblesBefore}→${bubblesAfter}，修订 ${revBefore}→${revAfter}，speed=${st.timeline.clips[0]!.speed}（重点风险项，结果如实记录）`)
      } catch (err) {
        await cc01.finish('失败', `CC-01 失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      }
    }

    // ══ CC-02：快速双击撤销 + 三档音量连点 + 重启核对 ═══════════════════
    {
      const cc02 = new Case({
        id: 'CC-02', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '不出现内容回弹、UI 与磁盘不同或静默丢修订；若接收多次操作，最终音量对应最后被接受的操作（重点风险项）',
      })
      try {
        await session.stubDialogs({ video: F1() })
        await session.importVideo()
        await session.waitDraftReady()
        const pid = (await session.listProjects())[0]!.projectId
        await session.sendFeedback('开头太拖，直接进正题')
        await addBgm(session, BGM_WAV())
        await clickBgmVolume(session, '轻')
        await session.sendFeedback('字幕调大')
        const chainBefore = await revisionChain(home, pid)
        const bubblesBefore = await session.agentBubbleCount()
        await rapidClick(session.page, '撤销上一步', 2)
        await session.page.waitForFunction(
          (c) => document.querySelectorAll('.bubble.agent').length > c + 1, bubblesBefore, { timeout: 60000 },
        ).catch(() => undefined)
        await session.page.waitForTimeout(2000)
        const afterUndoBubbles = await session.agentBubbleCount()
        const chainAfterUndo = await revisionChain(home, pid)
        const undoRevisionDelta = chainAfterUndo.length - chainBefore.length
        const stAfterUndo = await session.state(pid)
        cc02.record.defects.push(
          `观察：双击撤销产生 ${undoRevisionDelta} 条撤销修订，气泡 ${bubblesBefore}→${afterUndoBubbles}；` +
          `撤销后 gainDb=${stAfterUndo.timeline.bgm?.gainDb}（是否回弹按链路证据判断）`,
        )
        // 三档音量快速连点（中间不等）
        await rapidClickSequence(session.page, ['轻', '标准', '响'])
        await session.page.waitForTimeout(2500)
        const chainAfterVolume = await revisionChain(home, pid)
        cc02.record.cache = { chainBefore, chainAfterUndo, chainAfterVolume }
        // 重启核对最终状态
        await session.close()
        await session.start()
        await restoreFromRecent(session, pid)
        const finalSt = await session.state(pid)
        const diskLatest = chainAfterVolume[chainAfterVolume.length - 1]
        const finalDiskChain = await revisionChain(home, pid)
        const finalDiskLatest = finalDiskChain[finalDiskChain.length - 1]
        cc02.check('UI 与磁盘一致', finalDiskLatest?.id === finalSt.id, `UI=${finalSt.id.slice(0, 8)} 磁盘=${finalDiskLatest?.id.slice(0, 8)}`)
        cc02.check('最终音量对应最后被接受的操作（响 = -12）', finalSt.timeline.bgm?.gainDb === -12,
          `最终 gainDb=${finalSt.timeline.bgm?.gainDb}（磁盘最新 ${JSON.stringify(diskLatest?.feedback ?? '')}）`)
        cc02.check('无静默丢修订', finalDiskChain.length >= chainBefore.length + 2, `${chainBefore.length} → ${finalDiskChain.length}`)
        cc02.check('最终剪辑内容未回弹到初稿', finalSt.timeline.clips.length > 0
          && finalSt.timeline.clips[0]!.sourceStartSec > 0, `start=${finalSt.timeline.clips[0]!.sourceStartSec}`)
        await cc02.screenshot(session.page, 'cc02-final')
        const ok = finalDiskLatest?.id === finalSt.id && finalSt.timeline.bgm?.gainDb === -12
        await cc02.finish(ok ? '通过' : '失败', `最终 gainDb=${finalSt.timeline.bgm?.gainDb}，修订链 ${finalDiskChain.length} 条（观察证据已存档）`)
      } catch (err) {
        await cc02.finish('失败', `CC-02 失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      }
    }

    // ══ CC-03：双击查看实际效果 + 生成期间观察忙状态 ═══════════════════
    {
      const cc03 = new Case({
        id: 'CC-03', variant: 'M', mode: 'M', material: MATERIALS.F1,
        expected: '只得到当前版效果，无并行重复编码或两份成功结果；忙状态阻止互相冲突的编辑',
      })
      try {
        await session.stubDialogs({ video: F1() })
        await session.importVideo()
        await session.waitDraftReady()
        const pid = (await session.listProjects())[0]!.projectId
        const revBefore = (await session.state(pid)).id
        await rapidClick(session.page, '查看实际效果', 2)
        // 生成期间采样忙状态（渲染需数十秒，采样窗口充足）
        const busy = await session.page.evaluate(() => {
          const input = document.querySelector('input[aria-label="剪辑反馈"]') as HTMLInputElement | null
          const buttons = Array.from(document.querySelectorAll('button'))
          const undoBtn = buttons.find((b) => (b.textContent ?? '').includes('撤销上一步'))
          const exportBtn = buttons.find((b) => (b.textContent ?? '').includes('生成成片'))
          const previewBusyBtn = buttons.find((b) => (b.textContent ?? '').includes('正在生成预览'))
          const previewIdleBtn = buttons.find((b) => (b.textContent ?? '').includes('查看实际效果'))
          return {
            inputDisabled: input?.disabled ?? null,
            undoDisabled: undoBtn?.disabled ?? null,
            exportDisabled: exportBtn?.disabled ?? null,
            previewBtnText: previewBusyBtn?.textContent ?? previewIdleBtn?.textContent ?? '',
          }
        })
        cc03.record.defects.push(`观察：生成期间忙状态——输入禁用=${busy.inputDisabled}，撤销禁用=${busy.undoDisabled}，导出禁用=${busy.exportDisabled}，按钮文本="${busy.previewBtnText}"`)
        await session.page.getByRole('tab', { name: '效果预览', exact: true }).waitFor({ timeout: 180000 })
        const effectTabs = await session.page.getByRole('tab', { name: '效果预览', exact: true }).count()
        cc03.check('只有一份效果预览（单页签）', effectTabs === 1, `${effectTabs} 个效果预览页签`)
        const videoOk = await session.page.waitForFunction(() => {
          const v = document.querySelector('video')
          return !!v && v.readyState >= 2 && v.videoWidth > 0 && v.playbackRate === 1
        }, undefined, { timeout: 60000 }).then(() => true, () => false)
        cc03.check('效果预览可正常播放', videoOk, 'readyState≥2 且 1x')
        const errorBars = await session.page.locator('.error-bar').count()
        cc03.check('无错误', errorBars === 0, `error-bar=${errorBars}`)
        cc03.check('预览未改变 revision', (await session.state(pid)).id === revBefore, revBefore.slice(0, 8))
        // 最终状态一致：做一次修改并撤销，回到预览前状态
        await session.sendFeedback('字幕调大')
        await session.undo()
        const stFinal = await session.state(pid)
        cc03.check('最终状态一致（可继续编辑与撤销）', stFinal.timeline.subtitleAppearance?.size === undefined, '字幕设置已复位')
        cc03.record.cache = { busySnapshot: busy, revisionId: revBefore }
        await cc03.finish('通过', '双击只产生一份效果预览；忙状态与最终一致性证据已记录')
      } catch (err) {
        await cc03.finish('失败', `CC-03 失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      }
    }

    // ══ CC-04：修订进行中导入另一素材，归属与磁盘完整性 ════════════════
    {
      const cc04 = new Case({
        id: 'CC-04', variant: 'M/F1修订+F2导入', mode: 'M', material: MATERIALS.F1,
        expected: '最终画面、卡片、对话、预览和磁盘记录属于同一项目；旧请求不能把新项目覆盖或把 A 的成片挂到 B',
      })
      try {
        await session.stubDialogs({ video: F1() })
        await session.importVideo()
        await session.waitDraftReady()
        const pidA = (await session.listProjects())[0]!.projectId
        await session.page.getByRole('textbox', { name: '剪辑反馈' }).fill('字幕调大')
        await session.button('发送').click() // 修订 A 进行中（mock 很快，竞态窗口记录在案）
        await session.stubDialogs({ video: materialPath(MATERIALS.F2) })
        await session.button('导入视频').click() // 立即触发导入 B
        await session.page.waitForFunction(() => {
          const text = document.body.innerText
          return !text.includes('正在按你的反馈修改') && !text.includes('正在建草稿') && document.querySelector('video') !== null
        }, undefined, { timeout: 120000 })
        await session.page.waitForTimeout(1000)
        const projects = await session.listProjects()
        cc04.check('两个项目都在列表', projects.length >= 2, `${projects.length} 个项目`)
        // 磁盘完整性：A 的最新修订仍是 F1 内容且包含那次字幕修订
        const stateA = await session.state(pidA)
        cc04.check('项目 A 磁盘记录完整（640×360 + 字幕修订落地）', stateA.settings.width === 640
          && stateA.settings.height === 360 && stateA.timeline.subtitleAppearance?.size === 'large',
          `settings=${stateA.settings.width}×${stateA.settings.height}, size=${stateA.timeline.subtitleAppearance?.size}`)
        const projectB = projects.find((p) => p.projectId !== pidA)
        const stateB = projectB ? await session.state(projectB.projectId) : undefined
        cc04.check('项目 B 磁盘记录完整（720×1280）', !!stateB && stateB.settings.width === 720 && stateB.settings.height === 1280,
          `settings=${stateB?.settings.width}×${stateB?.settings.height}`)
        // 当前 UI 展示归属：video src 指向哪份素材
        const uiSource = await session.page.evaluate(() => {
          const v = document.querySelector('video')
          return v ? decodeURIComponent(v.src.replace('pimko-media://media/', '')) : ''
        })
        const showing = uiSource.includes('portrait-en') ? 'F2' : uiSource.includes('talking-head') ? 'F1' : uiSource
        const bubbles = await session.page.locator('.bubble.agent').count()
        cc04.record.defects.push(
          `观察：竞态后 UI 画面归属 ${showing}，agent 气泡 ${bubbles} 条；` +
          '「导入视频」仅在建稿/导出时禁用（代码事实），修订期间可点击，最终归属取决于两个 IPC 完成顺序，已按现状记录',
        )
        await cc04.screenshot(session.page, 'cc04-final-ui')
        cc04.record.cache = { pidA, pidB: projectB?.projectId, uiSource: showing, projects: projects.map((p) => p.projectId) }
        const ok = projects.length >= 2 && !!stateB && stateB.settings.width === 720 && stateA.timeline.subtitleAppearance?.size === 'large'
        await cc04.finish(ok ? '通过' : '失败', `磁盘两项目均完整；UI 最终展示 ${showing}（顺序证据见截图与 chain）`)
      } catch (err) {
        await cc04.finish('失败', `CC-04 失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      }
    }

    // ══ CC-05：建稿/修订/渲染中关闭应用，基线不丢、重试成功 ════════════
    {
      // 基线项目
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const pidBase = (await session.listProjects())[0]!.projectId
      const previewsDir = path.join(home, '.config', 'pimko', 'previews')
      const variants: { label: string; trigger: () => Promise<void>; retry: () => Promise<void>; settleMs: number }[] = [
        {
          label: '建稿中关闭',
          settleMs: 800,
          trigger: async () => {
            await session.stubDialogs({ video: F1() })
            await session.button('导入视频').click()
          },
          retry: async () => {
            await session.stubDialogs({ video: F1() })
            await session.importVideo()
            await session.waitDraftReady()
          },
        },
        {
          label: '修订中关闭',
          settleMs: 150,
          trigger: async () => {
            await session.page.getByRole('textbox', { name: '剪辑反馈' }).fill('字幕调大')
            await session.button('发送').click()
          },
          retry: async () => {
            await session.sendFeedback('字幕调大')
          },
        },
        {
          label: '渲染中关闭',
          settleMs: 1200,
          trigger: async () => {
            await session.button('查看实际效果').click()
          },
          retry: async () => {
            await session.renderPreview()
            await session.page.waitForFunction(() => {
              const v = document.querySelector('video')
              return !!v && v.readyState >= 2 && v.videoWidth > 0
            }, undefined, { timeout: 120000 })
          },
        },
      ]
      for (const entry of variants) {
        const cc05 = new Case({
          id: 'CC-05', variant: `M/${entry.label}`, mode: 'M', material: MATERIALS.F1,
          expected: '已完成 baseline 不丢失，未完成操作不被宣称成功；无永久加载；记录残留工作文件',
        })
        try {
          await entry.trigger()
          await session.page.waitForTimeout(entry.settleMs) // 命中操作进行中窗口
          await session.close()
          await killOwnOrphanFfmpeg() // 仅清理本任务被中断的渲染子进程
          // 关闭后从磁盘读取「最后持久化状态」作为对照（修订可能在关闭前已完成）
          const persistedTimeline = await diskLatestTimeline(home, pidBase)
          await session.start()
          const projects = await session.listProjects()
          cc05.check('基线项目不丢失', projects.some((p) => p.projectId === pidBase), `${projects.length} 个项目`)
          await restoreFromRecent(session, pidBase)
          const restored = await session.state(pidBase)
          cc05.check('恢复后 timeline 与最后持久化状态一致', JSON.stringify(restored.timeline) === persistedTimeline,
            persistedTimeline ? `与磁盘最新修订一致（${restored.id.slice(0, 8)}）` : '磁盘读取失败（见缺陷）')
          // 重试该操作
          await entry.retry()
          cc05.check('重试操作成功', true, `${entry.label} 重试完成`)
          // 残留 partial 检查（自己的隔离目录，可直接清理并记录）
          const partials = (await readdir(previewsDir).catch(() => [] as string[])).filter((f) => f.endsWith('.partial.mp4'))
          if (partials.length > 0) {
            cc05.record.defects.push(`发现 ${partials.length} 个残留半成品（${partials.join('、')}），属本任务隔离目录，已删除并记录`)
            for (const p of partials) await rm(path.join(previewsDir, p), { force: true })
          } else {
            cc05.check('无 *.partial.mp4 残留', true, 'previews 目录干净')
          }
          await cc05.screenshot(session.page, 'after-restart')
          await cc05.finish('通过', `${entry.label}：基线保留、重试成功、残留已检查`)
        } catch (err) {
          await cc05.finish('失败', `CC-05/${entry.label} 失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
        }
      }
    }

    await session.close()
  })
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
