import type { MediaAsset } from './media'
import type { Timeline } from './timeline'

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
  createdAt: string
}
