import type { Feedback, Project, ProjectSettings } from '../domain/project'
import type { Timeline } from '../domain/timeline'
import type { Transcript } from '../domain/transcript'

export interface EditingIntelligence {
  draftTimeline(transcript: Transcript, settings: ProjectSettings): Promise<Timeline>
  reviseTimeline(project: Project, feedback: Feedback): Promise<Timeline>
}
