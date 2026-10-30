/**
 * P0 基准评分（docs/plans/2026-10-29-editing-core-rebuild.md §5 P0）。
 *
 * 读取 run.ts 产生的 <out>/<caseId>/result.json，按内容类型分组汇总：
 * 成功/失败、建稿/修订/导出耗时、预计/实际时长误差、空时间线拒绝次数、每轮 diff。
 * 切点质量（切词率、爆音、镜头切断、黑帧、字幕同步）当前链路没有数据源，
 * 显式标记 unmeasured，不伪报 0。
 *
 * 用法：
 *   npm run benchmark:score [-- --out <dir>]     # 默认 .tmp/benchmark
 * 输出打印到 stdout 并写入 <out>/score-report.md。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CaseResult } from './run'

const USAGE = '用法: tsx scripts/benchmark/score.ts [--out <dir>]（默认 .tmp/benchmark）'

const GROUP_ORDER = ['speech', 'visual', 'tutorial', 'boundary']
const GROUP_LABEL: Record<string, string> = {
  speech: '口播（speech）',
  visual: '蒙太奇/视觉（visual）',
  tutorial: '教程/录屏（tutorial）',
  boundary: '合成边界（boundary）',
}

/** 计划 §4.2：输出时长与编译预计误差 < 100ms。 */
const DURATION_TARGET_SEC = 0.1

interface RunContext {
  provider?: string
  manifestPath?: string
  assetDir?: string
  startedAt?: string
  finishedAt?: string
}

function fmtMs(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value}ms`
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function max(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.max(...values)
}

function fmtSecDelta(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}s`
}

async function loadResults(outDir: string): Promise<CaseResult[]> {
  const entries = await readdir(outDir, { withFileTypes: true })
  const results: CaseResult[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    try {
      const raw = await readFile(path.join(outDir, entry.name, 'result.json'), 'utf8')
      results.push(JSON.parse(raw) as CaseResult)
    } catch {
      // 没有 result.json 的目录（如 .work）不是 case 结果，跳过。
    }
  }
  results.sort((a, b) => a.caseId.localeCompare(b.caseId))
  return results
}

interface DiffTotals {
  rounds: number
  roundsWithError: number
  clipUnchangedRounds: number
  added: number
  removed: number
  moved: number
  spedUp: number
}

function diffTotals(results: CaseResult[]): DiffTotals {
  const totals: DiffTotals = { rounds: 0, roundsWithError: 0, clipUnchangedRounds: 0, added: 0, removed: 0, moved: 0, spedUp: 0 }
  for (const result of results) {
    for (const round of result.rounds) {
      totals.rounds += 1
      if (round.error) totals.roundsWithError += 1
      if (!round.diff) continue
      const { added, removed, moved, spedUp, durationDeltaSec } = round.diff
      totals.added += added
      totals.removed += removed
      totals.moved += moved
      totals.spedUp += spedUp
      if (added === 0 && removed === 0 && moved === 0 && spedUp === 0 && durationDeltaSec === 0) {
        totals.clipUnchangedRounds += 1
      }
    }
  }
  return totals
}

function statusLabel(result: CaseResult): string {
  if (result.status === 'ok') return 'ok'
  if (result.status === 'missing-assets') return '缺素材'
  return '失败'
}

