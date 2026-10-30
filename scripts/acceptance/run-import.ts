/**
 * 验收批次：import（导入与材料边界 + FA-01）。
 *
 * 覆盖：IM-02、IM-03（mp4/mov/mkv/webm/m4v 五变体）、IM-04、IM-05、IM-06、IM-07、
 * IM-08（F7 / one-frame 两变体）、IM-09（special-path/rotate90/sar/vfr 四变体）、
 * IM-13（square/low-fps/audio-only 三变体）、IM-14（4K）、FA-01（零字节/伪装/截断三变体）。
 * 全部为 M（mock）模式。
 *
 * 只在 CI（GitHub Actions / xvfb）运行；本机不得执行（Electron/渲染重型操作）。
 */
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import type { Page } from 'playwright'
import {
  AppSession, Case, MATERIALS, materialPath, outDir, probeMedia, runBatch,
} from './lib'

const execFileAsync = promisify(execFile)

const F1 = () => materialPath(MATERIALS.F1)

interface Box { x: number; y: number; width: number; height: number }

async function readVideo(page: Page): Promise<{ time: number; paused: boolean; rate: number; width: number; height: number } | null> {
  return page.evaluate(() => {
    const v = document.querySelector('video')
    return v ? { time: v.currentTime, paused: v.paused, rate: v.playbackRate, width: v.videoWidth, height: v.videoHeight } : null
  })
}

/** 导入后等待 video 元素可解码；FFV1 等浏览器不支持的编码会超时，返回 false 而不抛错。 */
async function waitDraftDecodable(session: AppSession, timeoutMs = 8000): Promise<boolean> {
  return session.page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && v.readyState >= 2 && v.videoWidth > 0
  }, undefined, { timeout: timeoutMs }).then(() => true, () => false)
}

/** 判断 video 元素框是否完全落在 .stage 框内（1px 容差）。 */
async function videoInsideStage(page: Page): Promise<{ inside: boolean; video: Box | null; stage: Box | null }> {
  const boxes = await page.evaluate(() => {
    const video = document.querySelector('video')
    const stage = document.querySelector('.stage')
    const vr = video ? video.getBoundingClientRect() : null
    const sr = stage ? stage.getBoundingClientRect() : null
    return { video: vr ? { x: vr.x, y: vr.y, width: vr.width, height: vr.height } : null, stage: sr ? { x: sr.x, y: sr.y, width: sr.width, height: sr.height } : null }
  })
  const { video, stage } = boxes
  const inside = !!video && !!stage
    && video.x >= stage.x - 1 && video.y >= stage.y - 1
    && video.x + video.width <= stage.x + stage.width + 1
    && video.y + video.height <= stage.y + stage.height + 1
  return { inside, video, stage }
}

