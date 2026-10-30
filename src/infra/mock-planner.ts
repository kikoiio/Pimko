import type { EditPlan, EditOp } from '../domain/edit-plan'
import { baselinePlan } from '../domain/baseline'
import type { Planner, PlannerInput } from '../ports/planner'

/** mock planner：draft 走确定性预剪；revise 只演示少量反馈，便于离线回归。 */
export class MockPlanner implements Planner {
  async propose(input: PlannerInput): Promise<EditPlan> {
    if (input.mode === 'draft') {
      if (!input.transcript) {
        return {
          mode: 'draft',
          contentKind: input.contentKind,
          ops: [],
          note: '当前素材没有可用语音转写；P2 先只处理语音路径。',
        }
      }
      return baselinePlan(
        input.transcript,
        input.silences,
        input.contentKind,
        input.assets.find((asset) => asset.id === input.transcript!.assetId)?.durationSec,
      )
    }

    const feedback = input.feedback?.text ?? ''
    const clips = input.compiled?.videoClips ?? []
    const ops: EditOp[] = []
    let note = 'mock 模式没有改动；请换一种说法。'

    if (/字幕/.test(feedback)) {
      const appearance = { ...input.document.subtitle.appearance }
      if (/大/.test(feedback)) appearance.size = 'large'
      if (/小/.test(feedback)) appearance.size = 'small'
      if (/标准|中等/.test(feedback)) appearance.size = 'medium'
      if (/顶部|上方|移上/.test(feedback)) appearance.position = 'top'
      if (/底部|下方|移下/.test(feedback)) appearance.position = 'bottom'
      if (/居中|中间/.test(feedback)) appearance.position = 'center'
      if (/简洁/.test(feedback)) appearance.style = 'minimal'
      if (/加粗/.test(feedback)) appearance.style = 'bold'
      if (/隐藏|关闭|不要/.test(feedback)) appearance.visible = false
      if (/显示|开启/.test(feedback)) appearance.visible = true
      ops.push({ kind: 'setSubtitle', appearance })
      note = '已调整字幕外观（mock 演示逻辑）。'
    } else if (/开头太拖/.test(feedback) && clips[0]) {
      const first = clips[0]
      const amount = Math.min(1.5, (first.sourceEndSec - first.sourceStartSec) / (first.speed * 2))
      ops.push({ kind: 'trim', clipId: first.id, edge: 'in', amountSec: amount, reason: '剪短开头' })
      note = '已剪短开头（mock 演示逻辑）。'
    } else {
      const speedMatch = feedback.match(/(\d+(?:\.\d+)?)\s*倍速/)
      if (speedMatch && clips[0]) {
        const speed = Math.min(2, Math.max(0.5, Number(speedMatch[1])))
        ops.push({ kind: 'speed', clipIds: [clips[0].id], speed, reason: '用户要求变速' })
        note = `已把第 1 段设为 ${speed} 倍速（mock 演示逻辑）。`
      } else if (/转场|叠化/.test(feedback) && clips.length > 1) {
        for (const clip of clips.slice(1)) {
          ops.push({
            kind: 'transition',
            clipId: clip.id,
            transition: { type: 'crossfade', durationSec: 0.3 },
            reason: '用户要求叠化',
          })
        }
        note = '已把片段衔接改为 0.3s 叠化（mock 演示逻辑）。'
      }
    }

    return { mode: 'revise', contentKind: input.contentKind, ops, note }
  }
}
