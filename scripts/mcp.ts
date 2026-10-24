import { homedir } from 'node:os'
import path from 'node:path'
import { Editor } from '../src/services/editor'
import { FfmpegProber } from '../src/infra/ffmpeg-prober'
import { FfmpegRenderer } from '../src/infra/ffmpeg-renderer'
import { FfmpegSilenceAnalyzer } from '../src/infra/ffmpeg-silence-analyzer'
import { FsProjectStore } from '../src/infra/fs-store'
import { createIntelligence, createTranscriber } from '../src/infra/ai-factory'
import { loadDotEnv } from '../src/infra/env'
import { loadLlmConfig } from '../src/infra/llm-config'
import { runMcpServer, type ToolDefinition } from '../src/mcp/server'
import type { ProjectRevision } from '../src/domain/project'

/**
 * Pimko MCP 入口：把 Editor 的动词暴露为 MCP 工具，供 Claude Code 等外部 agent 驱动。
 * 与 GUI 共用同一 Editor 命令层；默认数据目录对齐 Electron 的 userData。
 */

function revisionSummary(revision: ProjectRevision): Record<string, unknown> {
  const clips = revision.project.timeline.clips.map((clip, index) => ({
    index: index + 1,
    startSec: Number(clip.sourceStartSec.toFixed(2)),
    endSec: Number(clip.sourceEndSec.toFixed(2)),
    ...(clip.speed !== undefined ? { speed: clip.speed } : {}),
  }))
  const durationSec = revision.project.timeline.clips.reduce(
    (sum, clip) => sum + (clip.sourceEndSec - clip.sourceStartSec) / (clip.speed ?? 1),
    0,
  )
  return {
    projectId: revision.project.id,
    revisionId: revision.id,
    name: revision.project.name,
    clipCount: clips.length,
    durationSec: Number(durationSec.toFixed(2)),
    clips,
    transcriptSegments: revision.project.transcript?.segments.length ?? 0,
    silences: revision.project.silences?.length ?? 0,
    agentNote: revision.agentNote,
    ...(revision.diff ? { diff: revision.diff } : {}),
  }
}

async function main(): Promise<void> {
  await loadDotEnv()
  const config = loadLlmConfig()
  // 对齐 Electron 在 Linux 的 userData 默认路径；可用 PIMKO_DATA_DIR 覆盖。
  const dataDir = process.env.PIMKO_DATA_DIR ?? path.join(homedir(), '.config', 'pimko')
  const editor = new Editor({
    prober: new FfmpegProber(),
    transcriber: createTranscriber(config),
    intelligence: createIntelligence(config),
    renderer: new FfmpegRenderer(),
    store: new FsProjectStore(path.join(dataDir, 'projects')),
    silenceAnalyzer: new FfmpegSilenceAnalyzer(),
  })

  const tools: ToolDefinition[] = [
    {
      name: 'list_projects',
      description: '列出最近的 Pimko 项目（projectId、名称、片段数、时长）。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const revisions = await editor.listProjects()
        return revisions.map((revision) => ({
          projectId: revision.project.id,
          name: revision.project.name,
          clipCount: revision.project.timeline.clips.length,
          updatedAt: revision.createdAt,
        }))
      },
    },
    {
      name: 'create_draft',
      description: '导入口播视频并生成第一版剪辑草稿（转写 + 静音分析 + LLM 剪辑决策）。',
      inputSchema: {
        type: 'object',
        properties: {
          videoPath: { type: 'string', description: '视频文件绝对路径' },
          name: { type: 'string', description: '项目名（可选）' },
        },
        required: ['videoPath'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const revision = await editor.createDraft(String(args.videoPath), args.name ? String(args.name) : undefined)
        return revisionSummary(revision)
      },
    },
    {
      name: 'revise',
      description: '用一句中文反馈修订项目时间线（选段/重排/变速/停顿/口癖），产出新修订。',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          feedback: { type: 'string', description: '中文反馈，例如"开头太拖，直接进正题"' },
        },
        required: ['projectId', 'feedback'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const revision = await editor.revise(String(args.projectId), { text: String(args.feedback) })
        return revisionSummary(revision)
      },
    },
    {
      name: 'undo',
      description: '撤销最近一次修改,回退到上一版时间线(作为新修订入链,可连续撤销)。',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' } },
        required: ['projectId'],
        additionalProperties: false,
      },
      handler: async (args) => revisionSummary(await editor.undo(String(args.projectId))),
    },
    {
      name: 'set_bgm_volume',
      description: '调整配乐音量(dB,建议 -24/-18/-12 三档,范围 -40–0)。',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          gainDb: { type: 'number' },
        },
        required: ['projectId', 'gainDb'],
        additionalProperties: false,
      },
      handler: async (args) => revisionSummary(await editor.setBgmVolume(String(args.projectId), Number(args.gainDb))),
    },
    {
      name: 'get_timeline',
      description: '读取项目最新时间线（片段、字幕、静音图），供检查与决策。',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' } },
        required: ['projectId'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const revision = await editor.restore(String(args.projectId))
        if (!revision) throw new Error(`项目不存在: ${String(args.projectId)}`)
        return revisionSummary(revision)
      },
    },
    {
      name: 'export',
      description: '导出项目为 MP4 成片（剪辑 + 变速 + 字幕 + 可选 BGM）。',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          outputPath: { type: 'string', description: '输出 MP4 绝对路径' },
        },
        required: ['projectId', 'outputPath'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const outputPath = await editor.export(String(args.projectId), String(args.outputPath))
        return { outputPath }
      },
    },
  ]

  runMcpServer(tools, { name: 'pimko', version: '0.1.0' })
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
