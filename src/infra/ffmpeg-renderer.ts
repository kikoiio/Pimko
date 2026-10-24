import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Project } from '../domain/project'
import type { ExportProgress, RenderResult, Renderer } from '../ports/renderer'

const execFileAsync = promisify(execFile)

export class FfmpegRenderer implements Renderer {
  async render(
    project: Project,
    outputPath: string,
    onProgress?: (progress: ExportProgress) => void,
  ): Promise<RenderResult> {
    const assetById = new Map(project.assets.map((asset) => [asset.id, asset]))
    const workDir = await mkdtemp(path.join(tmpdir(), 'pimko-render-'))
    try {
      const assPath = path.join(workDir, 'subtitles.ass')
      await writeFile(assPath, buildAss(project), 'utf8')

      // 逐段裁切后拼接；重编码保证边界精确。字幕在拼接后烧录。
      const clipFiles: string[] = []
      for (const [index, clip] of project.timeline.clips.entries()) {
        const asset = assetById.get(clip.assetId)
        if (!asset) throw new Error(`时间线引用了不存在的素材: ${clip.assetId}`)
        const clipPath = path.join(workDir, `clip-${String(index).padStart(4, '0')}.mp4`)
        await execFileAsync('ffmpeg', [
          '-y', '-v', 'error',
          '-ss', String(clip.sourceStartSec),
          '-to', String(clip.sourceEndSec),
          '-i', asset.absolutePath,
          '-vf', `scale=${project.settings.width}:${project.settings.height}:force_original_aspect_ratio=decrease,pad=${project.settings.width}:${project.settings.height}:(ow-iw)/2:(oh-ih)/2`,
          '-r', String(project.settings.fps),
          '-c:a', 'aac', '-ar', '48000', '-ac', '2',
          clipPath,
        ])
        clipFiles.push(clipPath)
        onProgress?.({ phase: 'cutting', current: index + 1, total: project.timeline.clips.length })
      }

      const listPath = path.join(workDir, 'concat.txt')
      await writeFile(listPath, clipFiles.map((file) => `file '${file}'`).join('\n'), 'utf8')
      const silentPath = path.join(workDir, 'silent.mp4')
      await execFileAsync('ffmpeg', [
        '-y', '-v', 'error',
        '-f', 'concat', '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        silentPath,
      ])
      onProgress?.({ phase: 'concatenating', current: 1, total: 1 })

      const durationSec = project.timeline.clips.reduce(
        (sum, clip) => sum + (clip.sourceEndSec - clip.sourceStartSec),
        0,
      )
      if (project.timeline.bgm) {
        await execFileAsync('ffmpeg', [
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
        await execFileAsync('ffmpeg', [
          '-y', '-v', 'error',
          '-i', silentPath,
          '-vf', `subtitles=${assPath}`,
          '-c:a', 'copy',
          outputPath,
        ])
      }
      onProgress?.({ phase: 'finalizing', current: 1, total: 1 })
      return { outputPath, durationSec }
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }
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
  const events: string[] = []
  let outputStart = 0
  for (const clip of project.timeline.clips) {
    const length = clip.sourceEndSec - clip.sourceStartSec
    for (const cue of project.timeline.subtitles) {
        const overlapStart = Math.max(cue.startSec, clip.sourceStartSec)
        const overlapEnd = Math.min(cue.endSec, clip.sourceEndSec)
        if (overlapStart < overlapEnd) {
        events.push(
              `Dialogue: 0,${toAssTime(outputStart + overlapStart - clip.sourceStartSec)},${toAssTime(outputStart + overlapEnd - clip.sourceStartSec)},Default,,0,0,0,,${cue.text}`,
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
