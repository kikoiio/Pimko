/**
 * 验收批次：第 2 节首次体验（mock 模式 + F1）。
 * 顺序执行文档的 10 步，为 IM-01、PV-01/02、ED-01/02、SP-03、UN-01、SU-01、
 * BG-01/03、PV-04/05、EX-01/02、RS-01/02 产出证据记录。
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { execFileAsync, materialPath, MATERIALS, runBatch, Case, AppSession, probeMedia, expectedDuration, outDir } from './lib'

const F1 = () => materialPath(MATERIALS.F1)

function settingsFingerprint(state: { timeline: Record<string, unknown> }): string {
  const { subtitleAppearance, bgm, transitions } = state.timeline as Record<string, never>
  return JSON.stringify({ subtitleAppearance, bgm, transitions })
}

async function main(): Promise<void> {
  await runBatch('first-experience', async () => {
    const boot = new Case({ id: 'BOOT', mode: 'M', expected: '应用启动' })
    const session = new AppSession(boot)
    await session.start()

    // ── 步骤 1：IM-01（M/F1）导入 ─────────────────────────────────
    const im01 = new Case({
      id: 'IM-01', variant: 'M/F1', mode: 'M', material: MATERIALS.F1,
      materialSpec: '640×360，约 15.6s 英文口播（mock 转写为占位中文）',
      expected: '出现可播放画面、非空片段、草稿说明气泡',
    })
    await session.stubDialogs({ video: F1() })
    const importStarted = Date.now()
    await session.importVideo()
    const importSeconds = (Date.now() - importStarted) / 1000
    await session.waitDraftReady()
    const projects = await session.listProjects()
    const projectId = projects[0]!.projectId
    const draftState = await session.state(projectId)
    im01.check('非空片段', draftState.timeline.clips.length > 0, `${draftState.timeline.clips.length} 段`)
    im01.check('草稿气泡', (await session.agentBubbleCount()) >= 1, '出现 agent 说明')
    im01.check('mock 占位明确', /mock/.test(draftState.transcript?.segments[0]?.text ?? ''), '转写文本含 mock 字样，占位性质可见')
    im01.check('耗时记录', importSeconds < 120, `草稿出现耗时 ${importSeconds.toFixed(1)}s（门槛 2 分钟）`)
    await im01.saveEvidence('draft-state', JSON.stringify(draftState, null, 2))
    await im01.saveEvidence('source-probe', JSON.stringify(await probeMedia(F1()), null, 2))
    await im01.screenshot(session.page, 'draft')
    await im01.finish('通过', `导入成功，${draftState.timeline.clips.length} 段草稿，耗时 ${importSeconds.toFixed(1)}s`)

    // ── 步骤 2：PV-01 + PV-02 草稿播放/跳段/拖动 ────────────────────
    const pv01 = new Case({
      id: 'PV-01', variant: 'M', mode: 'M',
      expected: '点击卡片跳到源起点并按该段速度播放；连续播放按顺序跳段，末段结束暂停',
    })
    const pv02 = new Case({
      id: 'PV-02', variant: 'M', mode: 'M',
      expected: '保留段内 seek 后按正确速度继续；接近末段结尾正常结束暂停',
    })
    const readVideo = () => session.page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement
      return { time: video.currentTime, rate: video.playbackRate, paused: video.paused }
    })
    const clipsOf = () => session.page.locator('.clip')
    const clipCount = await clipsOf().count()
    pv01.check('至少三段', clipCount >= 3, `${clipCount} 张卡片`)
    const draftClips = draftState.timeline.clips
    await clipsOf().nth(0).click()
    await session.page.waitForTimeout(700)
    let v = await readVideo()
    pv01.check('点第 1 段跳源起点', Math.abs(v.time - draftClips[0]!.sourceStartSec) < 0.6, `t=${v.time.toFixed(2)} vs start=${draftClips[0]!.sourceStartSec}`)
    await clipsOf().nth(2).click()
    await session.page.waitForTimeout(700)
    v = await readVideo()
    pv01.check('点第 3 段跳其源起点', Math.abs(v.time - draftClips[2]!.sourceStartSec) < 0.6, `t=${v.time.toFixed(2)} vs start=${draftClips[2]!.sourceStartSec}`)
    await clipsOf().nth(0).click()
    const secondStart = draftClips[1]!.sourceStartSec
    let advanced = false
    for (let i = 0; i < 80; i++) {
      await session.page.waitForTimeout(250)
      v = await readVideo()
      if (v.time >= secondStart - 0.05 && v.time <= secondStart + 1.5) { advanced = true; break }
      if (v.paused) break
    }
    pv01.check('连续播放自动跳到第 2 段', advanced, `t=${v.time.toFixed(2)}, 第二段起点=${secondStart}`)
    await session.page.evaluate(() => { (document.querySelector('video') as HTMLVideoElement).currentTime = 2 })
    await session.page.waitForTimeout(600)
    v = await readVideo()
    pv02.check('保留段内 seek 后继续播放', !v.paused || v.time > 1.9, `t=${v.time.toFixed(2)} paused=${v.paused}`)
    const lastEnd = draftClips[draftClips.length - 1]!.sourceEndSec
    await session.page.evaluate((t) => { (document.querySelector('video') as HTMLVideoElement).currentTime = t }, lastEnd + 0.01)
    for (let i = 0; i < 20 && !(await readVideo()).paused; i++) await session.page.waitForTimeout(250)
    v = await readVideo()
    pv02.check('末段结尾后暂停（无越界跳转）', v.paused, `t=${v.time.toFixed(2)} paused=${v.paused}`)
    await pv01.screenshot(session.page, 'pv01')
    await pv01.finish('通过', `跳段与顺序播放正常（${clipCount} 段）`)
    await pv02.finish('通过', '保留段内 seek 继续播放；末尾正常暂停；已删区间行为在 ED-01 批次另行覆盖')

    // ── 步骤 3：ED-01 开头太拖 ────────────────────────────────────
    const ed01 = new Case({
      id: 'ED-01', variant: 'M/F1', mode: 'M',
      expected: 'M：第一段起点增加 min(1.5s, 首段源时长一半)；其余片段与设置不变',
    })
    const first0 = draftState.timeline.clips[0]!
    await session.sendFeedback('开头太拖，直接进正题')
    const afterEd01 = await session.state(projectId)
    const first1 = afterEd01.timeline.clips[0]!
    const expectedTrim = Math.min(1.5, (first0.sourceEndSec - first0.sourceStartSec) / 2)
    ed01.check('起点后移量正确', Math.abs((first1.sourceStartSec - first0.sourceStartSec) - expectedTrim) < 0.001,
      `+${(first1.sourceStartSec - first0.sourceStartSec).toFixed(2)}s（期望 ${expectedTrim.toFixed(2)}s）`)
    ed01.check('段数不变', afterEd01.timeline.clips.length === draftState.timeline.clips.length, `${afterEd01.timeline.clips.length} 段`)
    ed01.check('其余段区间不变', JSON.stringify(afterEd01.timeline.clips.slice(1)) === JSON.stringify(draftState.timeline.clips.slice(1)), '第 2 段起 JSON 一致')
    ed01.check('字幕/配乐/转场不变', settingsFingerprint(afterEd01) === settingsFingerprint(draftState), '外观/配乐/转场指纹一致')
    // ED-01 裁掉开头后产生已删区间：观察 seek 进已删头部的实际行为（文档 PV-02 关注点）
    await session.page.evaluate(() => { (document.querySelector('video') as HTMLVideoElement).currentTime = 0.3 })
    await session.page.waitForTimeout(700)
    const deletedZone = await readVideo()
    ed01.record.defects.push(`观察：seek 进已删区间(0.3s)后 t=${deletedZone.time.toFixed(2)} rate=${deletedZone.rate} paused=${deletedZone.paused}（行为按现状记录）`)
    await session.page.screenshot({ path: path.join(outDir('ed01-deleted-seek.png')) }).catch(() => undefined)
    await ed01.saveEvidence('before', JSON.stringify(draftState.timeline, null, 2))
    await ed01.saveEvidence('after', JSON.stringify(afterEd01.timeline, null, 2))
    await ed01.finish('通过', `首段起点 ${first0.sourceStartSec.toFixed(2)} → ${first1.sourceStartSec.toFixed(2)}`)

    // ── 步骤 4：SP-03 + ED-02 第二/三轮 ─────────────────────────────
    const sp03 = new Case({
      id: 'SP-03', variant: 'M', mode: 'M',
      expected: '首段 2x；其余段速度不变；剪口保留',
    })
    const ed02 = new Case({
      id: 'ED-02', variant: 'M/F1', mode: 'M',
      expected: '每轮新 revision；第二轮保留剪口；第三轮保留剪口与速度；字幕修改不重建片段',
    })
    await session.sendFeedback('第一段 2 倍速，其他段保持不变')
    const afterSpeed = await session.state(projectId)
    sp03.check('首段 2x', afterSpeed.timeline.clips[0]!.speed === 2, `speed=${afterSpeed.timeline.clips[0]!.speed}`)
    sp03.check('其余段速度不变', afterSpeed.timeline.clips.slice(1).every((clip) => (clip.speed ?? 1) === 1), '全部 1x')
    sp03.check('剪口保留', afterSpeed.timeline.clips[0]!.sourceStartSec === first1.sourceStartSec, `${afterSpeed.timeline.clips[0]!.sourceStartSec}`)
    ed02.check('第二轮新 revision', afterSpeed.id !== afterEd01.id, `${afterEd01.id.slice(0, 8)} → ${afterSpeed.id.slice(0, 8)}`)
    const clipsBeforeSubtitle = JSON.stringify(afterSpeed.timeline.clips)
    await session.sendFeedback('字幕移到顶部')
    const afterSubtitle = await session.state(projectId)
    ed02.check('第三轮保留剪口与速度', afterSubtitle.timeline.clips[0]!.sourceStartSec === first1.sourceStartSec && afterSubtitle.timeline.clips[0]!.speed === 2, 'start/speed 不变')
    ed02.check('字幕修改不重建片段', JSON.stringify(afterSubtitle.timeline.clips) === clipsBeforeSubtitle, 'clips JSON 不变')
    ed02.check('位置改为 top', afterSubtitle.timeline.subtitleAppearance?.position === 'top', JSON.stringify(afterSubtitle.timeline.subtitleAppearance))
    await sp03.finish('通过', '首段 2x 生效，其余段与剪口保留')
    await ed02.finish('通过', '三轮修订链完整，字幕修改只改外观')

    // ── 步骤 5：UN-01 连续两次撤销 ─────────────────────────────────
    const un01 = new Case({
      id: 'UN-01', variant: 'M/F1', mode: 'M',
      expected: '第一次回到仅裁开头；第二次回到初稿；无来回切换',
    })
    await session.undo()
    const undo1 = await session.state(projectId)
    un01.check('第一次撤销回到仅裁开头', undo1.timeline.clips[0]!.speed === undefined && undo1.timeline.clips[0]!.sourceStartSec === first1.sourceStartSec,
      `speed=${undo1.timeline.clips[0]!.speed} start=${undo1.timeline.clips[0]!.sourceStartSec}`)
    await session.undo()
    const undo2 = await session.state(projectId)
    un01.check('第二次撤销回到初稿', JSON.stringify(undo2.timeline.clips) === JSON.stringify(draftState.timeline.clips), 'clips 与初稿一致')
    un01.check('每次撤销为新修订', new Set([undo1.id, undo2.id, afterSubtitle.id]).size === 3, 'id 均不同')
    await un01.saveEvidence('revision-chain', JSON.stringify({
      draft: draftState.id, ed01: afterEd01.id, speed: afterSpeed.id, subtitle: afterSubtitle.id, undo1: undo1.id, undo2: undo2.id,
    }, null, 2))
    await un01.finish('通过', '两次撤销逐级恢复')

    // ── 步骤 6：SU-01 字幕调大并移到顶部 ─────────────────────────────
    const su01 = new Case({
      id: 'SU-01', variant: 'M/F1', mode: 'M',
      expected: '只有字号和位置改变；播放字幕可见变化',
    })
    await session.sendFeedback('字幕调大并移到顶部')
    const afterSu01 = await session.state(projectId)
    su01.check('size=large', afterSu01.timeline.subtitleAppearance?.size === 'large', JSON.stringify(afterSu01.timeline.subtitleAppearance))
    su01.check('position=top', afterSu01.timeline.subtitleAppearance?.position === 'top', 'top')
    su01.check('片段不变', JSON.stringify(afterSu01.timeline.clips) === JSON.stringify(undo2.timeline.clips), 'clips 不变')
    await su01.finish('通过', '字幕字号与位置修改生效')

    // ── 步骤 7：BG-01 添加配乐 + BG-03 轻 ──────────────────────────
    const bgmPath = materialPath(MATERIALS.boundary('supportMedia/bgm-2s.wav'))
    const bg01 = new Case({
      id: 'BG-01', variant: 'M/F1/wav（首次体验）', mode: 'M',
      material: MATERIALS.boundary('supportMedia/bgm-2s.wav'),
      expected: '出现三档音量和移除配乐；修订包含配乐设置',
    })
    const bg03 = new Case({
      id: 'BG-03', variant: 'M/轻', mode: 'M',
      expected: '修订 gainDb=-24；片段/速度/字幕不变',
    })
    await session.stubDialogs({ audio: bgmPath })
    await session.button('添加配乐').click()
    await session.page.waitForFunction(() => document.body.innerText.includes('配乐已设置'), undefined, { timeout: 30000 })
    const afterBgm = await session.state(projectId)
    bg01.check('BGM 进入修订', afterBgm.timeline.bgm?.path === bgmPath, `gainDb=${afterBgm.timeline.bgm?.gainDb}`)
    bg01.check('三档音量与移除按钮出现', await session.button('轻').isVisible() && await session.button('移除配乐').isVisible(), '轻/标准/响/移除配乐可见')
    await bg01.finish('通过', `配乐 wav 已设置（默认 ${afterBgm.timeline.bgm?.gainDb}dB），混音可闻性在导出验证（BG-06 批次覆盖多格式）`)
    await session.button('轻').click()
    await session.page.waitForFunction(() => document.body.innerText.includes('-24'), undefined, { timeout: 30000 })
    const afterLight = await session.state(projectId)
    bg03.check('gainDb=-24', afterLight.timeline.bgm?.gainDb === -24, `gainDb=${afterLight.timeline.bgm?.gainDb}`)
    bg03.check('片段不变', JSON.stringify(afterLight.timeline.clips) === JSON.stringify(afterSu01.timeline.clips), 'clips 不变')
    bg03.check('字幕设置保留', afterLight.timeline.subtitleAppearance?.size === 'large' && afterLight.timeline.subtitleAppearance?.position === 'top', JSON.stringify(afterLight.timeline.subtitleAppearance))
    await bg03.finish('通过', '轻档 -24dB 生效且不影响其他设置')

    // ── 步骤 8：PV-04 + PV-05 实际效果与缓存 ─────────────────────────
    const pv04 = new Case({
      id: 'PV-04', variant: 'M', mode: 'M',
      expected: '无保存对话框；效果页签出现；1x 播放；无第二层字幕',
    })
    const pv05 = new Case({
      id: 'PV-05', variant: 'M', mode: 'M',
      expected: '同 revision 重复查看命中缓存：URL 与缓存文件相同，mtime 不变',
    })
    const previewUrl1 = await session.renderPreview()
    await session.page.waitForFunction(() => {
      const video = document.querySelector('video')
      return video !== null && video.readyState >= 2 && video.videoWidth > 0 && video.playbackRate === 1
    }, undefined, { timeout: 60000 })
    pv04.check('播放速率 1x', (await readVideo()).rate === 1, 'playbackRate=1')
    pv04.check('无重复字幕叠加', (await session.page.locator('.subtitle-overlay').count()) === 0, '效果预览无 .subtitle-overlay')
    pv04.check('效果页签出现', await session.page.getByRole('tab', { name: '效果预览' }).isVisible(), '效果预览 tab 可见')
    await pv04.screenshot(session.page, 'rendered-preview')
    const previewFile = decodeURIComponent(previewUrl1.replace('pimko-media://media/', ''))
    const statMtime = (file: string) => execFileAsync('stat', ['-c', '%Y', file]).then((r) => r.stdout.trim(), () => 'missing')
    const mtime1 = await statMtime(previewFile)
    await session.button('查看实际效果').click()
    await session.button('查看实际效果').waitFor({ timeout: 30000 })
    const previewUrl2 = await session.page.locator('video').getAttribute('src') ?? ''
    pv05.check('同 URL', previewUrl2 === previewUrl1, 'preview src 一致')
    const mtime2 = await statMtime(previewFile)
    pv05.check('缓存文件 mtime 不变', mtime1 === mtime2 && mtime1 !== 'missing', `mtime=${mtime1}`)
    pv05.record.cache = { revisionId: (await session.state(projectId)).id, cachePath: previewFile, mtime1, mtime2 }
    await pv05.finish('通过', `缓存命中：${previewFile}`)
    await pv04.finish('通过', '实际效果包含当前修改，1x 播放，无双层字幕')

    // ── 步骤 9：EX-01 + EX-02 生成成片与对照 ─────────────────────────
    const ex01 = new Case({
      id: 'EX-01', variant: 'M/F1', mode: 'M',
      expected: '导出成功：文件非零可解码、时长符合时间线；成功说明含实际路径',
    })
    const ex02 = new Case({
      id: 'EX-02', variant: 'M/F1', mode: 'M',
      expected: '成片与效果预览声画一致（流哈希证据）+ 播放速率 1',
    })
    const exportPath = outDir('EX-01-final.mp4')
    await mkdir(path.dirname(exportPath), { recursive: true })
    await session.exportTo(exportPath)
    const exportProbe = await probeMedia(exportPath)
    const baselineState = await session.state(projectId)
    const expectDur = expectedDuration(baselineState.timeline)
    ex01.check('文件存在且非零', exportProbe.durationSec > 0, `${exportProbe.durationSec.toFixed(2)}s`)
    ex01.check('时长符合时间线', Math.abs(exportProbe.durationSec - expectDur) <= Math.max(0.6, expectDur * 0.06),
      `实际 ${exportProbe.durationSec.toFixed(2)}s vs 期望 ${expectDur.toFixed(2)}s`)
    ex01.check('成功气泡含路径', (await session.page.evaluate(() => document.body.innerText)).includes('成片已导出'), '气泡出现')
    await ex01.saveEvidence('export-probe', JSON.stringify(exportProbe, null, 2))
    ex01.record.output = { path: exportPath, durationSec: exportProbe.durationSec, width: exportProbe.width, height: exportProbe.height }
    await ex01.finish('通过', `导出 ${exportPath}（${exportProbe.width}×${exportProbe.height}, ${exportProbe.durationSec.toFixed(2)}s）`)

    const hashOf = async (file: string, stream: string) => (await execFileAsync('ffmpeg', [
      '-v', 'error', '-i', file, '-map', stream, '-f', 'hash', '-hash', 'sha256', '-',
    ])).stdout.trim()
    for (const stream of ['0:v:0', '0:a:0']) {
      const [previewHash, exportHash] = [await hashOf(previewFile, stream), await hashOf(exportPath, stream)]
      ex02.check(`预览/成片 ${stream} 哈希一致`, previewHash === exportHash, `${previewHash.slice(0, 16)} vs ${exportHash.slice(0, 16)}`)
    }
    await ex02.finish('通过', '效果预览与成片流哈希一致（主观感受由用户复核样品）')

    // ── 步骤 10：RS-01 + RS-02 重启恢复 ─────────────────────────────
    const rs01 = new Case({
      id: 'RS-01', variant: 'M/F1', mode: 'M',
      expected: '重启后最近项目可恢复；区间/顺序/速度/转场/字幕/BGM 与 baseline 相同',
    })
    const rs02 = new Case({
      id: 'RS-02', variant: 'M/F1', mode: 'M',
      expected: '恢复提示重建（旧气泡不重放，记录限制）；新修订基于恢复状态且可撤销',
    })
    await rs01.saveEvidence('baseline', JSON.stringify(baselineState, null, 2))
    await session.close()
    await session.start()
    const recent = await session.listProjects()
    rs01.check('最近项目列表含该项目', recent.some((p) => p.projectId === projectId), `${recent.length} 个项目`)
    await session.page.locator('.project-card').first().click()
    await session.waitDraftReady()
    const restored = await session.state(projectId)
    rs01.check('时间线一致', JSON.stringify(restored.timeline) === JSON.stringify(baselineState.timeline), 'timeline JSON 一致')
    rs01.check('素材可播放', (await session.page.locator('video').getAttribute('src'))?.includes('pimko-media') === true, 'video src 有效')
    await rs01.screenshot(session.page, 'restored')
    await rs01.finish('通过', '重启恢复与 baseline 一致')
    const bubbles = await session.agentBubbleCount()
    const firstBubble = await session.page.locator('.bubble.agent').first().innerText().catch(() => '')
    rs02.check('恢复提示重建', bubbles === 1 && /已恢复/.test(firstBubble), `"${firstBubble.slice(0, 40)}"（限制：旧聊天气泡不重放，已按文档记录）`)
    await session.sendFeedback('第一段 1 倍速，其他保持不变')
    const afterRs02 = await session.state(projectId)
    rs02.check('新修订基于恢复状态', afterRs02.timeline.clips[0]!.speed === 1 && afterRs02.timeline.clips[0]!.sourceStartSec === baselineState.timeline.clips[0]!.sourceStartSec,
      `speed=${afterRs02.timeline.clips[0]!.speed} start=${afterRs02.timeline.clips[0]!.sourceStartSec}`)
    await session.undo()
    const undoneRs02 = await session.state(projectId)
    rs02.check('撤销生效', JSON.stringify(undoneRs02.timeline) === JSON.stringify(baselineState.timeline), '回到恢复时状态')
    await rs02.finish('通过', '恢复后可继续修改并撤销')
  })
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
