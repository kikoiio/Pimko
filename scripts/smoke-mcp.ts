import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * MCP 冒烟：以外部客户端身份通过 stdio JSON-RPC 驱动 Pimko 引擎，
 * 完成 initialize → tools/list → create_draft → revise → export 闭环。
 */

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pimko-mcp-smoke-'))
  const child = spawn('npx', ['tsx', 'scripts/mcp.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PIMKO_LLM_PROVIDER: 'mock', PIMKO_DATA_DIR: workDir },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const pending = new Map<number, Pending>()
  let nextId = 0
  let buffer = ''

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } }
      if (message.id === undefined) continue
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    }
  })

  function request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++nextId
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }

  function notify(method: string): void {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await request('tools/call', { name, arguments: args })) as {
      content: { type: string; text: string }[]
      isError?: boolean
    }
    const text = result.content[0]?.text ?? ''
    if (result.isError) throw new Error(`工具 ${name} 失败: ${text}`)
    return JSON.parse(text)
  }

  try {
    const inputPath = path.join(workDir, 'input.mp4')
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      inputPath,
    ])

    const init = (await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pimko-smoke', version: '0.0.0' },
    })) as { serverInfo?: { name?: string } }
    if (init.serverInfo?.name !== 'pimko') throw new Error(`initialize 失败: ${JSON.stringify(init)}`)
    notify('notifications/initialized')

    const list = (await request('tools/list')) as { tools: { name: string }[] }
    const names = list.tools.map((tool) => tool.name)
    for (const expected of ['list_projects', 'create_draft', 'revise', 'get_timeline', 'export']) {
      if (!names.includes(expected)) throw new Error(`tools/list 缺少 ${expected}: ${names.join(', ')}`)
    }

    const draft = (await callTool('create_draft', { videoPath: inputPath, name: 'mcp-smoke' })) as {
      projectId: string
      clipCount: number
    }
    if (draft.clipCount < 1) throw new Error(`create_draft 无片段: ${JSON.stringify(draft)}`)

    const revised = (await callTool('revise', { projectId: draft.projectId, feedback: '开头太拖' })) as {
      revisionId: string
      agentNote?: string
    }
    if (!revised.revisionId) throw new Error('revise 未返回修订')

    const outputPath = path.join(workDir, 'output.mp4')
    await callTool('export', { projectId: draft.projectId, outputPath })
    const info = await stat(outputPath)
    if (info.size <= 0) throw new Error('导出文件为空')
    console.log(`mcp smoke ok: ${outputPath} (${info.size} bytes)`)
  } finally {
    child.stdin.end()
    child.kill('SIGTERM')
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