function groupSection(kind: string, results: CaseResult[]): string {
  const lines: string[] = []
  const label = GROUP_LABEL[kind] ?? kind
  lines.push(`## ${label}`)
  lines.push('')
  lines.push('| case | 状态 | 建稿耗时 | 修订均耗时 | 导出耗时 | 导出时长误差 | 空时间线拒绝 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const result of results) {
    const roundTimes = result.rounds.map((round) => round.elapsedMs).filter((value): value is number => value !== null)
    const roundAvg = avg(roundTimes)
    const delta = result.export?.durationDeltaSec
    const probe = result.emptyTimelineRejection
    const probeText = !probe
      ? '—'
      : probe.rejected
        ? `拒绝 ✓（${probe.errorMessage ?? ''}）`
        : '**未拒绝 ✗**'
    lines.push(
      `| ${result.caseId} ${result.title} | ${statusLabel(result)} | ${fmtMs(result.draft?.elapsedMs)} | ` +
      `${fmtMs(roundAvg)} | ${fmtMs(result.export?.elapsedMs)} | ` +
      `${delta === null || delta === undefined ? '—' : fmtSecDelta(delta)} | ${probeText} |`,
    )
  }
  lines.push('')

  const ok = results.filter((result) => result.status === 'ok')
  const failed = results.filter((result) => result.status === 'failed')
  const missing = results.filter((result) => result.status === 'missing-assets')
  const draftTimes = ok.map((result) => result.draft?.elapsedMs).filter((value): value is number => value !== undefined && value !== null)
  const roundTimes = results.flatMap((result) => result.rounds.map((round) => round.elapsedMs)).filter((value): value is number => value !== null)
  const exportTimes = ok.map((result) => result.export?.elapsedMs).filter((value): value is number => value !== undefined && value !== null)
  const deltas = ok
    .map((result) => result.export?.durationDeltaSec)
    .filter((value): value is number => value !== undefined && value !== null)
  const overTarget = deltas.filter((value) => Math.abs(value) > DURATION_TARGET_SEC)
  const probes = results.map((result) => result.emptyTimelineRejection).filter((probe): probe is NonNullable<typeof probe> => probe !== null)
  const rejected = probes.filter((probe) => probe.rejected)
  const totals = diffTotals(results)

  lines.push('### 汇总')
  lines.push(`- 成功/失败/缺素材：${ok.length} / ${failed.length} / ${missing.length}`)
  lines.push(`- 建稿耗时：均值 ${fmtMs(avg(draftTimes))}，最大 ${fmtMs(max(draftTimes))}`)
  lines.push(`- 修订耗时：均值 ${fmtMs(avg(roundTimes))}（${totals.rounds} 轮，其中 ${totals.roundsWithError} 轮出错）`)
  lines.push(`- 导出耗时：均值 ${fmtMs(avg(exportTimes))}，最大 ${fmtMs(max(exportTimes))}`)
  if (deltas.length > 0) {
    lines.push(
      `- 导出时长误差（实际−预计）：${deltas.map(fmtSecDelta).join('，')}；` +
      `最大绝对误差 ${Math.max(...deltas.map(Math.abs)).toFixed(3)}s；` +
      `超过 ${DURATION_TARGET_SEC}s 目标（计划 §4.2）的 case：${overTarget.length}/${deltas.length}`,
    )
  } else {
    lines.push('- 导出时长误差：无数据（没有成功的导出）')
  }
  lines.push(`- 空时间线拒绝：${rejected.length}/${probes.length}${probes.length > rejected.length ? ' —— **存在未被拒绝的探针，违反不变量**' : ''}`)
  lines.push(
    `- 每轮 diff 累计：+${totals.added} / −${totals.removed} / 移动 ${totals.moved} / 变速 ${totals.spedUp}；` +
    `片段层面无变化的轮次 ${totals.clipUnchangedRounds}/${totals.rounds}（含仅字幕外观与 mock 不支持的反馈）`,
  )
  lines.push('')
  return lines.join('\n')
}

