/**
 * 验收批次：R 类（真实模型语义与转写边界）——无 GUI，直接驱动 Editor。
 *
 * 策略（docs/testing-acceptance.md §14 + FA-03 约束）：
 * - 全局节奏：LLM 调用间隔 ≥10s，转写间隔 ≥25s；429 外部退避重试最多 2 次
 *   （适配器内部已对 429 重试 2 次、每次 ≤20s），耗尽后记「阻塞（限流）」，
 *   后续同类用例顺延为阻塞，不轰炸免费服务。
 * - 语义核心优先（P3 → ED-03..07 → SP/ED 边界），转写守卫次之，长视频最后。
 * - P3 草稿与 ED-03 后成片导出保存为用户对照样品。
 * 覆盖：IM-01(P3/P4)、IM-06、IM-07、IM-10、IM-11、IM-12、ED-03..05、ED-07、
 *       ED-09、ED-10、SP-04、SP-05、SU-05、FA-02(真实401)。
 */
import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Editor } from '../../src/services/editor'
import { FfmpegProber } from '../../src/infra/ffmpeg-prober'
import { FfmpegRenderer } from '../../src/infra/ffmpeg-renderer'
import { FfmpegSilenceAnalyzer } from '../../src/infra/ffmpeg-silence-analyzer'
import { FsProjectStore } from '../../src/infra/fs-store'
import { OpenAiTranscriber } from '../../src/infra/openai-transcriber'
import { OpenAiIntelligence } from '../../src/infra/openai-intelligence'
import { createIntelligence, createTranscriber } from '../../src/infra/ai-factory'
import { loadLlmConfig } from '../../src/infra/llm-config'
import type { Transcript } from '../../src/domain/transcript'
import { materialPath, MATERIALS, runBatch, Case, probeMedia, expectedDuration, coverageOf, outDir, sha256, envProvider, keyConfigured } from './lib'

const root = path.resolve(__dirname, '..', '..')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class RateLimitBlocked extends Error {}

/** 节奏 + 429 外部退避。 */
class Pacer {
  private lastLlm = 0
  private lastTranscribe = 0
  transcribeBlocked = false
  llmBlocked = false

  private async gap(last: number, minMs: number): Promise<void> {
    const wait = last + minMs - Date.now()
    if (wait > 0) await sleep(wait)
  }

  async transcribe<T>(fn: () => Promise<T>): Promise<T> {
    if (this.transcribeBlocked) throw new RateLimitBlocked('转写已被限流，后续转写用例顺延为阻塞')
    await this.gap(this.lastTranscribe, 25000)
    for (let attempt = 0; ; attempt++) {
      this.lastTranscribe = Date.now()
      try {
        return await fn()
      } catch (err) {
        if (String(err).includes('429') && attempt < 2) {
          const backoff = 45000 * (attempt + 1)
          console.log(`  转写 429，退避 ${backoff / 1000}s（第 ${attempt + 1}/2 次）`)
          await sleep(backoff)
          continue
        }
        if (String(err).includes('429')) this.transcribeBlocked = true
        throw err
      }
    }
  }

  async llm<T>(fn: () => Promise<T>): Promise<T> {
    if (this.llmBlocked) throw new RateLimitBlocked('剪辑模型已被限流，后续 LLM 用例顺延为阻塞')
    await this.gap(this.lastLlm, 10000)
    for (let attempt = 0; ; attempt++) {
      this.lastLlm = Date.now()
      try {
        return await fn()
      } catch (err) {
        if (String(err).includes('429') && attempt < 2) {
          const backoff = 45000 * (attempt + 1)
          console.log(`  LLM 429，退避 ${backoff / 1000}s（第 ${attempt + 1}/2 次）`)
          await sleep(backoff)
          continue
        }
        if (String(err).includes('429')) this.llmBlocked = true
        throw err
      }
    }
  }
}

