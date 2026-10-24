import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { MediaAsset } from '../domain/media'
import { resolveFfmpeg } from './ffmpeg-bin'

const execFileAsync = promisify(execFile)

/**
 * 从视频抽出 16k 单声道 mp3 供转写 API 使用。
 * 无音轨是常见误操作，这里给出可执行的中文提示而不是原始 ffmpeg 报错。
 */
export async function extractAudio(asset: MediaAsset, workDir: string): Promise<string> {
  const audioPath = path.join(workDir, 'audio.mp3')
  try {
    await execFileAsync(resolveFfmpeg(), [
      '-y', '-v', 'error', '-i', asset.absolutePath, '-vn', '-ac', '1', '-ar', '16000', audioPath,
    ])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('does not contain any stream')) {
      throw new Error('这段视频没有音轨，无法转写。请导入有说话声的口播视频，或切回 mock 模式测试界面。')
    }
    throw err
  }
  return audioPath
}
