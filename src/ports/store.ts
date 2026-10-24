import type { ProjectId } from '../domain/project'
import type { ProjectRevision } from '../domain/project'

export interface ProjectStore {
  save(revision: ProjectRevision): Promise<void>
  latest(projectId: ProjectId): Promise<ProjectRevision | undefined>
  list(): Promise<ProjectRevision[]>
}
