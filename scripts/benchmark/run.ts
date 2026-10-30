/**
 * P0 基准 harness（docs/plans/2026-10-29-editing-core-rebuild.md §5 P0）。
 *
 * 用真实 Editor（provider 默认 mock，不联网）对清单中的每个 case 执行：
 * createDraft → 5 轮 revise → export，外加一条"空时间线不可导出"的拒绝探针。
 * 每轮记录 revisionId、时间线时长、片段数、diff、错误、耗时；结果写入
 * <out>/<caseId>/result.json 与 summary.md，评分见 score.ts。
 *
 * 用法：
 *   npm run benchmark [-- --manifest <path>] [--case <id>] [--out <dir>] [--provider mock]
 * 素材目录由环境变量 PIMKO_BENCHMARK_DIR 指定；文件缺失会明确报缺失，不伪造。
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { timelineDurationSec } from '../../src/domain/timeline'
import type { ProjectRevision, RevisionDiff } from '../../src/domain/project'
import { FfmpegProber } from '../../src/infra/ffmpeg-prober'
import { FfmpegRenderer } from '../../src/infra/ffmpeg-renderer'
import { FfmpegInspector } from '../../src/infra/ffmpeg-inspector'
import { FfmpegSceneAnalyzer } from '../../src/infra/ffmpeg-scene-analyzer'
import { FfmpegSilenceAnalyzer } from '../../src/infra/ffmpeg-silence-analyzer'
import { resolveFfprobe } from '../../src/infra/ffmpeg-bin'
import { FsProjectStore } from '../../src/infra/fs-store'
import { MockIntelligence } from '../../src/infra/mock-intelligence'
import { MockPlanner } from '../../src/infra/mock-planner'
import { MockTranscriber } from '../../src/infra/mock-transcriber'
import { VisualPlanner } from '../../src/infra/visual-planner'
import { createIntelligence, createPlanner, createTranscriber } from '../../src/infra/ai-factory'
import { loadDotEnv } from '../../src/infra/env'
import { loadLlmConfig } from '../../src/infra/llm-config'
import { Editor } from '../../src/services/editor'
import type { QualityReport } from '../../src/domain/quality'
import { emptyEditDocument } from '../../src/domain/document'

const execFileAsync = promisify(execFile)

interface ManifestCase {
  id: string
  title: string
  contentKind: string
  file: string
  description?: string
  /** 替代清单用：标注被替代的正式素材文件名。 */
  standinFor?: string
  rounds?: string[]
}

interface Manifest {
  version: number
  description?: string
  defaultRounds?: string[]
  cases: ManifestCase[]
}

interface StepRecord {
  revisionId: string | null
  elapsedMs: number | null
  clipCount: number | null
  durationSec: number | null
  error: string | null
}

interface RoundRecord extends StepRecord {
  index: number
  feedback: string
  diff: RevisionDiff | null
  agentNote: string | null
}

interface ExportRecord {
  revisionId: string | null
  expectedSec: number | null
  actualSec: number | null
  durationDeltaSec: number | null
  elapsedMs: number | null
  outputPath: string | null
  quality: QualityReport | null
  error: string | null
}

export interface CaseResult {
  schemaVersion: 1
  caseId: string
  title: string
  contentKind: string
  description: string | null
  asset: { file: string; resolvedPath: string | null; standinFor: string | null; sha256: string | null }
  provider: string
  status: 'ok' | 'failed' | 'missing-assets'
  missingPath: string | null
  startedAt: string
  finishedAt: string
  roundsPlanned: string[]
  draft: (StepRecord & { transcriptSegments: number | null; agentNote: string | null }) | null
  rounds: RoundRecord[]
  export: ExportRecord | null
  emptyTimelineRejection: { attempted: boolean; rejected: boolean; errorMessage: string | null } | null
  errors: string[]
}

const DEFAULT_ROUNDS = [
  '开头太拖，收紧开头直接进正题',
  '去掉口癖和废话，让语言更紧凑',
  '第一段 1.5 倍速',
  '把节奏重排一下，把高潮放前面',
  '字幕字体大一点',
]

