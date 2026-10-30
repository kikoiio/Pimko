import type { EditPlan } from '../domain/edit-plan'
import type { MediaAsset } from '../domain/media'
import { buildVisualBaseline, decideContentKind, hasUsableTranscript } from '../domain/visual-baseline'
import type { VisualAnalyzer } from '../ports/visual-analyzer'
import type { Planner, PlannerInput } from '../ports/planner'

export interface VisualPlannerDeps {
  /** 视觉分析器；可在 P4b 由 Editor 注入同一实例并缓存结果。 */
  analyzer: VisualAnalyzer
  /** 有可用转写时交给它；这样 P4 不改 Editor，也不改语音路径。 */
  transcriptPlanner: Planner
}

/**
 * 视觉路径 planner：
 * - draft 且没有可用转写 → 视觉分析 → 镜头级 keep 计划；
 * - 有转写（词级或句级）→ 原样委托给语音 planner；
 * - revise 暂不另写一套视觉语义，委托给原 planner（mock 下可继续 trim/speed/transition）。
 *
 * 建议注入方式（不需要改 Editor 主流程）：
 *   planner: new VisualPlanner({
 *     analyzer: new FfmpegSceneAnalyzer(),
 *     transcriptPlanner: new MockPlanner(),
 *   })
 */
export class VisualPlanner implements Planner {
  constructor(private readonly deps: VisualPlannerDeps) {}

  async propose(input: PlannerInput): Promise<EditPlan> {
    if (input.mode !== 'draft' || hasUsableTranscript(input.transcript)) {
      return this.deps.transcriptPlanner.propose(input)
    }

    const asset = pickVideoAsset(input.assets)
    if (!asset) throw new Error('没有可分析的视频素材，无法生成视觉草稿。')

    // P4b 可在 Editor 分析阶段把结果放进 input.visual，避免 planner 内重复跑 ffmpeg。
    const visual = input.visual?.assetId === asset.id
      ? input.visual
      : await this.deps.analyzer.analyze(asset)
    const decision = decideContentKind({ transcript: input.transcript, visual })
    const { plan } = buildVisualBaseline(visual, { contentKind: decision.contentKind })
    return {
      ...plan,
      contentKind: decision.contentKind,
      note: `${decision.reasons.join(' ')} ${plan.note}`.trim(),
    }
  }
}

function pickVideoAsset(assets: MediaAsset[]): MediaAsset | undefined {
  return assets.find(
    (asset) => asset.kind === 'video' && Number.isFinite(asset.durationSec) && asset.durationSec > 0,
  )
}
