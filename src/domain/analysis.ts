import type { ContentKind, EditUnit } from './document'
import type { VisualAnalysis } from './visual'

/** 确定性音频分析结果：静音/长停顿区间，与转写同级的事实源。 */
export interface SilenceInterval {
  startSec: number
  endSec: number
}

/**
 * Project 上的分析扩展位。P1 仍以 Project.transcript / Project.silences 为主事实，
 * 这里为 P2 的稳定 Unit、P3/P4 的镜头/节拍/响度留位置；不要把同一份转写重复存两遍。
 */
export interface ProjectAnalysis {
  contentKind?: ContentKind
  units?: EditUnit[]
  /** P4 视觉事实；无语音/弱语音项目用它生成镜头级初剪。 */
  visual?: VisualAnalysis
}