const USAGE = `用法: tsx scripts/benchmark/run.ts [选项]
  --manifest <path>   清单文件（默认 scripts/benchmark/manifest.json）
  --case <id>         只跑指定 case，可重复传入（默认全部）
  --out <dir>         输出目录（默认 .tmp/benchmark）
  --provider <name>   mock（默认，不联网）或 real（读取 .env 的真实模型/转写）
  --round-delay <s>   真实模型每轮之间的等待秒数（避免免费档 TPM 限流）`

interface CliArgs {
  manifestPath: string
  caseIds: string[]
  outDir: string
  provider: string
  roundDelayMs: number
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    manifestPath: path.join(__dirname, 'manifest.json'),
    caseIds: [],
    outDir: path.join(process.cwd(), '.tmp', 'benchmark'),
    provider: 'mock',
    roundDelayMs: 0,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--manifest' && value) {
      args.manifestPath = path.resolve(value)
      i += 1
    } else if (flag === '--case' && value) {
      args.caseIds.push(value)
      i += 1
    } else if (flag === '--out' && value) {
      args.outDir = path.resolve(value)
      i += 1
    } else if (flag === '--provider' && value) {
      args.provider = value
      i += 1
    } else if (flag === '--round-delay' && value) {
      args.roundDelayMs = Math.max(0, Number(value) || 0) * 1000
      i += 1
    } else if (flag === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else {
      throw new Error(`未知参数: ${flag ?? ''}\n${USAGE}`)
    }
  }
  return args
}

function fail(message: string): never {
  console.error(`[benchmark] ${message}`)
  process.exit(2)
}

async function loadManifest(manifestPath: string): Promise<Manifest> {
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    return fail(`无法读取清单文件: ${manifestPath}`)
  }
  const manifest = JSON.parse(raw) as Manifest
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    return fail(`清单没有 cases: ${manifestPath}`)
  }
  const seen = new Set<string>()
  for (const item of manifest.cases) {
    if (!item.id || !item.file || !item.contentKind) {
      return fail(`清单 case 缺少 id/file/contentKind: ${JSON.stringify(item)}`)
    }
    if (seen.has(item.id)) return fail(`清单 case id 重复: ${item.id}`)
    seen.add(item.id)
  }
  return manifest
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', () => resolve(''))
  })
}

