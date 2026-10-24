import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 打包前收集 ffmpeg/ffprobe 静态二进制到 resources/bin,
 * 供 electron-builder extraResources 随包分发(用户机器无需安装 ffmpeg)。
 */

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  const ffmpegSource = require('ffmpeg-static') as string
  const ffprobeSource = (require('ffprobe-static') as { path: string }).path
  const outDir = path.resolve(here, '..', 'resources', 'bin')
  await mkdir(outDir, { recursive: true })
  const windows = process.platform === 'win32'
  const targets: Array<[string, string]> = [
    [ffmpegSource, windows ? 'ffmpeg.exe' : 'ffmpeg'],
    [ffprobeSource, windows ? 'ffprobe.exe' : 'ffprobe'],
  ]
  for (const [source, name] of targets) {
    const dest = path.join(outDir, name)
    await copyFile(source, dest)
    if (!windows) await chmod(dest, 0o755)
    console.log(`collected ${name} <- ${source}`)
  }
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
