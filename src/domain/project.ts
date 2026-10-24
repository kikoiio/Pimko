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
  timeline: Timeline
  settings: ProjectSettings
}

export interface Feedback {
  text: string
}

export interface ProjectRevision {
  id: RevisionId
  project: Project
  parentRevisionId?: RevisionId
  feedback?: Feedback
  agentNote?: string
  createdAt: string
}
