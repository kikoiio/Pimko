import { _electron as electron } from 'playwright'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { PimkoApi } from '../src/shared/api'

declare global {
  interface Window {
    pimko: PimkoApi
  }
}

const execFileAsync = promisify(execFile)
const root = path.resolve(__dirname, '..')

async function main(): Promise<void> {
  const tmpDir = path.join(root, '.tmp')
  await mkdir(tmpDir, { recursive: true })

  let sample = process.env.PIMKO_E2E_VIDEO
  if (!sample) {
    sample = path.join(tmpDir, 'e2e-input.mp4')
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=6:size=640x360:rate=30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      sample,
    ])
  }

  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron'),
    args: [path.join(root, 'out/main/index.js'), '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      PIMKO_SELF_TEST_VIDEO: sample,
      PIMKO_LLM_PROVIDER: process.env.PIMKO_LLM_PROVIDER ?? 'mock',
    },
  })

  try {
    const page = await app.firstWindow()
    // 失败时把页面文本和控制台带进 artifact，避免只看到超时。
    const consoleLines: string[] = []
    page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`))
    page.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`))
    const video = page.locator('video')
    const errorBar = page.locator('.error-bar')

    // 免费模型偶发 429：错误条出现时先等一会儿再重试，而不是干等 3 分钟。
    let retries = 0
    for (;;) {
      await page.getByRole('button', { name: '选择视频' }).click()
      let outcome: 'video' | 'error' | 'timeout' = 'timeout'
      const deadline = Date.now() + 150000
      while (Date.now() < deadline) {
        if (await video.isVisible().catch(() => false)) {
          outcome = 'video'
          break
        }
        if (await errorBar.isVisible().catch(() => false)) {
          outcome = 'error'
          break
        }
        await page.waitForTimeout(1000)
      }
      if (outcome === 'video') break
      const text = await page.evaluate(() => document.body.innerText).catch(() => '')
      if (/限流|频繁|稍等/.test(text) && retries < 1) {
        retries++
        console.log('免费模型限流，60 秒后重试导入')
        await page.waitForTimeout(60000)
        continue
      }
      await writeFile(
        path.join(tmpDir, 'pimko-e2e-error.txt'),
        `页面文本：\n${text}\n\n控制台：\n${consoleLines.join('\n')}\n`,
      )
      await page.screenshot({ path: path.join(tmpDir, 'pimko-e2e-failure.png') }).catch(() => {})
      throw new Error(outcome === 'error' ? `导入失败：${text.slice(0, 300)}` : '等待预览视频超时')
    }
    await page.waitForFunction(
      () => {
        const el = document.querySelector('video')
        return !!el && el.readyState >= 2 && el.videoWidth > 0 && el.videoHeight > 0
      },
      { timeout: 30000 },
    )
    const status = await video.evaluate((el) => {
      const v = el as HTMLVideoElement
      return {
        readyState: v.readyState,
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        errorCode: v.error?.code ?? null,
        src: v.src.slice(0, 90),
      }
    })
    const agentBubbles = await page.locator('.bubble.agent').count()
    const clips = await page.locator('.clip').count()
    const videoBox = await video.boundingBox()
    const stageBox = await page.locator('.stage').boundingBox()
    const renderedRatio = videoBox && videoBox.height > 0 ? videoBox.width / videoBox.height : 0
    const intrinsicRatio = status.videoWidth / status.videoHeight
    const stageFits = videoBox && stageBox
      ? videoBox.width <= stageBox.width + 1 && videoBox.height <= stageBox.height + 1
      : false
    await page.screenshot({ path: path.join(tmpDir, 'pimko-e2e.png') })
    await writeFile(path.join(tmpDir, 'pimko-e2e-result.json'), `${JSON.stringify({
      status,
      agentBubbles,
      clips,
      videoBox,
      renderedRatio,
      intrinsicRatio,
      stageFits,
    }, null, 2)}\n`)

    console.log(`screenshot: ${path.join(tmpDir, 'pimko-e2e.png')}`)

    if (status.videoWidth === 0 || status.readyState < 2) {
      throw new Error(`视频未真正加载: ${JSON.stringify(status)}`)
    }
    if (agentBubbles < 1 || clips < 1) {
      throw new Error(`草稿 UI 未渲染: bubbles=${agentBubbles} clips=${clips}`)
    }
    const restored = await page.evaluate(async () => {
      const list = await window.pimko.listProjects()
      if (list.length === 0) return { ok: false, reason: 'no projects' }
      const result = await window.pimko.restoreProject(list[0]!.projectId)
      const transcript = result.revision.project.transcript
      const words = transcript?.segments.reduce((sum, segment) => sum + (segment.words?.length ?? 0), 0) ?? 0
      return {
        ok: result.revision.project.timeline.clips.length > 0,
        projectId: list[0]!.projectId,
        transcriptSegments: transcript?.segments.length ?? 0,
        wordTimestamps: words,
      }
    })
    if (!restored.ok) throw new Error(`项目恢复失败: ${JSON.stringify(restored)}`)
    if (restored.wordTimestamps === 0) {
      throw new Error(`转写缺少词级时间戳: ${JSON.stringify(restored)}`)
    }
    await page.locator('.clip-thumb').first().waitFor({ state: 'visible', timeout: 30000 })
    const thumbs = await page.locator('.clip-thumb').count()
    if (thumbs < 1) throw new Error('片段缩略图未渲染')
    if (!stageFits) {
      throw new Error(`视频超出预览区: video=${JSON.stringify(videoBox)} stage=${JSON.stringify(stageBox)}`)
    }
    if (Math.abs(renderedRatio - intrinsicRatio) > 0.05) {
      throw new Error(`视频渲染比例失真: rendered=${renderedRatio.toFixed(3)} intrinsic=${intrinsicRatio.toFixed(3)}`)
    }
    // mock 作业覆盖实际 UI 的连续修改、撤销和导出；真实模型作业保留独立的联网验收。
    if ((process.env.PIMKO_LLM_PROVIDER ?? 'mock') === 'mock') {
      const original = await page.evaluate(async (id) =>
        (await window.pimko.restoreProject(id)).revision.project.timeline, restored.projectId!)
      await page.getByRole('button', { name: '查看实际效果' }).click()
      await page.getByRole('tab', { name: '效果预览', exact: true }).waitFor({ timeout: 120000 })
      await page.waitForFunction(() => {
        const video = document.querySelector('video')
        return video !== null && video.readyState >= 2 && video.videoWidth > 0 && video.playbackRate === 1
      })
      if (await page.locator('.subtitle-overlay').count() !== 0) throw new Error('效果预览重复叠加字幕')
      const cachedPreviewUrl = await page.locator('video').getAttribute('src')
      await page.getByRole('button', { name: '查看实际效果' }).click()
      await page.getByRole('button', { name: '查看实际效果' }).waitFor()
      if (await page.locator('video').getAttribute('src') !== cachedPreviewUrl) throw new Error('同版本预览未命中缓存')
      for (const speed of [2, 1]) {
        const bubbleCount = await page.locator('.bubble.agent').count()
        await page.getByRole('textbox', { name: '剪辑反馈' }).fill(`第一段 ${speed} 倍速`)
        await page.getByRole('button', { name: '发送', exact: true }).click()
        await page.waitForFunction((count) => document.querySelectorAll('.bubble.agent').length > count, bubbleCount)
        const updated = await page.evaluate(async (id) =>
          (await window.pimko.restoreProject(id)).revision.project.timeline, restored.projectId!)
        if ((updated.clips[0]?.speed ?? 1) !== speed) throw new Error(`界面变速未生效：${speed}`)
        if (await page.getByRole('tab', { name: '效果预览', exact: true }).count() !== 0) throw new Error('修改后仍显示旧效果预览')
      }
      for (let i = 0; i < 2; i++) {
        const bubbleCount = await page.locator('.bubble.agent').count()
        await page.getByRole('button', { name: '撤销上一步' }).click()
        await page.waitForFunction((count) => document.querySelectorAll('.bubble.agent').length > count, bubbleCount)
      }
      const undone = await page.evaluate(async (id) =>
        (await window.pimko.restoreProject(id)).revision.project.timeline, restored.projectId!)
      if (JSON.stringify(undone) !== JSON.stringify(original)) throw new Error('连续撤销没有恢复初稿')
      const exportPath = path.join(tmpDir, 'e2e-output.mp4')
      await app.evaluate(({ dialog }, outputPath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: outputPath })
      }, exportPath)
      await page.getByRole('button', { name: '生成成片', exact: true }).click()
      await page.getByRole('tab', { name: '成片预览' }).waitFor({ timeout: 120000 })
      await page.waitForFunction(() => {
        const video = document.querySelector('video')
        return video !== null && video.readyState >= 2 && video.videoWidth > 0 && video.playbackRate === 1
      })
      console.log('UI lifecycle passed: two revisions → two undos → export → playable output')
    }
  } finally {
    for (const page of app.windows()) {
      try {
        await page.screenshot({ path: path.join(tmpDir, 'pimko-e2e-final.png') })
      } catch {
        // 窗口可能已被关闭
      }
    }
    await app.close()
  }
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
