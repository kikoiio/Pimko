/**
 * 导出质量报告：绑定修订与输出哈希，记录全局检查与每个切点的局部检查。
 * 报告只描述"实际成片测到了什么"，verdict 由检查状态汇总，不能由调用者手写。
 */

export type QualityVerdict = 'pass' | 'warn' | 'fail'

export type QualityCheckKind =
  | 'wordCut'
  | 'pop'
  | 'sceneBreak'
  | 'blackFrame'
  | 'subtitleOcclusion'
  | 'subtitleTiming'
  | 'duration'
  | 'resolution'
  | 'inspection'

export type QualityCheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface QualityCheck {
  kind: QualityCheckKind
  status: QualityCheckStatus
  detail?: string
  /** 检查证据（ffprobe 输出、黑帧日志、波形统计等）的落盘路径。 */
  evidencePath?: string
}

/** 一个输出切点及其局部检查；叠化的 atSec 取重叠区中点。 */
export interface CutCheck {
  atSec: number
  checks: QualityCheck[]
}

export interface QualityReport {
  revisionId: string
  outputHash: string
  verdict: QualityVerdict
  expectedSec: number
  actualSec: number
  /** 全局检查：时长、分辨率、整片黑帧、字幕时间/遮挡。 */
  checks: QualityCheck[]
  cuts: CutCheck[]
}

/** 汇总报告里的所有检查（全局 + 每个切点）。 */
export function allQualityChecks(report: Pick<QualityReport, 'checks' | 'cuts'>): QualityCheck[] {
  return [...report.checks, ...report.cuts.flatMap((cut) => cut.checks)]
}

/**
 * 由检查状态汇总 verdict：
 * - 任一 fail → fail
 * - 任一 warn → warn
 * - 全部 skip（没有任何可验证项）→ warn，绝不把"没测"伪装成 pass
 * - 其余 → pass
 */
export function verdictFromChecks(checks: QualityCheck[]): QualityVerdict {
  if (checks.some((check) => check.status === 'fail')) return 'fail'
  if (checks.some((check) => check.status === 'warn')) return 'warn'
  if (checks.length === 0 || checks.every((check) => check.status === 'skip')) return 'warn'
  return 'pass'
}
