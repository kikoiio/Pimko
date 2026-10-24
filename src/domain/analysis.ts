/** 确定性音频分析结果：静音/长停顿区间，与转写同级的事实源。 */
export interface SilenceInterval {
  startSec: number
  endSec: number
}
