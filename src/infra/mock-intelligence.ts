import type { SilenceInterval } from '../domain/analysis'
import { applyPauseCompressions, planPauseCompressions } from '../domain/pause-compress'
import type { Feedback, Project, ProjectSettings } from '../domain/project'
import { subtitlesForClips } from '../domain/subtitles'
import type { Timeline } from '../domain/timeline'
import type { Transcript } from '../domain/transcript'
import type { EditPlan, EditingIntelligence } from '../ports/intelligence'

export class MockIntelligence implements EditingIntelligence {
  async draftTimeline(transcript: Transcript, _settings: ProjectSettings, silences?: SilenceInterval[]): Promise<EditPlan> {
    // mock 也走同一条确定性预剪路径:静音图 → 压缩提案 → 应用到片段。
    const clips = applyPauseCompressions(
      transcript.segments.map((segment) => ({
        assetId: transcript.assetId,
        sourceStartSec: segment.startSec,
        sourceEndSec: segment.endSec,
      })),
      planPauseCompressions(silences),
    )
    const compressed = clips.length > transcript.segments.length
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
      note: compressed
        ? '草稿已生成,长停顿已按预剪提案压缩(mock 演示逻辑)。'
        : '草稿已生成。当前是 mock 转写和 mock 剪辑，接入真实 API 后会按素材内容剪辑。',
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
        return {
          timeline: { ...timeline, clips, subtitles: project.transcript ? subtitlesForClips(project.transcript, clips) : timeline.subtitles },
          note: '已剪短开头（mock 演示逻辑）。',
        }
      }
    }
    const speedMatch = feedback.text.match(/(\d+(?:\.\d+)?)\s*倍速/)
    if (speedMatch && timeline.clips.length > 0) {
      // mock 演示：把第一段设为指定倍速（0.5–2.0），驱动冒烟/E2E 验证变速链路。
      const speed = Math.min(2, Math.max(0.5, Number(speedMatch[1])))
      const first = timeline.clips[0]!
      const clips = timeline.clips.slice()
      clips[0] = { ...first, speed }
      return {
        timeline: { ...timeline, clips },
        note: `已把第 1 段设为 ${speed} 倍速（mock 演示逻辑）。`,
      }
    }
    if (/转场|叠化/.test(feedback.text) && timeline.clips.length > 1) {
      // mock 演示:全部衔接改为 0.3s 叠化,驱动冒烟验证 xfade 渲染路径。
      return {
        timeline: {
          ...timeline,
          transitions: timeline.clips.slice(1).map(() => ({ type: 'crossfade' as const, durationSec: 0.3 })),
        },
        note: '已把片段衔接改为 0.3s 叠化（mock 演示逻辑；预览仍是硬切，导出生效）。',
      }
    }
    return {
      timeline: structuredClone(timeline),
      note: 'mock 模式只演示「开头太拖」「N 倍速」「转场」这几种反馈，其他反馈暂不改动时间线。',
    }
  }
}
