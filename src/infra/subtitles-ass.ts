import type { Project } from '../domain/project'
import { transitionDuration } from '../domain/timeline'

function assText(text: string): string {
  // 字幕是文本，不能被解释为 ASS 样式命令。
  return text.replace(/\\/g, '＼').replace(/{/g, '｛').replace(/}/g, '｝').replace(/\r?\n/g, '\\N')
}

export function toAssTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100))
  const hours = Math.floor(centiseconds / 360000)
  const minutes = Math.floor(centiseconds / 6000) % 60
  const wholeSeconds = Math.floor(centiseconds / 100) % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`
}

export function buildAss(project: Project): string {
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
  const events: string[] = []
  let outputStart = 0
  for (const [index, clip] of project.timeline.clips.entries()) {
    if (index > 0) outputStart -= transitionDuration(project.timeline.transitions[index - 1])
    const speed = clip.speed ?? 1
    for (const cue of project.timeline.subtitles) {
      const start = Math.max(cue.startSec, clip.sourceStartSec)
      const end = Math.min(cue.endSec, clip.sourceEndSec)
      if (start < end) {
        events.push(`Dialogue: 0,${toAssTime(outputStart + (start - clip.sourceStartSec) / speed)},${toAssTime(outputStart + (end - clip.sourceStartSec) / speed)},Default,,0,0,0,,${assText(cue.text)}`)
      }
    }
    outputStart += (clip.sourceEndSec - clip.sourceStartSec) / speed
  }
  return `${header}\n${events.join('\n')}\n`
}
