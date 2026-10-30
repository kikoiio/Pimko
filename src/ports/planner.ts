import type { SilenceInterval } from '../domain/analysis'
import type { CompiledTimeline } from '../domain/compiler'
import type { ContentKind, EditDocument } from '../domain/document'
import type { EditPlan } from '../domain/edit-plan'
import type { MediaAsset } from '../domain/media'
import type { Feedback, ProjectSettings } from '../domain/project'
import type { Transcript } from '../domain/transcript'
import type { VisualAnalysis } from '../domain/visual'

export interface PlannerInput {
  mode: 'draft' | 'revise'
  contentKind: ContentKind
  document: EditDocument
  compiled?: CompiledTimeline
  transcript?: Transcript
  silences?: SilenceInterval[]
  /** P4 视觉事实；有则可直接复用，避免 planner 内重复分析。 */
  visual?: VisualAnalysis
  assets: MediaAsset[]
  settings: ProjectSettings
  feedback?: Feedback
}

/** planner 只产出补丁；校验、应用、编译和渲染都在 Editor/domain 内。 */
export interface Planner {
  propose(input: PlannerInput): Promise<EditPlan>
}
