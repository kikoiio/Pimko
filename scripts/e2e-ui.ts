import { _electron as electron } from 'playwright'
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
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
    await video.waitFor({ state: 'visible', timeout: 30000 })
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

    const result = { status, agentBubbles, clips }
    console.log(JSON.stringify(result, null, 2))

    if (status.videoWidth === 0 || status.readyState < 2) {
      throw new Error(`视频未真正加载: ${JSON.stringify(status)}`)
    }
    if (agentBubbles < 1 || clips < 1) {
      throw new Error(`草稿 UI 未渲染: bubbles=${agentBubbles} clips=${clips}`)
    }
  } finally {
    await app.close()
  }
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
