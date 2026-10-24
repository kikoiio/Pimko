import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectId, ProjectRevision, RevisionId } from '../domain/project'
import type { ProjectStore } from '../ports/store'

export class FsProjectStore implements ProjectStore {
  constructor(private readonly rootDir: string) {}

  async save(revision: ProjectRevision): Promise<void> {
    const dir = path.join(this.rootDir, revision.project.id)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${revision.id}.json`), JSON.stringify(revision, null, 2))
  }

  async latest(projectId: ProjectId): Promise<ProjectRevision | undefined> {
    const all = await this.list()
    const forProject = all.filter((revision) => revision.project.id === projectId)
    return forProject.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  }

  async get(projectId: ProjectId, revisionId: RevisionId): Promise<ProjectRevision | undefined> {
    try {
      const raw = await readFile(path.join(this.rootDir, projectId, `${revisionId}.json`), 'utf8')
      return JSON.parse(raw) as ProjectRevision
    } catch {
      return undefined
    }
  }

  async list(): Promise<ProjectRevision[]> {
    try {
      const projectDirs = await readdir(this.rootDir, { withFileTypes: true })
      const revisions: ProjectRevision[] = []
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue
        const files = await readdir(path.join(this.rootDir, dir.name))
        for (const file of files) {
          if (!file.endsWith('.json')) continue
          const raw = await readFile(path.join(this.rootDir, dir.name, file), 'utf8')
          revisions.push(JSON.parse(raw) as ProjectRevision)
        }
      }
      return revisions
    } catch {
      return []
    }
  }
}
