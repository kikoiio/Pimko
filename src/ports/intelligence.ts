import type { SilenceInterval } from '../domain/analysis'
import type { Feedback, Project, ProjectSettings } from '../domain/project'
import type { Timeline } from '../domain/timeline'
import type { Transcript } from '../domain/transcript'

export interface EditPlan {
  timeline: Timeline
  note?: string
}

export interface EditingIntelligence {
  draftTimeline(
    transcript: Transcript,
    settings: ProjectSettings,
    silences?: SilenceInterval[],
  ): Promise<EditPlan>
  reviseTimeline(project: Project, feedback: Feedback): Promise<EditPlan>
}
