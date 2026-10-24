import type { SubtitleCue, TimelineClip } from './timeline'
import type { Transcript } from './transcript'

/** 字幕始终使用源时间；按保留的词切块，删除的口癖不会再次出现在字幕里。 */
export function subtitlesForClips(transcript: Transcript, clips: TimelineClip[]): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  for (const segment of transcript.segments) {
    const ranges = clips
      .filter((clip) => clip.assetId === transcript.assetId)
      .map((clip) => ({
        startSec: Math.max(segment.startSec, clip.sourceStartSec),
        endSec: Math.min(segment.endSec, clip.sourceEndSec),
      }))
      .filter((range) => range.endSec > range.startSec)
      .sort((a, b) => a.startSec - b.startSec)
    // 按所有片段边界切块；重播同一区间时只生成一套源字幕，短重播也不会带上整句。
    const boundaries = [...new Set(ranges.flatMap((range) => [range.startSec, range.endSec]))].sort((a, b) => a - b)
    for (let index = 1; index < boundaries.length; index++) {
      const startSec = boundaries[index - 1]!
      const endSec = boundaries[index]!
      if (!ranges.some((range) => range.startSec <= startSec && range.endSec >= endSec)) continue
      const range = { startSec, endSec }
      if (!segment.words?.length) {
        cues.push({ ...range, text: segment.text })
        continue
      }
      const words = segment.words.filter((word) => {
        const midpoint = (word.startSec + word.endSec) / 2
        return midpoint >= range.startSec && midpoint < range.endSec
      })
      if (words.length === 0) continue
      const text = words.map((word) => word.word).join(' ')
        .replace(/([㐀-鿿])\s+(?=[㐀-鿿])/g, '$1')
        .replace(/\s+([，。！？、；：,.!?;:])/g, '$1')
      cues.push({ ...range, text })
    }
  }
  return cues.sort((a, b) => a.startSec - b.startSec)
}

export function subtitleAtTime(cues: SubtitleCue[], time: number): string {
  return cues.filter((cue) => cue.startSec <= time && time < cue.endSec).map((cue) => cue.text).join('\n')
}
