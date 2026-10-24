import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Editor } from '../src/services/editor'
import { FfmpegProber } from '../src/infra/ffmpeg-prober'
import { FfmpegRenderer } from '../src/infra/ffmpeg-renderer'
import { FfmpegSilenceAnalyzer } from '../src/infra/ffmpeg-silence-analyzer'
import { FsProjectStore } from '../src/infra/fs-store'
import { MockIntelligence } from '../src/infra/mock-intelligence'
import { MockTranscriber } from '../src/infra/mock-transcriber'

const execFileAsync = promisify(execFile)

async function main(): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pimko-smoke-'))
  try {
    const inputPath = path.join(workDir, 'input.mp4')
    // 音频构造为 响2s + 静音1s + 响2s：确定性静音分析要能在素材里找到这 1 秒。
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-f', 'lavfi', '-i', 'anullsrc=duration=1:r=44100',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-filter_complex', '[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]',
      '-map', '0:v', '-map', '[a]',
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
      silenceAnalyzer: new FfmpegSilenceAnalyzer(),
    })

    const draft = await editor.createDraft(inputPath, 'smoke')
    console.log(`draft: ${draft.project.timeline.clips.length} clips`)
    const silenceGap = draft.project.silences ?? []
    if (silenceGap.length !== 1 || Math.abs((silenceGap[0]!.endSec - silenceGap[0]!.startSec) - 1) > 0.3) {
      throw new Error(`静音分析不符: ${JSON.stringify(silenceGap)}`)
    }
    console.log(`silence ok: ${silenceGap[0]!.startSec.toFixed(2)}-${silenceGap[0]!.endSec.toFixed(2)}s`)
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

    // 变速链路：第一段 2 倍速后，导出时长应 ≈ Σ(片段时长/速度)。
    const spedUp = await editor.revise(revised.project.id, { text: '第一段 2 倍速' })
    const spedClip = spedUp.project.timeline.clips[0]!
    if (spedClip.speed !== 2) throw new Error(`变速未生效: speed=${String(spedClip.speed)}`)
    const speedOutput = path.join(workDir, 'output-speed.mp4')
    await editor.export(spedUp.project.id, speedOutput)
    const expected = spedUp.project.timeline.clips.reduce(
      (sum, clip) => sum + (clip.sourceEndSec - clip.sourceStartSec) / (clip.speed ?? 1),
      0,
    )
    const { stdout: speedOut } = await execFileAsync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', speedOutput,
    ])
    const speedDuration = Number((JSON.parse(speedOut) as { format?: { duration?: string } }).format?.duration)
    if (!Number.isFinite(speedDuration) || Math.abs(speedDuration - expected) > 0.6) {
      throw new Error(`变速导出时长不符: expected=${expected.toFixed(2)}s got=${speedDuration.toFixed(2)}s`)
    }
    console.log(`speed export ok: ${speedDuration.toFixed(2)}s (expected ${expected.toFixed(2)}s)`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