async function probeDurationSec(file: string): Promise<number> {
  const { stdout } = await execFileAsync(resolveFfprobe(), [
    '-v', 'error', '-print_format', 'json', '-show_format', file,
  ])
  const duration = Number((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`无法读取输出时长: ${file}`)
  return duration
}

function elapsedMsSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function recordFromRevision(revision: ProjectRevision | null, elapsedMs: number, error: string | null): StepRecord {
  return {
    revisionId: revision?.id ?? null,
    elapsedMs: error ? null : elapsedMs,
    clipCount: revision?.project.timeline.clips.length ?? null,
    durationSec: revision ? Number(timelineDurationSec(revision.project.timeline).toFixed(3)) : null,
    error,
  }
}

/** 空时间线探针：向 store 追加一条空时间线修订，验证 Editor.export 会拒绝（计划 §4.2 不变量）。 */
async function emptyTimelineProbe(
  editor: Editor,
  storeRoot: string,
  lastRevision: ProjectRevision,
  outputPath: string,
): Promise<{ attempted: boolean; rejected: boolean; errorMessage: string | null }> {
  const store = new FsProjectStore(storeRoot)
  const probeProject = structuredClone(lastRevision.project)
  probeProject.timeline = { clips: [], subtitles: [], transitions: [] }
  probeProject.document = emptyEditDocument()
  const probeRevision: ProjectRevision = {
    id: randomUUID(),
    project: probeProject,
    parentRevisionId: lastRevision.id,
    operation: { kind: 'edit' },
    feedback: { text: '基准探针：清空时间线（不应可导出）' },
    agentNote: 'P0 基准探针：验证空时间线导出会被拒绝，随后即可丢弃。',
    createdAt: new Date(Math.max(Date.now(), Date.parse(lastRevision.createdAt) + 1)).toISOString(),
  }
  await store.save(probeRevision)
  try {
    await editor.export(lastRevision.project.id, outputPath)
    return { attempted: true, rejected: false, errorMessage: null }
  } catch (err) {
    return { attempted: true, rejected: true, errorMessage: errorMessage(err) }
  }
}

async function runCase(
  item: ManifestCase,
  rounds: string[],
  resolvedPath: string,
  outDir: string,
  provider: string,
  roundDelayMs = 0,
): Promise<CaseResult> {
  const caseDir = path.join(outDir, item.id)
  const workDir = path.join(outDir, '.work', item.id)
  const storeRoot = path.join(workDir, 'store')
  await rm(caseDir, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
  await mkdir(caseDir, { recursive: true })
  await mkdir(storeRoot, { recursive: true })

  const result: CaseResult = {
    schemaVersion: 1,
    caseId: item.id,
    title: item.title,
    contentKind: item.contentKind,
    description: item.description ?? null,
    asset: { file: item.file, resolvedPath, standinFor: item.standinFor ?? null, sha256: null },
    provider,
    status: 'failed',
    missingPath: null,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    roundsPlanned: rounds,
    draft: null,
    rounds: [],
    export: null,
    emptyTimelineRejection: null,
    errors: [],
  }
  result.asset.sha256 = await sha256(resolvedPath)

  const config = provider === 'real' ? loadLlmConfig() : undefined
  const planner = config ? createPlanner(config) : new MockPlanner()
  const editor = new Editor({
    prober: new FfmpegProber(),
    transcriber: config ? createTranscriber(config) : new MockTranscriber(),
    intelligence: config ? createIntelligence(config) : new MockIntelligence(),
    planner,
    visualPlanner: new VisualPlanner({
      analyzer: new FfmpegSceneAnalyzer(),
      transcriptPlanner: planner,
    }),
    renderer: new FfmpegRenderer(),
    inspector: new FfmpegInspector(),
    store: new FsProjectStore(storeRoot),
    silenceAnalyzer: new FfmpegSilenceAnalyzer(),
  })

  let lastRevision: ProjectRevision | null = null

  // 建稿
  {
    const startedAt = performance.now()
    try {
      const draft = await editor.createDraft(resolvedPath, `${item.id} ${item.title}`)
      lastRevision = draft
      const record = recordFromRevision(draft, elapsedMsSince(startedAt), null)
      result.draft = {
        ...record,
        transcriptSegments: draft.project.transcript?.segments.length ?? null,
        agentNote: draft.agentNote ?? null,
      }
    } catch (err) {
      const message = errorMessage(err)
      result.errors.push(`建稿失败: ${message}`)
      result.draft = {
        revisionId: null, elapsedMs: elapsedMsSince(startedAt), clipCount: null,
        durationSec: null, error: message, transcriptSegments: null, agentNote: null,
      }
    }
  }

  // 5 轮反馈；单轮失败记录错误后继续（修订链停留在上一版）
  for (let index = 0; index < rounds.length; index += 1) {
    const feedback = rounds[index]!
    if (!lastRevision) break
    const startedAt = performance.now()
    try {
      const revised = await editor.revise(lastRevision.project.id, { text: feedback })
      lastRevision = revised
      result.rounds.push({
        ...recordFromRevision(revised, elapsedMsSince(startedAt), null),
        index: index + 1,
        feedback,
        diff: revised.diff ?? null,
        agentNote: revised.agentNote ?? null,
      })
    } catch (err) {
      const message = errorMessage(err)
      result.errors.push(`第 ${index + 1} 轮修订失败: ${message}`)
      result.rounds.push({
        ...recordFromRevision(null, elapsedMsSince(startedAt), message),
        index: index + 1,
        feedback,
        diff: null,
        agentNote: null,
      })
    }
    if (roundDelayMs > 0 && index < rounds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, roundDelayMs))
    }
  }

  // 导出最终版
  if (lastRevision) {
    const outputPath = path.join(caseDir, 'export-final.mp4')
    const expectedSec = Number(timelineDurationSec(lastRevision.project.timeline).toFixed(3))
    const startedAt = performance.now()
    const exportRecord: ExportRecord = {
      revisionId: lastRevision.id,
      expectedSec,
      actualSec: null,
      durationDeltaSec: null,
      elapsedMs: null,
      outputPath: null,
      quality: null,
      error: null,
    }
    try {
      const outcome = await editor.export(lastRevision.project.id, outputPath)
      const realPath = outcome.outputPath
      exportRecord.quality = outcome.quality
      exportRecord.elapsedMs = elapsedMsSince(startedAt)
      exportRecord.outputPath = path.relative(process.cwd(), realPath) || realPath
      exportRecord.actualSec = Number((await probeDurationSec(realPath)).toFixed(3))
      exportRecord.durationDeltaSec = Number((exportRecord.actualSec - expectedSec).toFixed(3))
    } catch (err) {
      exportRecord.elapsedMs = elapsedMsSince(startedAt)
      exportRecord.error = errorMessage(err)
      result.errors.push(`导出失败: ${exportRecord.error}`)
    }
    result.export = exportRecord

    // 空时间线拒绝探针（放在最后：探针修订会成为 latest）
    result.emptyTimelineRejection = await emptyTimelineProbe(
      editor, storeRoot, lastRevision, path.join(caseDir, 'export-empty-probe.mp4'),
    )
    if (!result.emptyTimelineRejection.rejected) {
      result.errors.push('空时间线探针未被拒绝：Editor.export 允许导出空时间线，违反不变量。')
    }
  }

  if (result.draft && !result.draft.error && result.rounds.every((r) => !r.error) && !result.export?.error) {
    result.status = 'ok'
  }
  result.finishedAt = new Date().toISOString()
  return result
}

