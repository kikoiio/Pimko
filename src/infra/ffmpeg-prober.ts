import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { MediaAsset } from '../domain/media'
import type { Prober } from '../ports/prober'

const execFileAsync = promisify(execFile)

interface FfprobeStream {
  codec_type?: string
  width?: number
  height?: number
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { duration?: string }
}

export class FfmpegProber implements Prober {
  async probe(absolutePath: string): Promise<MediaAsset> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      absolutePath,
    ])
    const parsed = JSON.parse(stdout) as FfprobeOutput
    const duration = Number(parsed.format?.duration ?? '')
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`无法读取视频时长: ${absolutePath}`)
    }
    const video = parsed.streams?.find((s) => s.codec_type === 'video')
    if (!video) throw new Error(`文件中没有视频轨: ${absolutePath}`)

    return {
      id: randomUUID(),
      kind: 'video',
      absolutePath,
      durationSec: duration,
      width: video.width,
      height: video.height,
    }
  }
}
