import type { CompiledTimeline } from '../domain/compiler'
import type { ProjectSettings } from '../domain/project'
import type { SubtitleAppearance } from '../domain/subtitle-appearance'

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

/** 只消费编译产物：字幕时间已是输出时间，不再在这里做源时间映射。 */
export function buildAss(compiled: CompiledTimeline, settings: ProjectSettings): string {
  const appearance = compiled.subtitleAppearance
  const size = appearance?.size === 'small' ? 0.7 : appearance?.size === 'large' ? 1.4 : 1
  const minimal = appearance?.style === 'minimal' || (!appearance?.style && settings.subtitleStyle === 'minimal-bottom')
  const fontSize = Math.max(12, Math.round(Math.min(settings.width, settings.height) * 0.06 * size))
  const alignment = alignmentOf(appearance)
  const margin = Math.round(Math.min(settings.width, settings.height) * 0.07)
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${settings.width}`,
    `PlayResY: ${settings.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Noto Sans CJK SC,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,${minimal ? 0 : -1},0,0,0,100,100,0,0,1,${minimal ? 1 : 2},1,${alignment},${margin},${margin},${margin},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')
  if (!compiled.subtitlesEnabled) return `${header}\n\n`
  const events = compiled.subtitles.map((cue) =>
    `Dialogue: 0,${toAssTime(cue.startSec)},${toAssTime(cue.endSec)},Default,,0,0,0,,${assText(cue.text)}`,
  )
  return `${header}\n${events.join('\n')}\n`
}

function alignmentOf(appearance: SubtitleAppearance | undefined): number {
  return appearance?.position === 'top' ? 8 : appearance?.position === 'center' ? 5 : 2
}
