import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CompiledAudioClip, CompiledTimeline, CompiledVideoClip } from '../domain/compiler'
import type { MediaAsset } from '../domain/media'
import type { ProjectSettings } from '../domain/project'
import type { ExportProgress, RenderRequest, RenderResult, Renderer } from '../ports/renderer'
import { resolveFfmpeg, resolveFfprobe } from './ffmpeg-bin'
import { buildAss } from './subtitles-ass'

const execFileAsync = promisify(execFile)

export class FfmpegRenderer implements Renderer {
  async render(
    request: RenderRequest,
    onProgress?: (progress: ExportProgress) => void,
  ): Promise<RenderResult> {
    const { compiled, assets, settings, outputPath } = request
    const assetById = new Map(assets.map((asset) => [asset.id, asset]))
    if (compiled.videoClips.length === 0) {
      throw new Error('时间线没有任何片段，无法导出。')
    }
    const workDir = await mkdtemp(path.join(tmpdir(), 'pimko-render-'))
    try {
      const assPath = path.join(workDir, 'subtitles.ass')
      await writeFile(assPath, buildAss(compiled, settings), 'utf8')

      // 逐段裁切后拼接；重编码保证边界精确。字幕在拼接后烧录。
      const clipFiles: string[] = []
      for (const [index, clip] of compiled.videoClips.entries()) {
        const asset = assetById.get(clip.assetId)
        if (!asset) throw new Error(`时间线引用了不存在的素材: ${clip.assetId}`)
        const clipPath = path.join(workDir, `clip-${String(index).padStart(4, '0')}.mp4`)
        await this.extractClip(asset, clip, settings, clipPath)
        clipFiles.push(clipPath)
        onProgress?.({ phase: 'cutting', current: index + 1, total: compiled.videoClips.length })
      }

      const listPath = path.join(workDir, 'concat.txt')
      await writeFile(listPath, clipFiles.map((file) => `file '${file}'`).join('\n'), 'utf8')
      const bgmPath = this.bgmPath(compiled.bgm, assetById)
      const hasOverlays = compiled.overlays.length > 0

      if (compiled.videoClips.some((clip) => crossfadeDuration(clip) > 0)) {
        // 有叠化:不能用 concat copy,单趟 filter_complex 完成 叠化(+叠加/字幕/混音)。
        const basePath = hasOverlays ? path.join(workDir, 'base.mp4') : outputPath
        await this.renderWithTransitions(compiled, settings, bgmPath, clipFiles, assPath, basePath, {
          withText: !hasOverlays,
          withBgm: !hasOverlays,
        })
        if (hasOverlays) await this.composeOverlays(basePath, compiled, settings, bgmPath, assPath, assetById, outputPath)
      } else {
        const silentPath = path.join(workDir, 'silent.mp4')
        await execFileAsync(resolveFfmpeg(), [
          '-y', '-v', 'error',
          '-f', 'concat', '-safe', '0',
          '-i', listPath,
          '-c', 'copy',
          silentPath,
        ])
        onProgress?.({ phase: 'concatenating', current: 1, total: 1 })

        if (hasOverlays) {
          await this.composeOverlays(silentPath, compiled, settings, bgmPath, assPath, assetById, outputPath)
        } else if (compiled.bgm && bgmPath) {
          await execFileAsync(resolveFfmpeg(), [
            '-y', '-v', 'error',
            '-i', silentPath,
            '-stream_loop', '-1', '-i', bgmPath,
            '-filter_complex',
            `[1:a]volume=${compiled.bgm.gainDb}dB[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[a]`,
            '-vf', `subtitles=${assPath}`,
            '-map', '0:v', '-map', '[a]',
            '-c:a', 'aac',
            outputPath,
          ])
        } else {
          await execFileAsync(resolveFfmpeg(), [
            '-y', '-v', 'error',
            '-i', silentPath,
            '-vf', `subtitles=${assPath}`,
            '-c:a', 'copy',
            outputPath,
          ])
        }
      }
      onProgress?.({ phase: 'finalizing', current: 1, total: 1 })
      // 渲染后自检：时长/分辨率与编译产物核对,不把坏成片交给用户。
      onProgress?.({ phase: 'verifying', current: 1, total: 1 })
      const { stdout } = await execFileAsync(resolveFfprobe(), [
        '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', outputPath,
      ])
      const probe = JSON.parse(stdout) as {
        format?: { duration?: string }
        streams?: { codec_type?: string; width?: number; height?: number }[]
      }
      const actualDuration = Number(probe.format?.duration)
      const videoStream = probe.streams?.find((stream) => stream.codec_type === 'video')
      const tolerance = Math.max(0.6, compiled.durationSec * 0.06)
      if (!Number.isFinite(actualDuration) || Math.abs(actualDuration - compiled.durationSec) > tolerance) {
        throw new Error(`导出校验失败：成片时长 ${actualDuration.toFixed(2)}s 与编译预计 ${compiled.durationSec.toFixed(2)}s 不符，请重试导出。`)
      }
      if (videoStream?.width !== settings.width || videoStream?.height !== settings.height) {
        throw new Error(`导出校验失败：成片分辨率 ${videoStream?.width ?? '?'}x${videoStream?.height ?? '?'} 与项目设置不符，请重试导出。`)
      }
      return { outputPath, durationSec: compiled.durationSec }
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }

  private async extractClip(
    asset: MediaAsset,
    clip: CompiledVideoClip,
    settings: ProjectSettings,
    outputPath: string,
  ): Promise<void> {
    const speed = clip.speed
    const videoFilters = [
      `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease`,
      `pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2`,
      // 强制方形像素：源素材 SAR 非 1:1 时，缩放后会在播放器里被轻微拉伸。
      'setsar=1',
    ]
    if (speed !== 1) videoFilters.push(`setpts=PTS/${speed}`)
    const args = [
      '-y', '-v', 'error',
      '-ss', String(clip.sourceStartSec),
      '-to', String(clip.sourceEndSec),
      '-i', asset.absolutePath,
      '-vf', videoFilters.join(','),
      '-r', String(settings.fps),
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    ]
    // atempo 变速不变调；0.5–2.0 内音质最稳，超出范围由编译器的速度校验保证。
    if (speed !== 1) args.push('-af', `atempo=${speed}`)
    args.push(outputPath)
    await execFileAsync(resolveFfmpeg(), args)
  }

  private bgmPath(bgm: CompiledAudioClip | undefined, assetById: Map<string, MediaAsset>): string | undefined {
    if (!bgm) return undefined
    const asset = assetById.get(bgm.assetId)
    if (!asset) throw new Error(`配乐引用了不存在的素材: ${bgm.assetId}`)
    return asset.absolutePath
  }

  /** 叠化渲染:链式 xfade/acrossfade(硬切位用 concat),末尾烧字幕、混 BGM。 */
  private async renderWithTransitions(
    compiled: CompiledTimeline,
    settings: ProjectSettings,
    bgmPath: string | undefined,
    clipFiles: string[],
    assPath: string,
    outputPath: string,
    options: { withText?: boolean; withBgm?: boolean } = {},
  ): Promise<void> {
    const { videoClips, bgm } = compiled
    const withText = options.withText ?? true
    const withBgm = options.withBgm ?? true
    const args: string[] = ['-y', '-v', 'error']
    for (const file of clipFiles) args.push('-i', file)
    if (bgmPath && withBgm) {
      args.push('-stream_loop', '-1', '-i', bgmPath)
    }
    const parts: string[] = []
    let videoLabel = '0:v'
    let audioLabel = '0:a'
    for (let i = 1; i < videoClips.length; i++) {
      const clip = videoClips[i]!
      const fade = crossfadeDuration(clip)
      const nextVideo = `vx${i}`
      const nextAudio = `ax${i}`
      if (fade > 0) {
        parts.push(`[${videoLabel}][${i}:v]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${clip.outputStartSec.toFixed(3)}[${nextVideo}]`)
        parts.push(`[${audioLabel}][${i}:a]acrossfade=d=${fade.toFixed(3)}[${nextAudio}]`)
      } else {
        parts.push(`[${videoLabel}][${i}:v]concat=n=2:v=1:a=0[${nextVideo}]`)
        parts.push(`[${audioLabel}][${i}:a]concat=n=2:v=0:a=1[${nextAudio}]`)
      }
      videoLabel = nextVideo
      audioLabel = nextAudio
    }
    parts.push(withText ? `[${videoLabel}]subtitles=${assPath}[vout]` : `[${videoLabel}]null[vout]`)
    if (withBgm && bgm && bgmPath) {
      parts.push(`[${clipFiles.length}:a]volume=${bgm.gainDb}dB[bgma]`)
      parts.push(`[${audioLabel}][bgma]amix=inputs=2:duration=first:dropout_transition=0[aout]`)
    } else {
      parts.push(`[${audioLabel}]anull[aout]`)
    }
    args.push(
      '-filter_complex', parts.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(settings.fps),
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      outputPath,
    )
    await execFileAsync(resolveFfmpeg(), args)
  }

  /** 在已拼接的 base 上叠加 B-roll；字幕在叠加之后，避免被 B-roll 盖住。 */
  private async composeOverlays(
    basePath: string,
    compiled: CompiledTimeline,
    settings: ProjectSettings,
    bgmPath: string | undefined,
    assPath: string,
    assetById: Map<string, MediaAsset>,
    outputPath: string,
  ): Promise<void> {
    const args: string[] = ['-y', '-v', 'error', '-i', basePath]
    let bgmInputIndex: number | undefined
    if (compiled.bgm && bgmPath) {
      bgmInputIndex = 1
      args.push('-stream_loop', '-1', '-i', bgmPath)
    }
    const overlayInputs: Array<{ index: number; clip: NonNullable<CompiledTimeline['overlays'][number]>; path: string }> = []
    const baseInputs = bgmInputIndex === undefined ? 1 : 2
    for (const [index, clip] of compiled.overlays.entries()) {
      const asset = assetById.get(clip.assetId)
      if (!asset) throw new Error(`B-roll 引用了不存在的素材: ${clip.assetId}`)
      overlayInputs.push({ index: baseInputs + index, clip, path: asset.absolutePath })
      args.push('-i', asset.absolutePath)
    }
    const parts: string[] = []
    let videoLabel = '0:v'
    for (const [index, overlay] of overlayInputs.entries()) {
      const { clip, index: inputIndex } = overlay
      const at = clip.outputStartSec
      const end = clip.outputEndSec
      const speed = clip.speed === 0 ? 1 : clip.speed
      const label = `ov${index}`
      parts.push(
        `[${inputIndex}:v]scale=${settings.width}:${settings.height}:force_original_aspect_ratio=increase,` +
        `crop=${settings.width}:${settings.height},setsar=1,` +
        `setpts=(PTS-STARTPTS)/${speed}+${at.toFixed(3)}/TB[${label}]`,
      )
      parts.push(
        `[${videoLabel}][${label}]overlay=enable='between(t,${at.toFixed(3)},${end.toFixed(3)})'[v${index}]`,
      )
      videoLabel = `v${index}`
    }
    parts.push(`[${videoLabel}]subtitles=${assPath}[vout]`)
    if (compiled.bgm && bgmPath && bgmInputIndex !== undefined) {
      parts.push(`[${bgmInputIndex}:a]volume=${compiled.bgm.gainDb}dB[bgma]`)
      parts.push(`[0:a][bgma]amix=inputs=2:duration=first:dropout_transition=0[aout]`)
    } else {
      parts.push('[0:a]anull[aout]')
    }
    args.push(
      '-filter_complex', parts.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-t', String(compiled.durationSec),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(settings.fps),
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      outputPath,
    )
    await execFileAsync(resolveFfmpeg(), args)
  }
}

function crossfadeDuration(clip: CompiledVideoClip): number {
  return clip.transitionIn.type === 'crossfade' ? clip.transitionIn.durationSec : 0
}
