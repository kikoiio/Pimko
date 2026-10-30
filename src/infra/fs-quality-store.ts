import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { QualityReport } from '../domain/quality'
import type { QualityStore } from '../ports/quality-store'

export class FsQualityStore implements QualityStore {
  constructor(private readonly rootDir: string) {}

  async save(revisionId: string, report: QualityReport): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    await writeFile(path.join(this.rootDir, `${revisionId}.json`), JSON.stringify(report, null, 2), 'utf8')
  }

  async get(revisionId: string): Promise<QualityReport | undefined> {
    try {
      return JSON.parse(await readFile(path.join(this.rootDir, `${revisionId}.json`), 'utf8')) as QualityReport
    } catch {
      return undefined
    }
  }
}
