import type { QualityReport } from '../domain/quality'

/** 质量报告持久化：与修订 id 一一对应，恢复项目后可重新读取。 */
export interface QualityStore {
  save(revisionId: string, report: QualityReport): Promise<void>
  get(revisionId: string): Promise<QualityReport | undefined>
}