async function main(): Promise<void> {
  await runBatch('import', async () => {
    const boot = new Case({ id: 'BOOT', mode: 'M', expected: '应用启动（mock 模式）' })
    const session = new AppSession(boot)
    await session.start()

    // ══ IM-02：空状态与已有项目两次取消导入 ═════════════════════════
    {
      const im02 = new Case({
        id: 'IM-02', variant: 'M/取消', mode: 'M', material: MATERIALS.F1,
        expected: '取消不产生新项目或成功气泡；已有片段和修订不变；取消后仍能操作已有项目',
      })
      // 空状态取消
      await session.stubDialogs({ video: null })
      await session.button('选择视频').click()
      await session.page.waitForTimeout(1000)
      const emptyProjects = await session.listProjects()
      im02.check('空状态取消不产生项目', emptyProjects.length === 0, `${emptyProjects.length} 个项目`)
      im02.check('空状态取消无成功气泡', (await session.agentBubbleCount()) === 0, '气泡数 0')
      im02.check('仍在空状态可操作', await session.button('选择视频').isVisible(), '「选择视频」按钮仍可见')
      // 导入 F1 成功
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const projects = await session.listProjects()
      const projectId = projects[0]!.projectId
      const beforeState = await session.state(projectId)
      const beforeBubbles = await session.agentBubbleCount()
      // 已有项目状态再次取消
      await session.stubDialogs({ video: null })
      await session.button('导入视频').click()
      await session.page.waitForTimeout(1000)
      im02.check('已有项目取消不新增项目', (await session.listProjects()).length === 1, '项目数仍为 1')
      const afterState = await session.state(projectId)
      im02.check('修订不变', afterState.id === beforeState.id
        && JSON.stringify(afterState.timeline) === JSON.stringify(beforeState.timeline), 'revision 与 timeline 一致')
      im02.check('无成功气泡', (await session.agentBubbleCount()) === beforeBubbles, `${beforeBubbles} → ${await session.agentBubbleCount()}`)
      im02.check('取消后界面仍可操作', await session.page.getByRole('textbox', { name: '剪辑反馈' }).isEnabled(), '反馈输入框可编辑')
      await im02.screenshot(session.page, 'after-cancel')
      await im02.finish('通过', '空状态与已有项目两次取消均未产生项目/修订，界面保持可用')
    }

    // ══ IM-03：五种容器格式（mp4=F1，其余为边界 container.*） ═════════
    {
      const formats: { fmt: string; file: string; note: string }[] = [
        { fmt: 'mp4', file: MATERIALS.F1, note: 'F1 基准' },
        { fmt: 'mov', file: MATERIALS.boundary('container.mov'), note: 'MOV 容器' },
        { fmt: 'mkv', file: MATERIALS.boundary('container.mkv'), note: 'Matroska 容器' },
        { fmt: 'webm', file: MATERIALS.boundary('container.webm'), note: 'VP9/Opus WebM' },
        { fmt: 'm4v', file: MATERIALS.boundary('container.m4v'), note: 'M4V 扩展名' },
      ]
      for (const entry of formats) {
        const srcAbs = materialPath(entry.file)
        const srcProbe = await probeMedia(srcAbs)
        const im03 = new Case({
          id: 'IM-03', variant: `M/${entry.fmt}`, mode: 'M', material: entry.file,
          materialSpec: `${entry.note}；源编码 ${srcProbe.videoCodec ?? '?'}/${srcProbe.audioCodec ?? '无音轨'}`,
          expected: '该格式独立导入、播放、导出成功；记录实际音视频编码（不只记扩展名）',
        })
        try {
          await session.stubDialogs({ video: srcAbs })
          await session.importVideo()
          await session.waitDraftReady()
          const pid = (await session.listProjects())[0]!.projectId
          const st = await session.state(pid)
          im03.check('导入建稿非空', st.timeline.clips.length > 0, `${st.timeline.clips.length} 段`)
          const outPath = outDir(`IM-03-${entry.fmt}.mp4`)
          await mkdir(path.dirname(outPath), { recursive: true })
          await session.exportTo(outPath)
          const outProbe = await probeMedia(outPath)
          im03.check('导出可解码', outProbe.durationSec > 0 && outProbe.videoCodec === 'h264',
            `输出 ${outProbe.videoCodec}/${outProbe.audioCodec}，${outProbe.durationSec.toFixed(2)}s`)
          im03.record.output = { path: outPath, durationSec: outProbe.durationSec, width: outProbe.width, height: outProbe.height }
          await im03.saveEvidence('codecs', JSON.stringify({ source: { ...srcProbe, raw: undefined }, output: { ...outProbe, raw: undefined } }, null, 2))
          await im03.finish('通过', `源 ${srcProbe.videoCodec}/${srcProbe.audioCodec ?? '无'} → 输出 ${outProbe.videoCodec}/${outProbe.audioCodec}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          let errorText = ''
          try { errorText = await session.waitForError(5000) } catch { /* 无错误条 */ }
          await im03.screenshot(session.page, 'failure')
          await im03.finish('失败', `${entry.fmt} 导入/导出失败：${message.slice(0, 160)}；错误条="${errorText.slice(0, 80)}"`)
        }
      }
    }

    // ══ IM-04：F2 竖屏，正常与最小窗口，导出 720×1280 ═════════════════
    {
      const im04 = new Case({
        id: 'IM-04', variant: 'M/F2', mode: 'M', material: MATERIALS.F2,
        expected: '竖屏画面完整不拉伸不溢出预览区域；成片 720×1280，无强制横屏或裁切',
      })
      await session.stubDialogs({ video: materialPath(MATERIALS.F2) })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const ratio = await session.page.evaluate(() => {
        const v = document.querySelector('video')
        return v && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : 0
      })
      im04.check('宽高比 ≈ 720/1280（±0.05）', Math.abs(ratio - 720 / 1280) <= 0.05, `ratio=${ratio.toFixed(4)}`)
      const normal = await videoInsideStage(session.page)
      im04.check('正常窗口不溢出 .stage', normal.inside, JSON.stringify(normal.video))
      await session.page.setViewportSize({ width: 960, height: 640 })
      await session.page.waitForTimeout(500)
      const minimal = await videoInsideStage(session.page)
      im04.check('最小允许窗口（960×640）不溢出 .stage', minimal.inside, JSON.stringify(minimal.video))
      await session.page.setViewportSize({ width: 1280, height: 800 })
      const outPath = outDir('IM-04-portrait.mp4')
      await mkdir(path.dirname(outPath), { recursive: true })
      await session.exportTo(outPath)
      const outProbe = await probeMedia(outPath)
      im04.check('导出 720×1280', outProbe.width === 720 && outProbe.height === 1280, `${outProbe.width}×${outProbe.height}`)
      im04.record.output = { path: outPath, durationSec: outProbe.durationSec, width: outProbe.width, height: outProbe.height }
      await im04.screenshot(session.page, 'portrait-draft')
      await im04.finish('通过', `竖屏导入/预览/导出正常（${outProbe.width}×${outProbe.height}）`)
    }

    // ══ IM-05：F3 奇数尺寸（FFV1 mkv），导出 642×362 ═══════════════════
    {
      const im05 = new Case({
        id: 'IM-05', variant: 'M/F3', mode: 'M', material: MATERIALS.F3,
        expected: '导出 642×362（不是 641×361，也不是固定 1080×1920）；画面无明显变形',
      })
      try {
        await session.stubDialogs({ video: materialPath(MATERIALS.F3) })
        await session.importVideo()
        const decodable = await waitDraftDecodable(session)
        if (!decodable) {
          im05.record.defects.push('观察：FFV1 源在 Chromium 草稿预览中无法解码（浏览器解码能力限制），尺寸核对按文档改用导出探测完成')
        }
        const outPath = outDir('IM-05-odd.mp4')
        await mkdir(path.dirname(outPath), { recursive: true })
        await session.exportTo(outPath)
        const outProbe = await probeMedia(outPath)
        im05.check('导出 642×362（偶数化）', outProbe.width === 642 && outProbe.height === 362, `${outProbe.width}×${outProbe.height}`)
        im05.check('不是原始奇数 641×361', !(outProbe.width === 641 && outProbe.height === 361), `${outProbe.width}×${outProbe.height}`)
        im05.check('不是固定 1080×1920', !(outProbe.width === 1080 && outProbe.height === 1920), `${outProbe.width}×${outProbe.height}`)
        im05.record.output = { path: outPath, durationSec: outProbe.durationSec, width: outProbe.width, height: outProbe.height }
        await im05.finish('通过', `奇数尺寸源导出为 ${outProbe.width}×${outProbe.height}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        let errorText = ''
        try { errorText = await session.waitForError(5000) } catch { /* 无错误条 */ }
        await im05.screenshot(session.page, 'failure')
        await im05.finish('失败', `F3 导入/导出失败：${message.slice(0, 160)}；错误条="${errorText.slice(0, 80)}"`)
      }
    }

    // ══ IM-06：F6 无音轨（M 对照） ═════════════════════════════════════
    {
      const im06 = new Case({
        id: 'IM-06', variant: 'M/F6 无音轨', mode: 'M', material: MATERIALS.F6,
        expected: 'R 主验：可见可理解的无音轨错误且不保存坏草稿；M 可能生成占位草稿——单独记录，不证明真实防护',
      })
      await session.stubDialogs({ video: materialPath(MATERIALS.F6) })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const st = await session.state(pid)
      const segments = st.transcript?.segments.length ?? 0
      im06.record.defects.push(
        `限制已确认（M 模式局限）：mock 转写不依赖音轨，无音轨文件照常建稿成功（${st.timeline.clips.length} 段占位草稿，占位转写 ${segments} 句）；` +
        'M 无法证明真实转写的无音轨防护，R 批次主验。',
      )
      await im06.saveEvidence('draft-state', JSON.stringify(st, null, 2))
      await im06.finish('限制已确认', `mock 下建稿成功：${st.timeline.clips.length} 段占位草稿（无音轨未报错）；真实防护在 R 批次验证`)
    }

    // ══ IM-07：F5 全静音轨（M 对照） ═══════════════════════════════════
    {
      const im07 = new Case({
        id: 'IM-07', variant: 'M/F5 全静音轨', mode: 'M', material: MATERIALS.F5,
        expected: '不把全静音识别成大量不存在的话；M 占位文字不计入幻觉判断，真实行为 R 主验',
      })
      await session.stubDialogs({ video: materialPath(MATERIALS.F5) })
      await session.importVideo()
      await session.waitDraftReady()
      const pid = (await session.listProjects())[0]!.projectId
      const st = await session.state(pid)
      const segments = st.transcript?.segments.length ?? 0
      im07.record.defects.push(
        `限制已确认（M 模式局限）：mock 转写无视真实音轨，为 8s 静音轨生成了 ${segments} 段占位中文（「第 N 句：呃…」）；` +
        '占位文字与音轨无关，不能据此判断全静音是否被虚构识别，R 批次主验。',
      )
      await im07.saveEvidence('draft-state', JSON.stringify(st, null, 2))
      await im07.finish('限制已确认', `mock 占位行为：8s 静音轨 → ${segments} 段占位草稿；真实幻觉判断在 R 批次`)
    }

    // ══ IM-08：极短视频（F7 与边界 one-frame） ═════════════════════════
    {
      const shortMaterials = [
        { name: 'F7', file: MATERIALS.F7 },
        { name: 'one-frame', file: MATERIALS.boundary('one-frame.mp4') },
      ]
      for (const entry of shortMaterials) {
        const im08 = new Case({
          id: 'IM-08', variant: `M/${entry.name}`, mode: 'M', material: entry.file,
          expected: '时长使用实际值；非空合法结果可播放，无无限循环或越界跳转；无法处理时有明确错误且不影响旧项目',
        })
        try {
          const srcAbs = materialPath(entry.file)
          const srcProbe = await probeMedia(srcAbs)
          await session.stubDialogs({ video: srcAbs })
          await session.importVideo()
          await session.waitDraftReady()
          const pid = (await session.listProjects())[0]!.projectId
          const st = await session.state(pid)
          im08.check('非空草稿（时长按实际值）', st.timeline.clips.length > 0,
            `${st.timeline.clips.length} 段；源实际时长 ${srcProbe.durationSec.toFixed(3)}s`)
          // 播放到结束
          await session.page.locator('.clip').first().click()
          let ended = false
          for (let i = 0; i < 40; i++) {
            await session.page.waitForTimeout(250)
            const v = await readVideo(session.page)
            if (v?.paused) { ended = true; break }
          }
          im08.check('播放到结束（无无限循环）', ended, '播放进入暂停态')
          const url = await session.renderPreview()
          await session.page.waitForFunction(() => {
            const v = document.querySelector('video')
            return !!v && v.readyState >= 2 && v.videoWidth > 0 && v.playbackRate === 1
          }, undefined, { timeout: 60000 })
          im08.check('效果预览可播放', url.startsWith('pimko-media://media/'), url.slice(0, 70))
          await im08.finish('通过', `极短素材（${srcProbe.durationSec.toFixed(3)}s）导入、播放、效果预览均正常`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          let errorText = ''
          try { errorText = await session.waitForError(5000) } catch { /* 无错误条 */ }
          im08.record.defects.push(`实际最低可用边界观察：${entry.name} 在导入/播放/预览环节失败：${message.slice(0, 200)}`)
          await im08.screenshot(session.page, 'failure')
          await im08.finish('失败', `${entry.name} 失败：${message.slice(0, 140)}；错误条="${errorText.slice(0, 80)}"`)
        }
      }
    }

    // ══ IM-09：特殊路径 / 旋转 / 非方形像素 / 可变帧率 ═════════════════
    {
      const special: { name: string; file: string; note: string }[] = [
        { name: 'special-path', file: MATERIALS.boundary("中文 空格 (括号) quote' & [test].mp4"), note: '中文、空格、单引号与符号路径' },
        { name: 'rotate90', file: MATERIALS.boundary('rotation-90.mp4'), note: '横向编码 + 90° 显示矩阵（未保证支持）' },
        { name: 'sar', file: MATERIALS.boundary('non-square-pixels.mp4'), note: 'SAR 4:3 非方形像素（未保证支持）' },
        { name: 'vfr', file: MATERIALS.boundary('variable-frame-rate.mp4'), note: '交错帧间隔可变帧率（未保证支持）' },
      ]
      for (const entry of special) {
        const im09 = new Case({
          id: 'IM-09', variant: `M/${entry.name}`, mode: 'M', material: entry.file,
          materialSpec: entry.note,
          expected: '独立导入、预览、导出成功；记录输出尺寸与旋转元数据；路径未截断；未保证支持项按实际观察记录',
        })
        try {
          const srcAbs = materialPath(entry.file)
          const srcProbe = await probeMedia(srcAbs)
          await session.stubDialogs({ video: srcAbs })
          await session.importVideo()
          const decodable = await waitDraftDecodable(session)
          if (!decodable) im09.record.defects.push(`观察：${entry.name} 源在草稿预览中无法解码（浏览器解码限制），继续验证导出`)
          const outPath = outDir(`IM-09-${entry.name}.mp4`)
          await mkdir(path.dirname(outPath), { recursive: true })
          await session.exportTo(outPath)
          const outProbe = await probeMedia(outPath)
          im09.check('导出可解码', outProbe.durationSec > 0 && outProbe.videoCodec === 'h264',
            `输出 ${outProbe.width}×${outProbe.height}，${outProbe.durationSec.toFixed(2)}s`)
          im09.record.output = { path: outPath, durationSec: outProbe.durationSec, width: outProbe.width, height: outProbe.height }
          await im09.saveEvidence('rotation', JSON.stringify({
            source: { width: srcProbe.width, height: srcProbe.height, rotation: srcProbe.rotation, videoCodec: srcProbe.videoCodec },
            output: { width: outProbe.width, height: outProbe.height, rotation: outProbe.rotation },
          }, null, 2))
          if (entry.name === 'special-path') {
            im09.check('特殊路径未截断（导入+导出走通）', true, `文件名含空格/引号/括号仍成功：${path.basename(srcAbs)}`)
            await im09.finish('通过', `特殊路径导入预览导出全部成功，输出 ${outProbe.width}×${outProbe.height}`)
          } else if (entry.name === 'rotate90') {
            const sideways = outProbe.width !== undefined && outProbe.height !== undefined
              && outProbe.width < outProbe.height && srcProbe.width !== undefined && srcProbe.width > (srcProbe.height ?? 0)
            im09.record.defects.push(
              `限制已确认（未保证支持项）：源 ${srcProbe.width}×${srcProbe.height}（rotation=${srcProbe.rotation || '无'}）→ 输出 ${outProbe.width}×${outProbe.height}` +
              (sideways ? '；输出呈侧倒尺寸（如 360×640），显示方向正确性需人工复核' : '；输出保持编码尺寸，旋转矩阵是否被应用需人工复核画面方向'),
            )
            await im09.finish('限制已确认', `旋转元数据条目按实际观察记录：输出 ${outProbe.width}×${outProbe.height}，rotation=${outProbe.rotation || '无'}`)
          } else if (entry.name === 'sar') {
            im09.record.defects.push(
              `限制已确认（未保证支持项）：源 SAR 4:3 → 输出 ${outProbe.width}×${outProbe.height}（渲染器强制 setsar=1）；` +
              '按显示比例观察是否压扁/拉长需人工复核圆形与方格图案，M 无法判定',
            )
            await im09.finish('限制已确认', `非方形像素条目输出 ${outProbe.width}×${outProbe.height}，显示比例正确性需人工复核`)
          } else {
            im09.record.defects.push(
              '限制已确认（未保证支持项）：VFR 源导入/预览/导出走通；跳切/变速/导出的累积音画偏移属人工听看项，M 无法验证同步精度',
            )
            await im09.finish('通过', `VFR 导入预览导出成功（输出 ${outProbe.width}×${outProbe.height}）；音画偏移人工项已记录`)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          let errorText = ''
          try { errorText = await session.waitForError(5000) } catch { /* 无错误条 */ }
          im09.record.defects.push(`${entry.name} 实际能力边界：导入/导出失败——${message.slice(0, 200)}`)
          await im09.screenshot(session.page, 'failure')
          await im09.finish('失败', `${entry.name} 失败：${message.slice(0, 140)}；错误条="${errorText.slice(0, 80)}"`)
        }
      }
    }

    // ══ IM-13：正方形 / 1fps / 纯音频 ═══════════════════════════════════
    {
      // square
      {
        const im13 = new Case({
          id: 'IM-13', variant: 'M/square', mode: 'M', material: MATERIALS.boundary('square.mp4'),
          expected: '正方形保持 1:1，导出 320×320，不拉伸',
        })
        try {
          await session.stubDialogs({ video: materialPath(MATERIALS.boundary('square.mp4')) })
          await session.importVideo()
          await session.waitDraftReady()
          const outPath = outDir('IM-13-square.mp4')
          await mkdir(path.dirname(outPath), { recursive: true })
          await session.exportTo(outPath)
          const outProbe = await probeMedia(outPath)
          im13.check('导出 320×320', outProbe.width === 320 && outProbe.height === 320, `${outProbe.width}×${outProbe.height}`)
          im13.record.output = { path: outPath, durationSec: outProbe.durationSec, width: outProbe.width, height: outProbe.height }
          await im13.finish('通过', '正方形 1:1 全链路保持')
        } catch (err) {
          await im13.finish('失败', `square 失败：${err instanceof Error ? err.message.slice(0, 140) : String(err)}`)
        }
      }
      // low-fps（one-fps.mp4）
      {
        const im13 = new Case({
          id: 'IM-13', variant: 'M/low-fps', mode: 'M', material: MATERIALS.boundary('one-fps.mp4'),
          expected: '1fps 稀疏画面可导入预览导出；导出时长与音频连续，不额外截断',
        })
        try {
          await session.stubDialogs({ video: materialPath(MATERIALS.boundary('one-fps.mp4')) })
          await session.importVideo()
          await session.waitDraftReady()
          const pid = (await session.listProjects())[0]!.projectId
          const st = await session.state(pid)
          const outPath = outDir('IM-13-low-fps.mp4')
          await mkdir(path.dirname(outPath), { recursive: true })
          await session.exportTo(outPath)
          const outProbe = await probeMedia(outPath)
          const expectDur = (st.timeline.clips.reduce((sum, c) => sum + (c.sourceEndSec - c.sourceStartSec) / (c.speed ?? 1), 0))
          const tol = Math.max(0.6, expectDur * 0.06)
          im13.check('导出时长与时间线一致', Math.abs(outProbe.durationSec - expectDur) <= tol,
            `实际 ${outProbe.durationSec.toFixed(2)}s vs 期望 ${expectDur.toFixed(2)}s`)
          im13.record.output = { path: outPath, durationSec: outProbe.durationSec, width: outProbe.width, height: outProbe.height }
          await im13.finish('通过', `1fps 素材导出 ${outProbe.durationSec.toFixed(2)}s（时间线 ${expectDur.toFixed(2)}s）`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // 直击复现：用渲染器同款逐段裁切命令直接打 one-fps 源，判定挂起发生在哪一层
          let repro = '未执行'
          try {
            const reproOut = outDir('IM-13-low-fps-repro.mp4')
            const started = Date.now()
            await execFileAsync('ffmpeg', [
              '-y', '-v', 'error', '-ss', '0', '-to', '4', '-i', materialPath(MATERIALS.boundary('one-fps.mp4')),
              '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,setsar=1',
              '-r', '30', '-c:a', 'aac', '-ar', '48000', '-ac', '2', reproOut,
            ], { timeout: 90000 })
            repro = `ffmpeg 直裁 1fps 源成功（${((Date.now() - started) / 1000).toFixed(1)}s）→ 挂起在应用管线层`
          } catch (reproErr) {
            repro = `ffmpeg 直裁 1fps 源同样失败/超时（${String(reproErr).slice(0, 120)}）→ ffmpeg 层行为`
          }
          im13.record.defects.push(`1fps 导出超时（复现）；层定位：${repro}`)
          await im13.finish('失败', `low-fps 失败：${message.slice(0, 120)}；${repro}`)
        }
      }
      // audio-only 应被拒绝
      {
        const im13 = new Case({
          id: 'IM-13', variant: 'M/audio-only', mode: 'M', material: MATERIALS.boundary('audio-only.mp4'),
          expected: '纯音频 MP4 明确提示没有视频轨，不创建假视频项目，且能继续导入有效视频',
        })
        const beforeCount = (await session.listProjects()).length
        await session.stubDialogs({ video: materialPath(MATERIALS.boundary('audio-only.mp4')) })
        await session.button('导入视频').click()
        const errorText = await session.waitForError(60000)
        im13.check('错误条可见且含「文件中没有视频轨」', errorText.includes('文件中没有视频轨'), `"${errorText.slice(0, 90)}"`)
        const afterCount = (await session.listProjects()).length
        im13.check('不新增假项目', afterCount === beforeCount, `${beforeCount} → ${afterCount}`)
        // 恢复能力：随后导入 F1 仍成功
        await session.stubDialogs({ video: F1() })
        await session.importVideo()
        im13.check('之后仍能导入有效视频', (await session.listProjects()).length === afterCount + 1, 'F1 导入成功')
        await im13.screenshot(session.page, 'audio-only-rejected')
        await im13.finish('通过', '纯音频 MP4 被明确拒绝且应用可继续使用')
      }
    }

    // ══ IM-14：4K 短文件 ════════════════════════════════════════════════
    {
      const im14 = new Case({
        id: 'IM-14', variant: 'M/4K', mode: 'M', material: MATERIALS.boundary('4k-short.mp4'),
        expected: '不白屏；若支持则输出 3840×2160 且可播放；若失败准确记录能力边界',
      })
      try {
        await session.stubDialogs({ video: materialPath(MATERIALS.boundary('4k-short.mp4')) })
        const started = Date.now()
        await session.importVideo(300000)
        await session.waitDraftReady()
        const importSec = (Date.now() - started) / 1000
        const outPath = outDir('IM-14-4k.mp4')
        await mkdir(path.dirname(outPath), { recursive: true })
        const exportStarted = Date.now()
        await session.exportTo(outPath, 600000)
        const exportSec = (Date.now() - exportStarted) / 1000
        const outProbe = await probeMedia(outPath)
        im14.check('导出 3840×2160', outProbe.width === 3840 && outProbe.height === 2160, `${outProbe.width}×${outProbe.height}`)
        im14.check('可解码', outProbe.durationSec > 0, `${outProbe.durationSec.toFixed(2)}s`)
        im14.record.output = { path: outPath, durationSec: outProbe.durationSec, width: outProbe.width, height: outProbe.height }
        im14.record.cache = { importSeconds: Number(importSec.toFixed(1)), exportSeconds: Number(exportSec.toFixed(1)) }
        await im14.screenshot(session.page, 'after-import')
        await im14.finish('通过', `4K 导入 ${importSec.toFixed(1)}s、导出 ${exportSec.toFixed(1)}s，输出 ${outProbe.width}×${outProbe.height}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        let errorText = ''
        try { errorText = await session.waitForError(5000) } catch { /* 无错误条 */ }
        im14.record.defects.push(`4K 能力边界观察（CI 资源不足或能力不足均可能）：${message.slice(0, 200)}`)
        await im14.screenshot(session.page, 'failure')
        await im14.finish('失败', `4K 导入/导出失败：${message.slice(0, 160)}；错误条="${errorText.slice(0, 80)}"`)
      }
    }

    // ══ FA-01：零字节 / 伪装 MP4 / 截断文件 ═════════════════════════════
    {
      // 先建基线项目（旧项目对照）
      await session.stubDialogs({ video: F1() })
      await session.importVideo()
      await session.waitDraftReady()
      const baselineCount = (await session.listProjects()).length
      const badFiles = [
        { name: 'zero-byte', file: MATERIALS.boundary('empty.mp4') },
        { name: 'fake-mp4', file: MATERIALS.boundary('not-video.mp4') },
        { name: 'truncated', file: MATERIALS.boundary('truncated.mp4') },
      ]
      for (const entry of badFiles) {
        const fa01 = new Case({
          id: 'FA-01', variant: `M/${entry.name}`, mode: 'M', material: entry.file,
          expected: '错误可见且不白屏，不新增假草稿；旧项目不变；有效材料仍可用；若只出现不可理解的 ffprobe 输出记报错可理解性失败',
        })
        const beforeCount = (await session.listProjects()).length
        await session.stubDialogs({ video: materialPath(entry.file) })
        await session.button('导入视频').click()
        const errorText = await session.waitForError(60000)
        fa01.check('错误条可见', errorText.length > 0, `"${errorText.slice(0, 90)}"`)
        const alive = await session.page.evaluate(() => document.body.innerText.length > 20 && !!document.querySelector('.app'))
        fa01.check('不白屏', alive, '应用外壳与文本仍在')
        const afterList = await session.listProjects()
        fa01.check('不新增假草稿', afterList.length === beforeCount, `${beforeCount} → ${afterList.length}；末位=${afterList[0]?.name ?? '?'}`)
        // 随后导入 F1 仍成功；旧项目仍在
        await session.stubDialogs({ video: F1() })
        await session.importVideo()
        await session.waitDraftReady()
        const finalList = await session.listProjects()
        fa01.check('有效材料仍可导入', finalList.length === afterList.length + 1, `${afterList.length} → ${finalList.length}；末位=${finalList[0]?.name ?? '?'}`)
        fa01.check('旧项目仍在', finalList.length >= baselineCount, `${finalList.length} ≥ 基线 ${baselineCount}`)
        // 报错可理解性：中文友好文案 vs 原始 ffprobe/系统输出
        const friendly = /[\u4e00-\u9fff]/.test(errorText) && !/Command failed|stderr|Exit code|\bat \S+\(/.test(errorText)
        if (!friendly) {
          fa01.record.defects.push(
            '报错可理解性失败：错误条为原始 ffprobe/系统输出，未转译为用户可理解文案；' +
            '按文档规则——错误可见且不白屏成立，故整体记「限制已确认」并写明该差距',
          )
        }
        await fa01.saveEvidence('error-text', errorText, 'log')
        await fa01.screenshot(session.page, 'error')
        await fa01.finish(friendly ? '通过' : '限制已确认',
          `错误可见且不白屏，旧项目保留${friendly ? '，报错可理解' : '；报错为原始输出（可理解性差距已记录）'}`)
      }
    }

    await session.close()
  })
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
