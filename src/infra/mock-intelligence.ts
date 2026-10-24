import type { Feedback, Project, ProjectSettings } from '../domain/project'
import type { Timeline } from '../domain/timeline'
import type { Transcript } from '../domain/transcript'
import type { EditPlan, EditingIntelligence } from '../ports/intelligence'

export class MockIntelligence implements EditingIntelligence {
  async draftTimeline(transcript: Transcript, _settings: ProjectSettings): Promise<EditPlan> {
    const clips = transcript.segments.map((segment) => ({
      assetId: transcript.assetId,
      sourceStartSec: segment.startSec,
      sourceEndSec: segment.endSec,
    }))
    const timeline = {
      clips,
      subtitles: transcript.segments.map(({ startSec, endSec, text }) => ({
        startSec,
        endSec,
        text,
      })),
      transitions: clips.slice(1).map(() => ({ type: 'cut' as const })),
    }
    return {
      timeline,
      note: '草稿已生成。当前是 mock 转写和 mock 剪辑，接入真实 API 后会按素材内容剪辑。',
    }
  }

  async reviseTimeline(project: Project, feedback: Feedback): Promise<EditPlan> {
    const timeline = project.timeline
    if (feedback.text.includes('开头太拖')) {
      const clips = timeline.clips.slice()
      if (clips.length > 0) {
        const first = clips[0]!
        const trim = Math.min(1.5, (first.sourceEndSec - first.sourceStartSec) * 0.5)
        clips[0] = { ...first, sourceStartSec: first.sourceStartSec + trim }
        const firstCue = timeline.subtitles.find(
          (cue) => cue.startSec < first.sourceEndSec && cue.endSec > first.sourceStartSec + trim,
        )
        return {
          timeline: { ...timeline, clips, subtitles: remapSubtitles(clips, timeline.subtitles, firstCue?.text) },
          note: '已剪短开头（mock 演示逻辑）。',
        }
      }
    }
    return {
      timeline: structuredClone(timeline),
      note: 'mock 模式只演示“开头太拖”这一种反馈，其他反馈暂不改动时间线。',
    }
  }
}

function remapSubtitles(clips: Timeline['clips'], cues: Timeline['subtitles'], removedText?: string) {
  // 重建输出时间轴：clip 顺序连续，字幕跟随 clip 平移。
  let outputStart = 0
  const subtitleByStart = new Map(cues.map((cue) => [cue.startSec, cue]))
  return clips.flatMap((clip) => {
    const length = clip.sourceEndSec - clip.sourceStartSec
    const cue = subtitleByStart.get(clip.sourceStartSec)
    const entry = cue
      ? { startSec: outputStart, endSec: outputStart + length, text: cue.text }
      : undefined
    outputStart += length
    return entry ? [entry] : []
  }).filter((cue) => cue.text !== removedText)
}