function unmeasuredSection(): string {
  const lines: string[] = []
  lines.push('## 未测量（unmeasured，不是 0）')
  lines.push('')
  lines.push('当前链路（P0，pre-P1）没有质量闸门与切点检查，以下计划 §4.2 指标没有数据源，显式标记 unmeasured：')
  lines.push('')
  lines.push('| 指标 | 状态 | 说明 |')
  lines.push('|---|---|---|')
  lines.push('| 切词率（切点落在词内部） | `unmeasured` | P2 词边界吸附 + P3 wordCut 检查接入后才有数据 |')
  lines.push('| 切点爆音数 | `unmeasured` | P3 pop 检查接入后才有数据 |')
  lines.push('| 稳定镜头被切断率 | `unmeasured` | P4 sceneBreak 检查接入后才有数据 |')
  lines.push('| 黑帧/冻结帧 | `unmeasured` | P3/P4 blackFrame/frozenFrame 检查接入后才有数据 |')
  lines.push('| 字幕同步最大误差 | `unmeasured` | P3 subtitleOcclusion/同步检查接入后才有数据 |')
  lines.push('| 质量闸门通过率 | `unmeasured` | P3 QualityGate 尚未实现 |')
  lines.push('| 主观可发布 | `unmeasured` | 需人工评分；mock 剪辑无语义，不适用 |')
  lines.push('')
  lines.push('本报告中已测量的只有 harness 可观测项：流程成败、耗时、时长一致性、空时间线拒绝、每轮 diff。')
  lines.push('')
  return lines.join('\n')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let outDir = path.join(process.cwd(), '.tmp', 'benchmark')
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) {
      outDir = path.resolve(argv[i + 1]!)
      i += 1
    } else if (argv[i] === '--help') {
      console.log(USAGE)
      return
    } else {
      console.error(`[score] 未知参数: ${argv[i] ?? ''}\n${USAGE}`)
      process.exitCode = 2
      return
    }
  }

  let context: RunContext = {}
  try {
    context = JSON.parse(await readFile(path.join(outDir, 'run.json'), 'utf8')) as RunContext
  } catch {
    // 没有 run.json 也能评分（只读各 case 的 result.json）。
  }

  const results = await loadResults(outDir)
  if (results.length === 0) {
    console.error(`[score] ${outDir} 下没有找到任何 case 的 result.json。请先运行: npm run benchmark`)
    process.exitCode = 1
    return
  }

  const kinds = [...new Set(results.map((result) => result.contentKind))]
    .sort((a, b) => {
      const indexA = GROUP_ORDER.indexOf(a)
      const indexB = GROUP_ORDER.indexOf(b)
      return (indexA === -1 ? GROUP_ORDER.length : indexA) - (indexB === -1 ? GROUP_ORDER.length : indexB)
    })

  const lines: string[] = []
  lines.push('# Pimko P0 mock baseline 评分报告')
  lines.push('')
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push(`- 结果目录：${outDir}`)
  if (context.provider) lines.push(`- provider：${context.provider}（离线 mock；真实模型基准属 P6）`)
  if (context.manifestPath) lines.push(`- 清单：${context.manifestPath}`)
  if (context.assetDir) lines.push(`- 素材目录：${context.assetDir}`)
  lines.push(`- case 数：${results.length}`)
  lines.push('')
  lines.push('> 口径说明：本报告只汇总 harness 可观测项。切点质量全部 `unmeasured`（见下节），不代表通过也不代表 0。')
  if (results.some((result) => result.asset.standinFor)) {
    lines.push('> 本次运行包含替代素材（standinFor 非空），切点/语义类结论不可外推到正式语料。')
  }
  lines.push('')
  lines.push('> 确定性说明：片段数、diff、时长误差、拒绝探针等结构指标同一输入可复现；耗时随机器负载波动。')
  lines.push('')

  for (const kind of kinds) {
    lines.push(groupSection(kind, results.filter((result) => result.contentKind === kind)))
  }

  const ok = results.filter((result) => result.status === 'ok').length
  lines.push('## 总体')
  lines.push('')
  lines.push(`- 成功 ${ok}/${results.length}；失败 ${results.filter((r) => r.status === 'failed').length}；缺素材 ${results.filter((r) => r.status === 'missing-assets').length}`)
  const probes = results.map((result) => result.emptyTimelineRejection).filter((probe): probe is NonNullable<typeof probe> => probe !== null)
  lines.push(`- 空时间线拒绝探针：${probes.filter((probe) => probe.rejected).length}/${probes.length} 通过`)
  lines.push('- 回归检查（npm run check:editing 31 项）：本报告未覆盖，需单独运行')
  lines.push('')
  lines.push(unmeasuredSection())

  const report = lines.join('\n')
  const reportPath = path.join(outDir, 'score-report.md')
  await writeFile(reportPath, report)
  console.log(report)
  console.log(`\n[score] 报告已写入: ${reportPath}`)
}

void main().catch((error) => {
  console.error('[score] 未预期错误:', error)
  process.exitCode = 1
})