function fmtDiff(diff: RevisionDiff | null): string {
  if (!diff) return '—'
  const parts = [
    `+${diff.added}`, `-${diff.removed}`, `~${diff.moved}`, `⏩${diff.spedUp}`,
    `Δ${diff.durationDeltaSec >= 0 ? '+' : ''}${diff.durationDeltaSec}s`,
  ]
  return parts.join(' ')
}

function fmtSeconds(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(3)}s`
}

function fmtMs(value: number | null): string {
  return value === null ? '—' : `${value}ms`
}

function summaryMarkdown(result: CaseResult, rounds: string[]): string {
  const lines: string[] = []
  lines.push(`# ${result.caseId} · ${result.title}（${result.provider} baseline）`)
  lines.push('')
  lines.push(`- 状态：**${result.status}**`)
  const standin = result.asset.standinFor ? `（替代素材，替代 ${result.asset.standinFor}）` : ''
  lines.push(`- 素材：${result.asset.resolvedPath ?? result.asset.file}${standin}`)
  if (result.asset.sha256) lines.push(`- 素材 sha256：${result.asset.sha256}`)
  if (result.description) lines.push(`- 说明：${result.description}`)
  lines.push('')

  if (result.status === 'missing-assets') {
    lines.push(`缺少素材文件：${result.missingPath}。本条 case 未运行，数据缺失，不伪造。`)
    lines.push('')
    return lines.join('\n')
  }

  lines.push('## 建稿')
  if (result.draft) {
    lines.push(
      `- revision ${result.draft.revisionId ?? '—'} · 片段 ${result.draft.clipCount ?? '—'} · ` +
      `时长 ${fmtSeconds(result.draft.durationSec)} · 转写段 ${result.draft.transcriptSegments ?? '—'} · 耗时 ${fmtMs(result.draft.elapsedMs)}`,
    )
    if (result.draft.agentNote) lines.push(`- 说明：${result.draft.agentNote}`)
    if (result.draft.error) lines.push(`- 错误：${result.draft.error}`)
  } else {
    lines.push('- 未运行')
  }
  lines.push('')

  lines.push('## 修订轮次')
  lines.push('| 轮次 | 反馈 | 片段 | 时长 | diff (增/删/移/变速/Δ时长) | 耗时 | 说明 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const round of result.rounds) {
    const note = (round.agentNote ?? round.error ?? '').replaceAll('|', '\\|')
    lines.push(
      `| ${round.index} | ${round.feedback.replaceAll('|', '\\|')} | ${round.clipCount ?? '—'} | ` +
      `${fmtSeconds(round.durationSec)} | ${fmtDiff(round.diff)} | ${fmtMs(round.elapsedMs)} | ${note} |`,
    )
  }
  const missing = rounds.slice(result.rounds.length)
  for (const feedback of missing) {
    lines.push(`| — | ${feedback.replaceAll('|', '\\|')} | — | — | — | — | 未执行（前面步骤失败） |`)
  }
  lines.push('')

  lines.push('## 导出')
  if (result.export) {
    const delta = result.export.durationDeltaSec
    const deltaText = delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s`
    lines.push(`- revision ${result.export.revisionId ?? '—'} · 预计 ${fmtSeconds(result.export.expectedSec)} · 实际 ${fmtSeconds(result.export.actualSec)} · 误差 ${deltaText}`)
    lines.push(`- 耗时 ${fmtMs(result.export.elapsedMs)} · 输出 ${result.export.outputPath ?? '—'}`)
    if (result.export.error) lines.push(`- 错误：${result.export.error}`)
  } else {
    lines.push('- 未运行')
  }
  lines.push('')

  lines.push('## 不变量探针')
  const probe = result.emptyTimelineRejection
  if (probe) {
    lines.push(
      probe.rejected
        ? `- 空时间线导出：已拒绝 ✓（${probe.errorMessage}）`
        : '- 空时间线导出：**未被拒绝 ✗**（真实缺陷）',
    )
  } else {
    lines.push('- 空时间线导出：未执行')
  }
  lines.push('')

  lines.push('## 未测量')
  lines.push('- 切点质量（切词率、爆音、镜头切断、黑帧、字幕同步）：当前链路（P0，pre-P1）没有质量闸门与切点检查，标记 `unmeasured`，不是 0。')
  lines.push('')
  if (result.errors.length > 0) {
    lines.push('## 错误汇总')
    for (const error of result.errors) lines.push(`- ${error}`)
    lines.push('')
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.provider !== 'mock' && args.provider !== 'real') {
    fail(`provider 只支持 mock 或 real（当前: ${args.provider}）。`)
  }
  await loadDotEnv()
  if (args.provider === 'real') {
    const config = loadLlmConfig()
    if (config.provider === 'mock') fail('--provider real 需要 providers.json 中的 profile，或旧版 .env 的 PIMKO_LLM_PROVIDER=openai + PIMKO_LLM_API_KEY。')
  }

  const manifest = await loadManifest(args.manifestPath)
  const assetDirEnv = process.env.PIMKO_BENCHMARK_DIR
  if (!assetDirEnv) {
    fail('未设置环境变量 PIMKO_BENCHMARK_DIR（素材目录）。请指向包含清单素材的目录，例如:\n  PIMKO_BENCHMARK_DIR=/path/to/assets tsx scripts/benchmark/run.ts')
  }
  if (!existsSync(assetDirEnv)) {
    fail(`PIMKO_BENCHMARK_DIR 指向的目录不存在: ${assetDirEnv}`)
  }

  let cases = manifest.cases
  if (args.caseIds.length > 0) {
    const known = new Set(cases.map((item) => item.id))
    for (const id of args.caseIds) {
      if (!known.has(id)) fail(`清单中没有 case: ${id}（可用: ${[...known].join(', ')}）`)
    }
    cases = cases.filter((item) => args.caseIds.includes(item.id))
  }

  await mkdir(args.outDir, { recursive: true })
  const runStartedAt = new Date().toISOString()
  const results: CaseResult[] = []
  const missingFiles: string[] = []

  for (const item of cases) {
    const rounds = item.rounds ?? manifest.defaultRounds ?? DEFAULT_ROUNDS
    const resolvedPath = path.resolve(assetDirEnv, item.file)
    if (!isFile(resolvedPath)) {
      missingFiles.push(resolvedPath)
      console.log(`[${item.id}] 缺少素材: ${resolvedPath} —— 跳过，明确记录缺失`)
      const startedAt = new Date().toISOString()
      const result: CaseResult = {
        schemaVersion: 1,
        caseId: item.id,
        title: item.title,
        contentKind: item.contentKind,
        description: item.description ?? null,
        asset: { file: item.file, resolvedPath: null, standinFor: item.standinFor ?? null, sha256: null },
        provider: args.provider,
        status: 'missing-assets',
        missingPath: resolvedPath,
        startedAt,
        finishedAt: startedAt,
        roundsPlanned: rounds,
        draft: null,
        rounds: [],
        export: null,
        emptyTimelineRejection: null,
        errors: [`缺少素材文件: ${resolvedPath}`],
      }
      results.push(result)
      const caseDir = path.join(args.outDir, item.id)
      await mkdir(caseDir, { recursive: true })
      await writeFile(path.join(caseDir, 'result.json'), JSON.stringify(result, null, 2))
      await writeFile(path.join(caseDir, 'summary.md'), summaryMarkdown(result, rounds))
      continue
    }

    console.log(`[${item.id}] ${item.title} 开始：${resolvedPath}`)
    const result = await runCase(item, rounds, resolvedPath, args.outDir, args.provider, args.roundDelayMs)
    results.push(result)
    const caseDir = path.join(args.outDir, item.id)
    await mkdir(caseDir, { recursive: true })
    await writeFile(path.join(caseDir, 'result.json'), JSON.stringify(result, null, 2))
    await writeFile(path.join(caseDir, 'summary.md'), summaryMarkdown(result, rounds))
    const probe = result.emptyTimelineRejection
    console.log(
      `[${item.id}] ${result.status} · 建稿 ${fmtMs(result.draft?.elapsedMs ?? null)} · ` +
      `${result.rounds.length} 轮修订 · 导出 ${fmtMs(result.export?.elapsedMs ?? null)} ` +
      `(误差 ${result.export?.durationDeltaSec === null || result.export === null ? '—' : `${result.export.durationDeltaSec >= 0 ? '+' : ''}${result.export.durationDeltaSec}s`}) · ` +
      `空时间线拒绝 ${probe ? (probe.rejected ? '✓' : '✗ 未拒绝!') : '未执行'}`,
    )
  }

  const allOk = results.every((result) => result.status === 'ok')
  await writeFile(path.join(args.outDir, 'run.json'), JSON.stringify({
    schemaVersion: 1,
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    provider: args.provider,
    manifestPath: args.manifestPath,
    assetDir: assetDirEnv,
    outDir: args.outDir,
    argv: process.argv.slice(2),
    cases: results.map((result) => ({ id: result.caseId, status: result.status })),
  }, null, 2))

  console.log('')
  console.log(`完成：${results.filter((r) => r.status === 'ok').length}/${results.length} 个 case ok；结果目录 ${args.outDir}`)
  if (missingFiles.length > 0) {
    console.error('')
    console.error(`缺少 ${missingFiles.length} 个素材文件（对应 case 未运行，结果里标记 missing-assets）：`)
    for (const file of missingFiles) console.error(`  - ${file}`)
    console.error('请把它们放入 PIMKO_BENCHMARK_DIR 或用正式语料补齐后重跑。')
  }
  if (!allOk) process.exitCode = 1
}

void main().catch((error) => {
  console.error('[benchmark] 未预期错误:', error)
  process.exitCode = 1
})
