import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectRevision } from '../domain/project'
import type { ExportProgress, Renderer } from '../ports/renderer'

export interface RenderedPreview {
  revisionId: string
  outputPath: string
}

/** 使用导出渲染器生成效果预览；按修订缓存，并将编码任务串行执行。 */
export class PreviewService {
  private queue: Promise<void> = Promise.resolve()
  private readonly pending = new Map<string, Promise<RenderedPreview>>()

  constructor(private readonly renderer: Renderer, private readonly cacheRoot: string) {}

  render(revision: ProjectRevision, onProgress?: (progress: ExportProgress) => void): Promise<RenderedPreview> {
    const key = createHash('sha256').update(`${revision.project.id}\0${revision.id}`).digest('hex')
    const existing = this.pending.get(key)
    if (existing) return existing
    const snapshot = structuredClone(revision)
    const task = this.queue.then(() => this.renderSnapshot(snapshot, key, onProgress))
    this.pending.set(key, task)
    this.queue = task.then(() => undefined, () => undefined)
    void task.finally(() => this.pending.delete(key)).catch(() => undefined)
    return task
  }

  private async renderSnapshot(
    revision: ProjectRevision,
    key: string,
    onProgress?: (progress: ExportProgress) => void,
  ): Promise<RenderedPreview> {
    await mkdir(this.cacheRoot, { recursive: true })
    const outputPath = path.join(this.cacheRoot, `${key}.mp4`)
    try {
      const cached = await stat(outputPath)
      if (cached.isFile() && cached.size > 0) return { revisionId: revision.id, outputPath }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const temporary = path.join(this.cacheRoot, `${key}-${randomUUID()}.partial.mp4`)
    try {
      await this.renderer.render(revision.project, temporary, onProgress)
      await rename(temporary, outputPath)
      return { revisionId: revision.id, outputPath }
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
