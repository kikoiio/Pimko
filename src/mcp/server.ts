import { createInterface } from 'node:readline'

/**
 * 极简 MCP stdio 服务器：JSON-RPC 2.0 子集（initialize / tools/list / tools/call）。
 * 不引入 SDK——工具面只有几个动词，协议层手写更可控；日志一律走 stderr。
 */

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

export function runMcpServer(tools: ToolDefinition[], serverInfo: { name: string; version: string }): void {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))

  function send(payload: unknown): void {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  }

  function reply(id: number | string, result: unknown): void {
    send({ jsonrpc: '2.0', id, result })
  }

  function replyError(id: number | string, code: number, message: string): void {
    send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  async function dispatch(request: JsonRpcRequest): Promise<unknown> {
    if (request.method === 'initialize') {
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo,
      }
    }
    if (request.method === 'tools/list') {
      return {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      }
    }
    if (request.method === 'tools/call') {
      const name = String(request.params?.name ?? '')
      const tool = toolsByName.get(name)
      if (!tool) throw new RpcError(-32602, `未知工具: ${name}`)
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await tool.handler(args)) }] }
      } catch (err) {
        // 工具内错误按 MCP 语义返回 isError，不炸掉整个会话。
        const message = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: message }], isError: true }
      }
    }
    throw new RpcError(-32601, `未知方法: ${request.method}`)
  }

  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let request: JsonRpcRequest
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      process.stderr.write(`非 JSON 输入: ${trimmed.slice(0, 120)}\n`)
      return
    }
    if (request.id === undefined) return // notification（如 initialized），无需应答
    dispatch(request)
      .then((result) => reply(request.id!, result))
      .catch((err) => {
        const code = err instanceof RpcError ? err.code : -32000
        const message = err instanceof Error ? err.message : String(err)
        replyError(request.id!, code, message)
      })
  })
}

class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message)
  }
}
