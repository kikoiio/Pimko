/**
 * 汇总 .tmp/acceptance/**\/record.json → .tmp/acceptance/records.md（Markdown 表格 + 统计）。
 * 在 CI 结束后本机执行（纯读取，无重型负载），输出供人工查看与补充缺陷分析。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { CaseRecord } from './lib'

/** 递归收集目录下全部 record.json。 */
async function walkRecords(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await walkRecords(full))
    else if (entry.name === 'record.json') found.push(full)
  }
  return found
}

const root = path.resolve(__dirname, '..', '..')
const acceptanceRoot = path.join(root, '.tmp', 'acceptance')

interface Row {
  batch: string
  record: CaseRecord
}

async function collect(): Promise<Row[]> {
  const rows: Row[] = []
  if (!existsSync(acceptanceRoot)) return rows
  for (const batch of await readdir(acceptanceRoot)) {
    const batchPath = path.join(acceptanceRoot, batch)
    if (!(await stat(batchPath)).isDirectory() || batch === 'ffmpeg-shim') continue
    for (const recordFile of await walkRecords(batchPath)) {
      try {
        rows.push({ batch, record: JSON.parse(await readFile(recordFile, 'utf8')) as CaseRecord })
      } catch (err) {
        console.error(`解析失败 ${recordFile}:`, err)
      }
    }
  }
  return rows
}

async function main(): Promise<void> {
  const rows = (await collect()).sort((a, b) => a.record.id.localeCompare(b.record.id))
  const counts: Record<string, Record<string, number>> = {}
  for (const { record } of rows) {
    counts[record.mode] ??= {}
    counts[record.mode]![record.status] = (counts[record.mode]![record.status] ?? 0) + 1
  }

  const lines: string[] = []
  lines.push('# 验收执行记录（自动化轮次）')
  lines.push('')
  lines.push(`生成时间：${new Date().toISOString()}；执行者：自动化验收（GitHub Actions）。`)
  lines.push('')
  lines.push('## 统计')
  lines.push('')
  lines.push('| 模式 | 通过 | 失败 | 阻塞 | 限制已确认 |')
  lines.push('|---|---|---|---|---|')
  for (const mode of ['M', 'R', 'I']) {
    const c = counts[mode] ?? {}
    lines.push(`| ${mode} | ${c['通过'] ?? 0} | ${c['失败'] ?? 0} | ${c['阻塞'] ?? 0} | ${c['限制已确认'] ?? 0} |`)
  }
  lines.push('')
  lines.push('## 用例结果')
  lines.push('')
  lines.push('| 用例 | 变体 | 模式 | 结果 | 关键结果 | 证据 |')
  lines.push('|---|---|---|---|---|---|')
  for (const { batch, record } of rows) {
    const failedChecks = record.checks.filter((check) => !check.pass)
    const key = record.status === '通过'
      ? (record.checks[0]?.detail ?? record.actual).slice(0, 80)
      : failedChecks.length > 0
        ? `未过: ${failedChecks.map((check) => `${check.name}(${check.detail.slice(0, 60)})`).join('；')}`.slice(0, 160)
        : (record.blockedReason ?? record.actual).slice(0, 100)
    const evidence = record.evidence.length > 0 ? record.evidence[0] : ''
    lines.push(`| ${record.id} | ${record.variant || '-'} | ${record.mode} | ${record.status} | ${key.replace(/\|/g, '/')} | ${evidence} |`)
  }
  lines.push('')
  lines.push('## 缺陷与差距（自动化轮次观察到的）')
  lines.push('')
  let defectIndex = 0
  for (const { batch, record } of rows) {
    for (const defect of record.defects) {
      defectIndex++
      lines.push(`${defectIndex}. [${record.id}${record.variant ? `/${record.variant}` : ''}（${record.mode}，批次 ${batch}，${record.status}）] ${defect}`)
    }
  }
  if (defectIndex === 0) lines.push('（本轮自动化执行未记录到缺陷）')
  lines.push('')

  const outPath = path.join(acceptanceRoot, 'records.md')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(outPath, lines.join('\n'), 'utf8')
  console.log(`已生成 ${outPath}`)
  console.log(`用例记录共 ${rows.length} 条`)
  for (const [mode, c] of Object.entries(counts)) {
    console.log(`  ${mode}: ${JSON.stringify(c)}`)
  }
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
