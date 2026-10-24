import { _electron as electron } from 'playwright'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

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
    await page.getByRole('button', { name: '选择视频' }).click()

    const video = page.locator('video')
    await video.waitFor({ state: 'visible', timeout: 180000 })
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
    if (!stageFits) {
      throw new Error(`视频超出预览区: video=${JSON.stringify(videoBox)} stage=${JSON.stringify(stageBox)}`)
    }
    if (Math.abs(renderedRatio - intrinsicRatio) > 0.05) {
      throw new Error(`视频渲染比例失真: rendered=${renderedRatio.toFixed(3)} intrinsic=${intrinsicRatio.toFixed(3)}`)
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
