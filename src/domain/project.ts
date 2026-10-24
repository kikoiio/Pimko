import type { SilenceInterval } from './analysis'
import type { MediaAsset } from './media'
import type { Timeline } from './timeline'
import type { Transcript } from './transcript'

export type ProjectId = string
export type RevisionId = string

export interface ProjectSettings {
  width: number
  height: number
  fps: number
  subtitleStyle: 'bold-center' | 'minimal-bottom'
}

export interface Project {
  id: ProjectId
  name: string
  assets: MediaAsset[]
  /** 原始转写是修订循环的事实源；字幕只是时间线的投影。 */
  transcript?: Transcript
  /** 确定性静音分析结果，与转写同级的第二事实源。 */
  silences?: SilenceInterval[]
  timeline: Timeline
  settings: ProjectSettings
}

export interface Feedback {
  text: string
}

export interface RevisionDiff {
  /** 相对上一版:新增片段数。 */
  added: number
  /** 相对上一版:删除片段数。 */
  removed: number
  /** 位置发生变化的片段数。 */
  moved: number
  /** 速度发生变化的片段数。 */
  spedUp: number
  /** 成片时长变化(秒,负数为变短)。 */
  durationDeltaSec: number
}

export interface ProjectRevision {
  id: RevisionId
  project: Project
  /** 追加历史中的直接前驱；撤销也追加修订，不改写旧记录。 */
  parentRevisionId?: RevisionId
  /** 缺省表示旧版记录；撤销游标与追加历史的前驱分开保存。 */
  operation?:
    | { kind: 'edit' }
    | { kind: 'undo'; restoredRevisionId: RevisionId }
    | { kind: 'settings-migration' }
  feedback?: Feedback
  agentNote?: string
  /** 相对上一版的可读对比;首个草稿没有。 */
  diff?: RevisionDiff
  createdAt: string
}
