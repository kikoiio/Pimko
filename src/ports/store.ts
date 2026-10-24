import type { ProjectId, RevisionId } from '../domain/project'
import type { ProjectRevision } from '../domain/project'

export interface ProjectStore {
  save(revision: ProjectRevision): Promise<void>
  latest(projectId: ProjectId): Promise<ProjectRevision | undefined>
  get(projectId: ProjectId, revisionId: RevisionId): Promise<ProjectRevision | undefined>
  list(): Promise<ProjectRevision[]>
}
