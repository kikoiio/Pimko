import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Editor } from '../src/services/editor'
import { FfmpegProber } from '../src/infra/ffmpeg-prober'
import { FfmpegRenderer } from '../src/infra/ffmpeg-renderer'
import { FsProjectStore } from '../src/infra/fs-store'
import { MockIntelligence } from '../src/infra/mock-intelligence'
import { MockTranscriber } from '../src/infra/mock-transcriber'

const execFileAsync = promisify(execFile)

async function main(): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pimko-smoke-'))
  try {
    const inputPath = path.join(workDir, 'input.mp4')
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      inputPath,
    ])

    const storeRoot = path.join(workDir, 'projects')
    const editor = new Editor({
      prober: new FfmpegProber(),
      transcriber: new MockTranscriber(),
      intelligence: new MockIntelligence(),
      renderer: new FfmpegRenderer(),
      store: new FsProjectStore(storeRoot),
    })

    const draft = await editor.createDraft(inputPath, 'smoke')
    console.log(`draft: ${draft.project.timeline.clips.length} clips`)
    const asset = draft.project.assets[0]!
    if (draft.project.settings.width !== asset.width || draft.project.settings.height !== asset.height) {
      throw new Error(`导出尺寸应跟随源视频: got ${draft.project.settings.width}x${draft.project.settings.height}, source ${asset.width}x${asset.height}`)
    }

    const revised = await editor.revise(draft.project.id, { text: '开头太拖' })
    console.log(`revised: parent=${revised.parentRevisionId === draft.id}`)

    const outputPath = path.join(workDir, 'output.mp4')
    await editor.export(revised.project.id, outputPath)

    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', outputPath,
    ])
    const duration = Number((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('导出文件无效')
    const probeOut = await execFileAsync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', outputPath,
    ])
    const outVideo = (JSON.parse(probeOut.stdout) as { streams?: { codec_type?: string; width?: number; height?: number }[] })
      .streams?.find((s) => s.codec_type === 'video')
    if (outVideo?.width !== asset.width || outVideo?.height !== asset.height) {
      throw new Error(`输出分辨率错误: ${outVideo?.width}x${outVideo?.height}`)
    }
    console.log(`export ok: ${outputPath} (${duration.toFixed(2)}s)`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