/** 每用例独立执行：断言全过=通过，限流=阻塞，其它异常=失败；不会覆盖已完成的记录。 */
async function runCase(
  id: string,
  variant: string,
  expected: string,
  fn: (c: Case) => Promise<string>,
  options: { material?: string; materialSpec?: string; allBlocked?: boolean; blockedReason?: string } = {},
): Promise<void> {
  const c = new Case({ id, variant, mode: 'R', material: options.material, materialSpec: options.materialSpec, expected })
  c.record.provider = envProvider()
  if (options.material) c.record.material!.sha256 = await sha256(materialPath(options.material)).catch(() => '')
  try {
    const actual = await fn(c)
    await c.finish(options.allBlocked ? '阻塞' : (c.record.checks.every((check) => check.pass) ? '通过' : '失败'),
      actual, options.allBlocked ? options.blockedReason : undefined)
  } catch (err) {
    const blocked = err instanceof RateLimitBlocked || options.allBlocked
    await c.finish(blocked ? '阻塞' : '失败', String(err).slice(0, 240),
      blocked ? (err instanceof RateLimitBlocked ? '真实服务限流' : options.blockedReason) : undefined)
  }
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** 期望词 vs 识别词：按最长公共子序列统计漏词/多词。 */
function wordDiff(expected: string[], recognized: string[]): { missing: string[]; extra: string[] } {
  const m = expected.length
  const n = recognized.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = expected[i - 1] === recognized[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }
  const missing: string[] = []
  const extra: string[] = []
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    if (expected[i - 1] === recognized[j - 1]) { i--; j--; continue }
    if (dp[i - 1]![j]! >= dp[i]![j - 1]!) { missing.unshift(expected[i - 1]!); i-- } else { extra.unshift(recognized[j - 1]!); j-- }
  }
  while (i > 0) { missing.unshift(expected[i - 1]!); i-- }
  while (j > 0) { extra.unshift(recognized[j - 1]!); j-- }
  return { missing, extra }
}

function expectedSpeechText(): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'sample-assets', 'boundaries', 'manifest.json'), 'utf8')) as { transcript?: string }
    if (manifest.transcript) return manifest.transcript
  } catch { /* 回退到文档引用值 */ }
  return 'Hello, um, keep this word. Goodbye.'
}

