import { allQualityChecks, verdictFromChecks, type QualityCheck, type QualityReport } from '../domain/quality'
import type { Inspector, InspectRequest } from '../ports/inspector'

/**
 * 质量闸门：把 Inspector 的实测报告收敛成最终 verdict。
 * fail 抛错并保留成片路径供排查；warn 允许交付，但调用者必须拿到报告。
 */
export class QualityGate {
  constructor(private readonly inspector: Inspector) {}

  async verify(request: InspectRequest): Promise<QualityReport> {
    const report = await this.inspector.inspect(request)
    const computed = verdictFromChecks(allQualityChecks(report))
    // 不得把 Inspector 的 fail/warn 降级成 pass：只允许从检查明细升级严重度。
    const verdict = report.verdict === 'fail' || computed === 'fail'
      ? 'fail'
      : report.verdict === 'warn' || computed === 'warn'
        ? 'warn'
        : 'pass'
    const normalized: QualityReport = {
      ...report,
      revisionId: request.revisionId ?? report.revisionId,
      verdict,
    }
    if (verdict === 'fail') throw new QualityError(normalized, request.outputPath)
    return normalized
  }
}

export class QualityError extends Error {
  readonly report: QualityReport
  readonly outputPath: string

  constructor(report: QualityReport, outputPath: string) {
    super(formatQualityFailure(report, outputPath))
    this.name = 'QualityError'
    this.report = report
    this.outputPath = outputPath
  }
}

const CHECK_LABELS: Record<QualityCheck['kind'], string> = {
  wordCut: '切词',
  pop: '爆音',
  sceneBreak: '镜头切断',
  blackFrame: '黑帧',
  subtitleOcclusion: '字幕遮挡',
  subtitleTiming: '字幕时间',
  duration: '时长',
  resolution: '分辨率',
  inspection: '质量检查',
}

function formatQualityFailure(report: QualityReport, outputPath: string): string {
  const failures: string[] = []
  for (const check of report.checks) {
    if (check.status === 'fail') failures.push(`${CHECK_LABELS[check.kind]}：${check.detail ?? '未通过'}`)
  }
  for (const cut of report.cuts) {
    for (const check of cut.checks) {
      if (check.status !== 'fail') continue
      failures.push(`切点 ${cut.atSec.toFixed(2)}s ${CHECK_LABELS[check.kind]}：${check.detail ?? '未通过'}`)
    }
  }
  const summary = failures.length > 0 ? failures.slice(0, 5).join('；') : '存在未通过的检查项'
  return `成片质量检查未通过：${summary}。导出文件保留在 ${outputPath} 供排查。`
}
