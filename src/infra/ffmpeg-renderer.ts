import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Project } from '../domain/project'
import { timelineDurationSec, transitionDuration, type Timeline, type Transition } from '../domain/timeline'
import type { ExportProgress, RenderResult, Renderer } from '../ports/renderer'
import { resolveFfmpeg, resolveFfprobe } from './ffmpeg-bin'

const execFileAsync = promisify(execFile)

export class FfmpegRenderer implements Renderer {
  async render(
    project: Project,
    outputPath: string,
    onProgress?: (progress: ExportProgress) => void,
  ): Promise<RenderResult> {
    const assetById = new Map(project.assets.map((asset) => [asset.id, asset]))
    if (project.timeline.clips.length === 0) {
      throw new Error('时间线没有任何片段，无法导出。')
    }
    const workDir = await mkdtemp(path.join(tmpdir(), 'pimko-render-'))
    try {
      const assPath = path.join(workDir, 'subtitles.ass')
      await writeFile(assPath, buildAss(project), 'utf8')

      // 逐段裁切后拼接；重编码保证边界精确。字幕在拼接后烧录。
      const clipFiles: string[] = []
      for (const [index, clip] of project.timeline.clips.entries()) {
        const asset = assetById.get(clip.assetId)
        if (!asset) throw new Error(`时间线引用了不存在的素材: ${clip.assetId}`)
        const speed = clip.speed !== undefined && clip.speed >= 0.5 && clip.speed <= 4 ? clip.speed : 1
        const clipPath = path.join(workDir, `clip-${String(index).padStart(4, '0')}.mp4`)
        const videoFilters = [
          `scale=${project.settings.width}:${project.settings.height}:force_original_aspect_ratio=decrease`,
          `pad=${project.settings.width}:${project.settings.height}:(ow-iw)/2:(oh-ih)/2`,
        ]
        if (speed !== 1) videoFilters.push(`setpts=PTS/${speed}`)
        const args = [
          '-y', '-v', 'error',
          '-ss', String(clip.sourceStartSec),
          '-to', String(clip.sourceEndSec),
          '-i', asset.absolutePath,
          '-vf', videoFilters.join(','),
          '-r', String(project.settings.fps),
          '-c:a', 'aac', '-ar', '48000', '-ac', '2',
        ]
        // atempo 变速不变调；0.5–2.0 内音质最稳，超出范围由上游 clamp 保证。
        if (speed !== 1) args.push('-af', `atempo=${speed}`)
        args.push(clipPath)
        await execFileAsync(resolveFfmpeg(), args)
        clipFiles.push(clipPath)
        onProgress?.({ phase: 'cutting', current: index + 1, total: project.timeline.clips.length })
      }

      const listPath = path.join(workDir, 'concat.txt')
      await writeFile(listPath, clipFiles.map((file) => `file '${file}'`).join('\n'), 'utf8')

      const durationSec = timelineDurationSec(project.timeline)
      const crossfades = countCrossfades(project.timeline)
      if (crossfades > 0) {
        // 有叠化:不能用 concat copy,单趟 filter_complex 完成 叠化+字幕+混音。
        await this.renderWithTransitions(project, clipFiles, assPath, outputPath)
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

        if (project.timeline.bgm) {
          await execFileAsync(resolveFfmpeg(), [
            '-y', '-v', 'error',
            '-i', silentPath,
            '-stream_loop', '-1', '-i', project.timeline.bgm.path,
            '-filter_complex',
            `[1:a]volume=${project.timeline.bgm.gainDb}dB[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[a]`,
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
      // 渲染后自检：时长/分辨率与时间线核对,不把坏成片交给用户。
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
      const tolerance = Math.max(0.6, durationSec * 0.06)
      if (!Number.isFinite(actualDuration) || Math.abs(actualDuration - durationSec) > tolerance) {
        throw new Error(`导出校验失败：成片时长 ${actualDuration.toFixed(2)}s 与时间线 ${durationSec.toFixed(2)}s 不符，请重试导出。`)
      }
      if (videoStream?.width !== project.settings.width || videoStream?.height !== project.settings.height) {
        throw new Error(`导出校验失败：成片分辨率 ${videoStream?.width ?? '?'}x${videoStream?.height ?? '?'} 与项目设置不符，请重试导出。`)
      }
      return { outputPath, durationSec }
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }
  /** 叠化渲染:链式 xfade/acrossfade(硬切位用 concat),末尾烧字幕、混 BGM。 */
  private async renderWithTransitions(
    project: Project,
    clipFiles: string[],
    assPath: string,
    outputPath: string,
  ): Promise<void> {
    const clips = project.timeline.clips
    const transitions = project.timeline.transitions
    const args: string[] = ['-y', '-v', 'error']
    for (const file of clipFiles) args.push('-i', file)
    const bgm = project.timeline.bgm
    if (bgm) {
      args.push('-stream_loop', '-1', '-i', bgm.path)
    }
    const parts: string[] = []
    let videoLabel = '0:v'
    let audioLabel = '0:a'
    let outputEnd = 0
    for (let i = 1; i < clips.length; i++) {
      const prev = clips[i - 1]!
      const current = clips[i]!
      const prevDur = (prev.sourceEndSec - prev.sourceStartSec) / (prev.speed ?? 1)
      const currentDur = (current.sourceEndSec - current.sourceStartSec) / (current.speed ?? 1)
      if (i === 1) outputEnd = prevDur
      const fade = transitionDuration(transitions[i - 1])
      const nextVideo = `vx${i}`
      const nextAudio = `ax${i}`
      if (fade > 0) {
        const offset = Math.max(0, outputEnd - fade)
        parts.push(`[${videoLabel}][${i}:v]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${offset.toFixed(3)}[${nextVideo}]`)
        parts.push(`[${audioLabel}][${i}:a]acrossfade=d=${fade.toFixed(3)}[${nextAudio}]`)
        outputEnd = offset + currentDur
      } else {
        parts.push(`[${videoLabel}][${i}:v]concat=n=2:v=1:a=0[${nextVideo}]`)
        parts.push(`[${audioLabel}][${i}:a]concat=n=2:v=0:a=1[${nextAudio}]`)
        outputEnd += currentDur
      }
      videoLabel = nextVideo
      audioLabel = nextAudio
    }
    parts.push(`[${videoLabel}]subtitles=${assPath}[vout]`)
    if (bgm) {
      parts.push(`[${clipFiles.length}:a]volume=${bgm.gainDb}dB[bgma]`)
      parts.push(`[${audioLabel}][bgma]amix=inputs=2:duration=first:dropout_transition=0[aout]`)
    } else {
      parts.push(`[${audioLabel}]anull[aout]`)
    }
    args.push(
      '-filter_complex', parts.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(project.settings.fps),
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      outputPath,
    )
    await execFileAsync(resolveFfmpeg(), args)
  }
}

function countCrossfades(timeline: Timeline): number {
  return timeline.transitions.filter((transition: Transition) => transition?.type === 'crossfade').length
}

function buildAss(project: Project): string {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${project.settings.width}`,
    `PlayResY: ${project.settings.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Noto Sans CJK SC,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,80,80,120,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')

    // 字幕与 clip 部分重叠时裁剪到 clip 内，避免 LLM 微调边界后整句丢失。
  // 变速片段内字幕时间同样除以 speed，与播放节奏一致。
  const events: string[] = []
  let outputStart = 0
  for (const [index, clip] of project.timeline.clips.entries()) {
    // 叠化吞掉相邻片段的重叠时长,后续字幕整体前移。
    if (index > 0) outputStart -= transitionDuration(project.timeline.transitions[index - 1])
    const speed = clip.speed ?? 1
    const length = (clip.sourceEndSec - clip.sourceStartSec) / speed
    for (const cue of project.timeline.subtitles) {
        const overlapStart = Math.max(cue.startSec, clip.sourceStartSec)
        const overlapEnd = Math.min(cue.endSec, clip.sourceEndSec)
        if (overlapStart < overlapEnd) {
        events.push(
              `Dialogue: 0,${toAssTime(outputStart + (overlapStart - clip.sourceStartSec) / speed)},${toAssTime(outputStart + (overlapEnd - clip.sourceStartSec) / speed)},Default,,0,0,0,,${cue.text}`,
        )
      }
    }
    outputStart += length
  }
  return `${header}\n${events.join('\n')}\n`
}

function toAssTime(seconds: number): string {
 const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const cs = Math.round((seconds - Math.floor(seconds)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}
