import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MediaAsset } from '../domain/media'
import type { SilenceInterval } from '../domain/analysis'
import type { SilenceAnalyzer } from '../ports/analyzer'
import { resolveFfmpeg } from './ffmpeg-bin'

const execFileAsync = promisify(execFile)

export interface SilenceDetectOptions {
  /** 低于此响度视为静音（dB）。口播常用 -35 ~ -30。 */
  thresholdDb: number
  /** 短于此时长的静音不报告（秒）。 */
  minDurationSec: number
}

export const DEFAULT_SILENCE_OPTIONS: SilenceDetectOptions = {
  thresholdDb: -35,
  minDurationSec: 0.5,
}

export class FfmpegSilenceAnalyzer implements SilenceAnalyzer {
  constructor(private readonly options: SilenceDetectOptions = DEFAULT_SILENCE_OPTIONS) {}

  async analyze(asset: MediaAsset): Promise<SilenceInterval[]> {
    // silencedetect 的结果只打在 stderr；-vn 避免解码视频。
    const { stderr } = await execFileAsync(resolveFfmpeg(), [
      '-hide_banner', '-nostats', '-v', 'info',
      '-i', asset.absolutePath,
      '-vn',
      '-af', `silencedetect=noise=${this.options.thresholdDb}dB:d=${this.options.minDurationSec}`,
      '-f', 'null', '-',
    ])
    return parseSilences(stderr, asset.durationSec, this.options.minDurationSec)
  }
}

export function parseSilences(stderr: string, durationSec: number, minDurationSec: number): SilenceInterval[] {
  const intervals: SilenceInterval[] = []
  let openStart: number | null = null
  for (const line of stderr.split('\n')) {
    const startMatch = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/)
    if (startMatch) {
      openStart = Math.max(0, Number(startMatch[1]))
      continue
    }
    const endMatch = line.match(/silence_end:\s*(\d+(?:\.\d+)?)/)
    if (endMatch && openStart !== null) {
      intervals.push({ startSec: openStart, endSec: Number(endMatch[1]) })
      openStart = null
    }
  }
  // 素材尾部静音没有 silence_end，闭合到时长上限。
  if (openStart !== null && openStart < durationSec) {
    intervals.push({ startSec: openStart, endSec: durationSec })
  }
  return intervals.filter((interval) => interval.endSec - interval.startSec >= minDurationSec)
}
