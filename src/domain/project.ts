import type { ProjectAnalysis, SilenceInterval } from './analysis'
import type { EditDocument } from './document'
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
  /** 原始转写是修订循环的事实源；字幕时间由编译投影。单素材兼容字段。 */
  transcript?: Transcript
  /**
   * 多素材项目的逐素材转写（key = assetId）。编译时按 clip.assetId 取对应转写；
   * transcript 仍保留给旧项目/单素材路径，两者同时存在时按 assetId 优先使用本字段。
   */
  transcripts?: Record<string, Transcript>
  /** 确定性静音分析结果，与转写同级的第二事实源。 */
  silences?: SilenceInterval[]
  /**
   * 分析扩展位（P2 的稳定 Unit、P3/P4 的镜头/节拍/响度）。
   * transcript/silences 仍是 P1 的主事实，不在此重复。
   */
  analysis?: ProjectAnalysis
  /**
   * 唯一可编辑状态。Editor 只写这个字段；旧项目可能还没有，读入时由
   * domain/legacy.ts 的 normalizeProject 从 timeline 迁移。
   */
  document?: EditDocument
  /**
   * 兼容视图：旧 UI/验收脚本/迁移入口仍读 timeline。
   * 新路径不再从这里做时间计算，它由 document 派生，不是第二真源。
   */
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
  /** P1 起新修订写 2；旧修订缺省。 */
  schemaVersion?: 2
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