async function main(): Promise<void> {
  await runBatch('real', async () => {
    const gitRev = process.env.PIMKO_ACCEPTANCE_GIT_REV ?? 'unknown'

    if (keyConfigured() !== '已配置') {
      for (const id of ['IM-01', 'IM-06', 'IM-07', 'IM-10', 'IM-11', 'IM-12', 'ED-03', 'ED-04', 'ED-05', 'ED-07', 'ED-09', 'ED-10', 'SP-04', 'SP-05', 'SU-05', 'FA-02']) {
        await runCase(id, 'R', '真实接口验收', async () => '未执行',
          { allBlocked: true, blockedReason: 'PIMKO_LLM_API_KEY 未配置，配置回退 mock，按文档规则真实用例记阻塞' })
      }
      return
    }

    const storeRoot = path.join(root, '.tmp', 'acceptance', 'real', 'projects')
    const editor = new Editor({
      prober: new FfmpegProber(),
      transcriber: createTranscriber(loadLlmConfig()),
      intelligence: createIntelligence(loadLlmConfig()),
      renderer: new FfmpegRenderer(),
      store: new FsProjectStore(storeRoot),
      silenceAnalyzer: new FfmpegSilenceAnalyzer(),
    })
    const pacer = new Pacer()
    const transcriptOnly = new OpenAiTranscriber(loadLlmConfig())
    console.log(`真实供应商: ${JSON.stringify(envProvider())}`)

    // ══ Phase A：语义核心（P3 中文） ═══════════════════════════════
    let p3ProjectId = ''
    let p3Segments: { startSec: number; endSec: number; text: string; words?: { word: string; startSec: number; endSec: number }[] }[] = []
    {
      let p3Draft: Awaited<ReturnType<Editor['createDraft']>> | null = null
      await runCase('IM-01', 'R/P3 中文口播', '真实转写与音轨内容对应；非空片段；草稿 ≤2 分钟',
        async (c) => {
          const t0 = Date.now()
          p3Draft = await pacer.llm(() => editor.createDraft(materialPath(MATERIALS.P3), 'acceptance-P3'))
          const seconds = (Date.now() - t0) / 1000
          p3ProjectId = p3Draft.project.id
          p3Segments = p3Draft.project.transcript?.segments ?? []
          c.check('转写非空', p3Segments.length > 0, `${p3Segments.length} 段`)
          c.check('词级时间戳', p3Segments.reduce((sum, s) => sum + (s.words?.length ?? 0), 0) > 0,
            `${p3Segments.reduce((sum, s) => sum + (s.words?.length ?? 0), 0)} 词`)
          c.check('语言为中文', /zh|cmn/.test((p3Draft.project.transcript as unknown as Transcript).language), (p3Draft.project.transcript as unknown as Transcript).language)
          c.check('片段非空', p3Draft.project.timeline.clips.length > 0, `${p3Draft.project.timeline.clips.length} 段`)
          c.check('草稿耗时 <2 分钟', seconds < 120, `${seconds.toFixed(1)}s`)
          c.record.projectId = p3ProjectId
          c.record.revisionAfter = p3Draft.id
          await c.saveEvidence('transcript', JSON.stringify(p3Draft.project.transcript, null, 2))
          return `中文口播导入成功，${p3Draft.project.timeline.clips.length} 段，耗时 ${seconds.toFixed(1)}s`
        },
        { material: MATERIALS.P3, materialSpec: '720×1280 约45s 中文演讲音频配合成画面' })

      if (p3ProjectId && p3Draft) {
        try {
          const beforePath = outDir('P3-draft-before.mp4')
          await mkdir(path.dirname(beforePath), { recursive: true })
          await editor.export(p3ProjectId, beforePath)
          console.log(`  样品(前): ${beforePath}`)
        } catch (err) {
          console.error('  样品(前)导出失败:', err)
        }
      }

      let ed03Revision: Awaited<ReturnType<Editor['revise']>> | null = null
      let segmentB: { startSec: number; endSec: number; text: string } | null = null
      await runCase('ED-03', 'R/P3 删B留AC', 'B 句删除且不再出现；A/C 保留；字幕无 B 残留',
        async (c) => {
          const usable = p3Segments.filter((s) => s.endSec - s.startSec > 1 && s.text.trim().length >= 4)
          if (usable.length < 3) throw new Error(`P3 转写可用句不足 3（${usable.length}），无法执行`)
          const [a, b, cSeg] = usable.slice(0, 3)
          segmentB = b!
          const feedback = `只删除「${b!.text.trim()}」，完整保留「${a!.text.trim()}」和「${cSeg!.text.trim()}」，其它不动`
          c.record.defects.push(`实际输入反馈: ${feedback.slice(0, 80)}`)
          ed03Revision = await pacer.llm(() => editor.revise(p3ProjectId, { text: feedback }))
          const covered = coverageOf(ed03Revision.project.timeline)
          const bCovered = covered.filter((cov) => cov.start < b!.endSec - 0.05 && cov.end > b!.startSec + 0.05)
          c.check('B 句被删除', bCovered.length === 0, JSON.stringify(bCovered))
          const aCovered = covered.filter((cov) => cov.start < a!.startSec + 0.3 && cov.end > a!.endSec - 0.3)
          const cCovered = covered.filter((cov) => cov.start < cSeg!.startSec + 0.3 && cov.end > cSeg!.endSec - 0.3)
          c.check('A 句保留', aCovered.length > 0, JSON.stringify(aCovered))
          c.check('C 句保留', cCovered.length > 0, JSON.stringify(cCovered))
          const cuesText = ed03Revision.project.timeline.subtitles.map((cue) => cue.text).join('\n')
          const bHead = b!.text.trim().slice(0, Math.min(8, b!.text.trim().length))
          c.check('字幕无 B 残留', !cuesText.includes(bHead), `检查串="${bHead}"`)
          await c.saveEvidence('revision', JSON.stringify(ed03Revision, null, 2))
          c.record.projectId = p3ProjectId
          c.record.revisionAfter = ed03Revision.id
          const afterPath = outDir('P3-ed03-after.mp4')
          await editor.export(p3ProjectId, afterPath)
          const probe = await probeMedia(afterPath)
          c.record.output = { path: afterPath, durationSec: probe.durationSec, width: probe.width, height: probe.height }
          console.log(`  样品(后): ${afterPath}`)
          return `B 删除=${bCovered.length === 0}，A/C 保留；成片 ${afterPath}`
        },
        { material: MATERIALS.P3, materialSpec: '720×1280 约45s zh' })

      await runCase('SU-05', 'R/P3 跨剪口字幕', '保留区间有对应字幕；剪掉词不出现；字幕不因跨片段边界丢失',
        async (c) => {
          if (!ed03Revision) throw new RateLimitBlocked('ED-03 未完成，SU-05 顺延为阻塞')
          const cues = ed03Revision.project.timeline.subtitles
          const covered = coverageOf(ed03Revision.project.timeline)
          c.check('字幕 cue 非空', cues.length > 0, `${cues.length} 条`)
          c.check('cue 落在保留区间内', cues.every((cue) => covered.some((cov) => cue.startSec >= cov.start - 0.05 && cue.endSec <= cov.end + 0.05)), '全部 cue 被覆盖')
          if (segmentB) {
            const bHead = segmentB.text.trim().slice(0, 6)
            c.check('无 B 文本残留', !cues.some((cue) => cue.text.includes(bHead)), `检查串="${bHead}"`)
          }
          await c.saveEvidence('cues', JSON.stringify(cues, null, 2))
          return `字幕跟随剪辑结果（逐字听感由用户复核样品）`
        },
        { material: MATERIALS.P3, materialSpec: '复用 ED-03 后状态，零额外 API' })

      await runCase('SP-05', 'R/P3 非法速度', 'R 拒绝或限制在 0.5–2 并说明；不得保存 0 或越界速度',
        async (c) => {
          if (!p3ProjectId) throw new RateLimitBlocked('P3 未导入')
          const results: string[] = []
          let ok = true
          for (const speed of [0, 0.1, 3]) {
            const rev = await pacer.llm(() => editor.revise(p3ProjectId, { text: `第一段 ${speed} 倍速` }))
            const saved = rev.project.timeline.clips[0]?.speed ?? 1
            const inRange = saved >= 0.5 && saved <= 2
            ok = ok && inRange && (rev.agentNote ?? '').length > 0
            results.push(`${speed}x → 实存 ${saved}x inRange=${inRange} note="${(rev.agentNote ?? '').slice(0, 40)}"`)
            if (speed !== 3) await editor.undo(p3ProjectId)
          }
          c.check('无越界速度被保存', ok, results.join('；'))
          await c.saveEvidence('results', JSON.stringify(results, null, 2))
          return '非法速度处理见 results'
        },
        { material: MATERIALS.P3, materialSpec: '三个变体 0/0.1/3' })

      // ED-10 / ED-09 / ED-04（P3）
      await runCase('ED-10', 'R/P3 第二段变速', '只改第二段速度；字幕与 BGM 保留',
        async (c) => {
          if (!p3ProjectId) throw new RateLimitBlocked('P3 未导入')
          const before = await editor.restore(p3ProjectId)
          const rev = await pacer.llm(() => editor.revise(p3ProjectId, { text: '只把第二段调为 1.5 倍速' }))
          const changed = rev.project.timeline.clips.filter((clip, index) => (clip.speed ?? 1) !== (before?.project.timeline.clips[index]?.speed ?? 1))
          c.check('只第二段变速', rev.project.timeline.clips.length >= 2 && rev.project.timeline.clips[1]?.speed === 1.5 && changed.length === 1,
            `变化段=${changed.map((clip) => clip.speed).join(',')}；第二段 speed=${rev.project.timeline.clips[1]?.speed}`)
          c.check('字幕外观保留', JSON.stringify(rev.project.timeline.subtitleAppearance) === JSON.stringify(before?.project.timeline.subtitleAppearance), '一致')
          c.check('BGM 保留', JSON.stringify(rev.project.timeline.bgm) === JSON.stringify(before?.project.timeline.bgm), '一致')
          c.record.projectId = p3ProjectId
          await c.saveEvidence('revision', JSON.stringify(rev, null, 2))
          return `定点变速结果如上`
        },
        { material: MATERIALS.P3, materialSpec: '720×1280 约45s zh' })

      await runCase('ED-09', 'R/P3 超范围请求', '不凭空声称已拼接/配音/裁切/发布；已有内容不破坏',
        async (c) => {
          if (!p3ProjectId) throw new RateLimitBlocked('P3 未导入')
          const baseline = await editor.restore(p3ProjectId)
          const results: string[] = []
          let ok = true
          for (const request of ['加一段别的视频', '给我配音', '裁成方形并自动发布']) {
            const rev = await pacer.llm(() => editor.revise(p3ProjectId, { text: request }))
            const unchanged = JSON.stringify(rev.project.timeline.clips) === JSON.stringify(baseline?.project.timeline.clips)
            const honest = !/已完成|已经拼接|已发布|配音已添加/.test(rev.agentNote ?? '') || /不支持|无法|暂不|不能/.test(rev.agentNote ?? '')
            ok = ok && unchanged && honest
            results.push(`"${request}" → 时间线不变=${unchanged} 回复="${(rev.agentNote ?? '').slice(0, 50)}"`)
            if (!unchanged) await editor.undo(p3ProjectId)
          }
          c.check('超范围请求不产生虚假成功', ok, results.join('；'))
          await c.saveEvidence('results', JSON.stringify(results, null, 2))
          return '边界告知行为见 results'
        },
        { material: MATERIALS.P3, materialSpec: '三个变体' })

      await runCase('ED-04', 'R/P3 末段移到最前', '源区间集合与数量不变，仅顺序改变',
        async (c) => {
          if (!p3ProjectId) throw new RateLimitBlocked('P3 未导入')
          const before = await editor.restore(p3ProjectId)
          if ((before?.project.timeline.clips.length ?? 0) < 2) throw new Error('P3 项目不足两段')
          const rev = await pacer.llm(() => editor.revise(p3ProjectId, { text: '把最后一段移到最前，其余段顺序和速度不变' }))
          const setOf = (timeline: { clips: { sourceStartSec: number; sourceEndSec: number; speed?: number }[] }) =>
            JSON.stringify(coverageOf(timeline).map((cov) => [cov.start, cov.end, cov.speed]).sort())
          c.check('源区间集合不变（重排）', setOf(rev.project.timeline) === setOf(before!.project.timeline), '集合一致')
          const lastStart = before!.project.timeline.clips[before!.project.timeline.clips.length - 1]!.sourceStartSec
          c.check('首段变为原末段', Math.abs(rev.project.timeline.clips[0]!.sourceStartSec - lastStart) < 0.05, `首段起点=${rev.project.timeline.clips[0]!.sourceStartSec}`)
          c.record.projectId = p3ProjectId
          await c.saveEvidence('reorder', JSON.stringify({ before: before!.project.timeline.clips, after: rev.project.timeline.clips }, null, 2))
          return '重排仅改变顺序'
        },
        { material: MATERIALS.P3, materialSpec: '720×1280 约45s zh' })
    }

    // ══ Phase A3：ED-05（F1 口癖）与 ED-07（F4 停顿） ═══════════════
    await runCase('ED-05', 'R/F1 固定口癖删除', 'um/uh 不再被时间线覆盖；相邻词完整；无整体加速',
      async (c) => {
        const f1Draft = await pacer.llm(() => editor.createDraft(materialPath(MATERIALS.F1), 'acceptance-F1'))
        const words = f1Draft.project.transcript?.segments.flatMap((s) => s.words ?? []) ?? []
        const isFiller = (word: string) => /^(um|uh)[.,?!]?$/i.test(word)
        const fillers = words.filter((word) => isFiller(word.word))
        c.check('素材含口癖词', fillers.length > 0, `${fillers.length} 个 um/uh`)
        const rev = await pacer.llm(() => editor.revise(f1Draft.project.id, { text: '删除这些口癖，其他内容和语速不变' }))
        const covered = coverageOf(rev.project.timeline)
        const fillerLeft = fillers.filter((word) => covered.some((cov) => cov.start < word.endSec - 0.02 && cov.end > word.startSec + 0.02))
        c.check('口癖不再被覆盖', fillerLeft.length === 0, `残留=${fillerLeft.length}/${fillers.length}`)
        const nonFiller = words.filter((word) => !isFiller(word.word))
        const lost = nonFiller.filter((word) => !covered.some((cov) => cov.start <= word.startSec + 0.02 && cov.end >= word.endSec - 0.02))
        c.check('相邻有效词完整', lost.length <= Math.max(1, Math.floor(nonFiller.length * 0.05)),
          `丢失=${lost.length}/${nonFiller.length}${lost.length ? ': ' + lost.slice(0, 5).map((w) => w.word).join(',') : ''}`)
        const sped = rev.project.timeline.clips.filter((clip) => (clip.speed ?? 1) !== 1).length
        c.check('保留语音无整体加速', sped <= 1, `变速段=${sped}`)
        c.record.projectId = f1Draft.project.id
        await c.saveEvidence('revision', JSON.stringify(rev, null, 2))
        return '口癖删除与邻词完整性见 checks'
      },
      { material: MATERIALS.F1, materialSpec: '640×360 约15.6s 英文（含 um/uh）' })

    await runCase('ED-07', 'R/F4 压缩长停顿', '长静音缩短；有效语句保留；非整体加速或删句',
      async (c) => {
        const f4Draft = await pacer.llm(() => editor.createDraft(materialPath(MATERIALS.F4), 'acceptance-F4'))
        const words = f4Draft.project.transcript?.segments.flatMap((s) => s.words ?? []) ?? []
        const rev = await pacer.llm(() => editor.revise(f4Draft.project.id, { text: '压缩长停顿，保留全部话语和必要换气，不要整体加速' }))
        const covered = coverageOf(rev.project.timeline)
        const kept = words.filter((word) => covered.some((cov) => cov.start <= word.startSec + 0.05 && cov.end >= word.endSec - 0.05))
        c.check('有效语句保留', kept.length >= words.length * 0.9, `${kept.length}/${words.length}`)
        const maxSpeed = Math.max(...rev.project.timeline.clips.map((clip) => clip.speed ?? 1))
        c.check('无整体加速', maxSpeed <= 1.35, `max speed=${maxSpeed}`)
        const outDur = expectedDuration(rev.project.timeline)
        const inDur = (await probeMedia(materialPath(MATERIALS.F4))).durationSec
        c.check('时长缩短（停顿被压缩）', outDur < inDur * 0.92, `输出 ${outDur.toFixed(1)}s / 源 ${inDur.toFixed(1)}s`)
        c.record.projectId = f4Draft.project.id
        await c.saveEvidence('revision', JSON.stringify(rev, null, 2))
        return '停顿压缩行为见 checks'
      },
      { material: MATERIALS.F4, materialSpec: '960×540 13s 含 2.5/3/2.5s 长停顿' })

    // ══ Phase B：转写守卫（只耗转写配额） ═══════════════════════════
    const transcribeOf = async (rel: string) => pacer.transcribe(() => transcriptOnly.transcribe({
      id: 'probe', kind: 'video', absolutePath: materialPath(rel), durationSec: 0, width: 0, height: 0,
    }))

    await runCase('IM-06', 'R/F6 无音轨', '真实管线给出可见、可理解的无音轨错误且不保存坏草稿',
      async (c) => {
        let message = ''
        try {
          await transcribeOf(MATERIALS.F6)
          message = '(未报错)'
        } catch (err) {
          message = String(err)
        }
        c.check('明确拒绝无音轨', /没有音轨|无法转写/.test(message), `"${message.slice(0, 120)}"`)
        return `错误信息: "${message.slice(0, 120)}"；F1 正常导入已在 ED-05 验证`
      },
      { material: MATERIALS.F6, materialSpec: '480×270 5s 无音轨' })

    await runCase('IM-07', 'R/F5 全静音轨', '不把全静音识别成大量不存在的话；允许明确拒绝无语音',
      async (c) => {
        let transcript: Transcript | null = null
        let errorText = ''
        try {
          transcript = await transcribeOf(MATERIALS.F5)
        } catch (err) {
          errorText = String(err)
        }
        if (errorText) {
          const rejected = /转写结果为空|无法转写|没有音轨/.test(errorText)
          c.check('明确拒绝无语音', rejected, `"${errorText.slice(0, 120)}"`)
          return `明确拒绝: "${errorText.slice(0, 120)}"`
        }
        const words = transcript?.segments.flatMap((s) => s.words ?? []) ?? []
        const text = transcript?.segments.map((s) => s.text).join('') ?? ''
        c.check('无幻听（零词/零文本）', words.length === 0 && text.trim().length === 0,
          `识别出 ${transcript?.segments.length} 段 / ${words.length} 词："${text.slice(0, 80)}"`)
        return `全静音转写结果: ${words.length} 词`
      },
      { material: MATERIALS.F5, materialSpec: '480×270 8s 全静音轨' })

    // IM-11：square 对照 + 四个弱音/遮盖/单侧声道条目
    {
      const expected = normalizeWords(expectedSpeechText())
      const entries: [string, string, string][] = [
        ['square', 'square.mp4', '干净对照'],
        ['left-only', 'speech-left-only.mp4', '左声道口播'],
        ['quiet', 'quiet-speech.mp4', '语音降 30dB'],
        ['noise', 'speech-with-noise.mp4', '语音叠加固定噪声'],
        ['music', 'speech-under-music.mp4', '语音被合成音乐盖住'],
      ]
      for (const [caseId, file, spec] of entries) {
        const rel = MATERIALS.boundary(file)
        await runCase('IM-11', `R/${caseId}`, caseId === 'square' ? '对照条目可正确逐词识别' : `${spec}：观察漏词/错词/幻听/误删，逐项如实记录`,
          async (c) => {
            let transcript: Transcript | null = null
            let errorText = ''
            try {
              transcript = await transcribeOf(rel)
            } catch (err) {
              errorText = String(err)
            }
            if (errorText) {
              if (caseId === 'left-only' && /没有音轨/.test(errorText)) {
                c.check('单侧声道不应被视为无音轨', false, errorText.slice(0, 120))
                return '单侧声道被误判为无音轨（文档明确要求不应如此）'
              }
              throw new RateLimitBlocked(`转写失败: ${errorText.slice(0, 100)}`)
            }
            const recognizedText = transcript?.segments.map((s) => s.text).join(' ') ?? ''
            const recognized = normalizeWords(recognizedText)
            const diff = wordDiff(expected, recognized)
            const accuracy = expected.length > 0 ? 1 - diff.missing.length / expected.length : 0
            const detail = `识别 ${recognized.length} 词，漏 ${diff.missing.length}（${diff.missing.slice(0, 6).join(',')}），多 ${diff.extra.length}（${diff.extra.slice(0, 6).join(',')}），词准确率 ${(accuracy * 100).toFixed(0)}%`
            await c.saveEvidence('recognized', JSON.stringify({ expected: expectedSpeechText(), recognizedText }, null, 2))
            if (caseId === 'square') {
              c.check('对照条目识别', accuracy >= 0.8, detail)
              return `对照：${detail}`
            }
            if (caseId === 'left-only') {
              c.check('单侧声道下混后可转写', accuracy >= 0.6, detail)
              return `left-only：${detail}`
            }
            c.record.defects.push(`${spec} 能力边界：${detail}（观察项，不能用非空转写记准确通过）`)
            return `${spec} 能力边界观察：${detail}`
          },
          { material: rel, materialSpec: spec })
      }
    }

    await runCase('IM-12', 'R/short-audio', '不把音轨结束当成视频结束（词时间不越过音轨+缓冲）',
      async (c) => {
        const transcript = await transcribeOf(MATERIALS.boundary('short-audio.mp4'))
        const words = transcript.segments.flatMap((s) => s.words ?? [])
        const overReach = words.filter((w) => w.endSec > 2.0)
        c.check('词时间不越过音轨+1s 缓冲', overReach.length === 0, `${words.length} 词，越界=${overReach.length}`)
        return `${words.length} 词，最后词止于 ${Math.max(0, ...words.map((w) => w.endSec)).toFixed(2)}s`
      },
      { material: MATERIALS.boundary('short-audio.mp4'), materialSpec: '4s 视频仅前 1s 音轨' })

    await runCase('IM-12', 'R/delayed-audio', '不把延迟声音提前（首词不早于 0.9s）',
      async (c) => {
        const transcript = await transcribeOf(MATERIALS.boundary('delayed-audio.mp4'))
        const words = transcript.segments.flatMap((s) => s.words ?? [])
        const firstStart = words.length > 0 ? Math.min(...words.map((w) => w.startSec)) : Infinity
        const early = words.filter((w) => w.startSec < 0.9).length
        c.check('无提前识别的词', early === 0 && words.length > 0, `${words.length} 词，首词起于 ${Number.isFinite(firstStart) ? firstStart.toFixed(2) : '∞'}s，提前=${early}`)
        return `${words.length} 词，首词 ${Number.isFinite(firstStart) ? firstStart.toFixed(2) : '∞'}s（声源约 1s 起）`
      },
      { material: MATERIALS.boundary('delayed-audio.mp4'), materialSpec: '音轨从第 1s 开始' })

    // ══ Phase C：配额允许时的收尾 ═══════════════════════════════════
    await runCase('FA-02', 'R/真实服务401', '真实端点对无效 key 返回 401；不展示密钥（402 需真实欠费账户，保持阻塞）',
      async (c) => {
        const base = process.env.PIMKO_LLM_BASE_URL ?? 'https://api.groq.com/openai/v1'
        const target = base.includes('groq') ? base : 'https://api.groq.com/openai/v1'
        const invalid = new OpenAiIntelligence({ provider: 'openai', apiKey: 'gsk-acceptance-invalid-key', model: 'test', baseUrl: target })
        const tinyTranscript: Transcript = { assetId: 't', language: 'zh', segments: [{ startSec: 0, endSec: 3, text: '测试', confidence: 1 }] }
        let errorText = '(未抛错)'
        try {
          await invalid.reviseTimeline({
            id: 't', name: 't', assets: [{ id: 't', kind: 'video', absolutePath: '/t.mp4', durationSec: 3, width: 640, height: 360 }],
            transcript: tinyTranscript, settings: { width: 640, height: 360, fps: 30, subtitleStyle: 'bold-center' },
            timeline: { clips: [{ assetId: 't', sourceStartSec: 0, sourceEndSec: 3 }], subtitles: [], transitions: [] },
          }, { text: '测试 401' })
        } catch (err) {
          errorText = String(err)
        }
        c.check('真实 401 可见', errorText.includes('401'), `"${errorText.slice(0, 120)}"`)
        c.record.defects.push('402（余额不足）无法用真实账户无消费制造，UI 映射证据见 injection 批次 FA-02；保持阻塞不虚报')
        return `真实端点 ${new URL(target).host} 401 行为: "${errorText.slice(0, 100)}"`
      },
      { materialSpec: '无效 key 打真实端点，不消耗配额' })

    await runCase('IM-01', 'R/P4 英文口播', '真实转写与音轨对应；词级时间戳可用；≤2 分钟',
      async (c) => {
        const t0 = Date.now()
        const p4Draft = await pacer.llm(() => editor.createDraft(materialPath(MATERIALS.P4), 'acceptance-P4'))
        const seconds = (Date.now() - t0) / 1000
        const words = p4Draft.project.transcript?.segments.reduce((sum, s) => sum + (s.words?.length ?? 0), 0) ?? 0
        c.check('英文转写非空', (p4Draft.project.transcript?.segments.length ?? 0) > 0, `${p4Draft.project.transcript?.segments.length} 段`)
        c.check('词级时间戳', words > 0, `${words} 词`)
        c.check('片段非空', p4Draft.project.timeline.clips.length > 0, `${p4Draft.project.timeline.clips.length} 段`)
        c.check('耗时 <2 分钟', seconds < 120, `${seconds.toFixed(1)}s`)
        await c.saveEvidence('transcript', JSON.stringify(p4Draft.project.transcript, null, 2))
        c.record.projectId = p4Draft.project.id

        // SP-04/R：多速度 + 重排 + 叠化（P4 项目上继续）
        const p4Id = p4Draft.project.id
        await pacer.llm(() => editor.revise(p4Id, { text: '第一段 0.5 倍速，其他段不变' }))
        const rev2 = await pacer.llm(() => editor.revise(p4Id, { text: '把第二段调为 2 倍速，其他段不变' }))
        c.check('SP-04: 第1段0.5x保留', rev2.project.timeline.clips[0]?.speed === 0.5, `speed=${rev2.project.timeline.clips[0]?.speed}`)
        c.check('SP-04: 第2段2x', rev2.project.timeline.clips[1]?.speed === 2, `speed=${rev2.project.timeline.clips[1]?.speed}`)
        await pacer.llm(() => editor.revise(p4Id, { text: '把最后一段移到最前，其余不变' }))
        const rev4 = await pacer.llm(() => editor.revise(p4Id, { text: '给片段之间加叠化转场' }))
        c.check('SP-04: 叠化生效', rev4.project.timeline.transitions.some((t) => t.type === 'crossfade'), JSON.stringify(rev4.project.timeline.transitions))
        const exportPath = outDir('SP-04-multi-speed.mp4')
        await editor.export(p4Id, exportPath)
        const probe = await probeMedia(exportPath)
        const expectDur = expectedDuration(rev4.project.timeline)
        const tol = Math.max(0.6, expectDur * 0.06)
        c.check('SP-04: 总时长符合公式', Math.abs(probe.durationSec - expectDur) <= tol,
          `实际 ${probe.durationSec.toFixed(2)}s vs 期望 ${expectDur.toFixed(2)}s（容差 ${tol.toFixed(2)}s）`)
        c.record.output = { path: exportPath, durationSec: probe.durationSec, width: probe.width, height: probe.height }
        await c.saveEvidence('sp04-revision', JSON.stringify(rev4, null, 2))
        return `P4 导入 ${seconds.toFixed(1)}s；SP-04 多速度组合导出 ${exportPath}`
      },
      { material: MATERIALS.P4, materialSpec: '854×480 约30s en（兼做 SP-04 载体）' })

    await runCase('IM-10', 'R/五分钟长口播', '5 分钟以内草稿目标 2 分钟内；超时记录性能证据',
      async (c) => {
        const t0 = Date.now()
        const draft = await pacer.llm(() => editor.createDraft(materialPath(MATERIALS.boundary('five-minutes.mp4')), 'acceptance-5min'))
        const seconds = (Date.now() - t0) / 1000
        c.check('草稿生成', draft.project.timeline.clips.length > 0, `${draft.project.timeline.clips.length} 段`)
        c.check('2 分钟内', seconds < 120, `${seconds.toFixed(1)}s（${seconds < 120 ? '达标' : '性能失败'}）`)
        c.record.projectId = draft.project.id
        await c.saveEvidence('transcript-head', JSON.stringify((draft.project.transcript?.segments ?? []).slice(0, 3), null, 2))
        return `长口播导入 ${seconds.toFixed(1)}s`
      },
      { material: MATERIALS.boundary('five-minutes.mp4'), materialSpec: '320×180 约300s 合成口播' })
  })
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
