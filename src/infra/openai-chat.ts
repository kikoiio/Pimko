import type { LlmConfig } from './llm-config'

/**
 * OpenAI 兼容 chat/completions 的结构化输出请求。
 * 429 限流与“端点不支持 response_format”都不算模型答错：前者按 Retry-After 等待，
 * 后者去掉结构化参数重试；只有返回 200 但 JSON 无法解析才消耗一次结构尝试。
 */

/** 从模型输出里取第一个完整的 JSON 对象：兼容 ```json 围栏、前后解释文字。 */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

export interface JsonCompletionRequest<T> {
  system: string
  user: string
  /** 返回 null 表示这份输出不可用，会消耗一次结构尝试并重新请求。 */
  parse: (content: string) => T | null
}

export interface JsonCompletionOptions {
  /** 结构尝试次数（含 JSON 解析失败）；限流/降级重试不计入。默认 3。 */
  structureAttempts?: number
  /** 429 最多重试次数。默认 2。 */
  rateRetries?: number
  /** 网络瞬断重试次数。默认 2。 */
  networkRetries?: number
  /** 测试注入：替换真实等待，避免限流重试拖慢离线回归。 */
  sleep?: (ms: number) => Promise<void>
  /** 单次 HTTP 请求超时（毫秒）。默认 300s（讯飞长响应可能超过 2 分钟）。 */
  timeoutMs?: number
}

function redact(text: string, key: string | undefined): string {
  if (!key) return text
  return text.split(key).join('***')
}

function providerLabel(config: LlmConfig): string {
  const name = config.profileName ? `provider "${config.profileName}"` : '模型服务'
  const protocol = config.apiStyle === 'responses' ? 'Responses API' : 'Chat Completions'
  const model = config.model ?? 'model 未配置'
  const baseUrl = config.baseUrl ?? 'baseUrl 未配置'
  return `${name}（${model}，${protocol}，${baseUrl}）`
}

function httpFailure(status: number, detail: string, config: LlmConfig): Error {
  const label = providerLabel(config)
  const clean = redact(detail.trim(), config.apiKey)
  const tail = clean ? `\n${clean.slice(0, 500)}${clean.length > 500 ? '…' : ''}` : ''
  if (status === 401 || status === 403) {
    return new Error(`${label} 鉴权失败（HTTP ${status}）：检查 apiKey 是否正确、是否有该模型权限。${tail}`)
  }
  if (status === 404) {
    return new Error(`${label} 地址或协议不匹配（HTTP 404）：检查 baseUrl；Chat 需要 /chat/completions，Responses 需要 /responses，或在 profile 设置 protocol。${tail}`)
  }
  if (status === 400) {
    return new Error(`${label} 拒绝了请求（HTTP 400）：检查 model 名称、protocol 和请求参数。${tail}`)
  }
  if (status === 429) {
    return new Error(`${label} 被限流（HTTP 429）：稍后重试，或提高服务额度。${tail}`)
  }
  if (status >= 500) {
    return new Error(`${label} 暂时不可用（HTTP ${status}）：稍后重试。${tail}`)
  }
  return new Error(`${label} 请求失败（HTTP ${status}）：${tail || '检查服务配置。'}`)
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[]
  /** OpenAI Responses API（讯飞 MaaS 等） */
  output_text?: string
  output?: { content?: { type?: string; text?: string }[] }[]
}

export async function requestJsonCompletion<T>(
  config: LlmConfig,
  request: JsonCompletionRequest<T>,
  options: JsonCompletionOptions = {},
): Promise<T | null> {
  const rawBaseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  const isResponses = config.apiStyle === 'responses' || /\/responses$/i.test(rawBaseUrl)
  const baseUrl = rawBaseUrl
  const endpoint = isResponses
    ? (/\/responses$/i.test(baseUrl) ? baseUrl : `${baseUrl}/responses`)
    : (/\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`)
  const body: Record<string, unknown> = isResponses
    ? {
        model: config.model ?? 'gpt-4o-mini',
        input: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }
    : {
        model: config.model ?? 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }
  // OpenRouter 的结构化输出按端点"尽力而为"；该参数只把请求路由到强制 schema 的端点。
  // 部分免费模型不支持 response_format，命中时在下面自动降级。
  const isOpenRouter = !isResponses && baseUrl.includes('openrouter.ai')
  if (isOpenRouter) body.provider = { require_parameters: true }

  const maxStructureAttempts = Math.max(1, options.structureAttempts ?? 3)
  const maxRateRetries = Math.max(0, options.rateRetries ?? 2)
  const maxNetworkRetries = Math.max(0, options.networkRetries ?? 2)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const configuredTimeout = Number(process.env.PIMKO_LLM_TIMEOUT_MS)
  const timeoutMs = Math.max(1000, options.timeoutMs ?? config.timeoutMs ?? (Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 300_000))
  let structureAttempts = 0
  let rateRetries = 0
  let networkRetries = 0
  let relaxed = !isOpenRouter
  let retried422 = false
  let retriedJsonValidation = false

  while (structureAttempts < maxStructureAttempts) {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      if (!timedOut && networkRetries < maxNetworkRetries) {
        networkRetries++
        await sleep(5000 * networkRetries)
        continue
      }
      const label = providerLabel(config)
      if (timedOut) {
        throw new Error(`${label} 响应超时（${Math.round(timeoutMs / 1000)}s）：检查网络，或在 providers.json 调大 timeoutMs。`)
      }
      throw new Error(`${label} 无法连接：${redact(message, config.apiKey)}。检查 baseUrl、网络和代理。`)
    }
    if (!response.ok) {
      const detail = await response.text()
      // 免费模型常被限流：按 Retry-After 等一会儿再试，别立刻把错误抛给用户。
      if (response.status === 429 && rateRetries < maxRateRetries) {
        rateRetries++
        const retryAfter = Number(response.headers.get('retry-after'))
        const waitMs = Math.min(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 4000 * rateRetries,
          20000,
        )
        await sleep(waitMs)
        continue
      }
      // 422 常见于网关/模型不接受 response_format（与 base URL 无关），降级重试一次；
      // 400/404 仅在 OpenRouter 明确提示结构化输出不可用时降级，避免把鉴权/请求错误当成可重试。
      // Groq 等端点会在 response_format 已开启但模型没生成合法 JSON 时返回 400
      // json_validate_failed；这不是鉴权/请求错误，去掉结构化参数再给一次机会。
      const jsonValidationFailure =
        response.status === 400 &&
        !retriedJsonValidation &&
        /json_validate_failed|Failed to generate JSON/i.test(detail)
      if (jsonValidationFailure) {
        retriedJsonValidation = true
        relaxed = true
        delete body.provider
        delete body.response_format
        continue
      }
      const unsupported =
        (response.status === 422 && !retried422) ||
        (!relaxed &&
          isOpenRouter &&
          (response.status === 400 || response.status === 404) &&
          /response_format|structured|require_parameters|No endpoints found/i.test(detail))
      if (unsupported) {
        relaxed = true
        if (response.status === 422) retried422 = true
        delete body.provider
        delete body.response_format
        continue
      }
      throw httpFailure(response.status, detail, config)
    }
    structureAttempts++
    const data = (await response.json()) as ChatCompletionResponse
    const content = data.choices?.[0]?.message?.content
      ?? data.output_text
      ?? data.output
        ?.flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? '')
        .join('')
    if (!content) continue
    const parsed = request.parse(content)
    if (parsed !== null) return parsed
  }
  return null
}
