export type LlmProvider = 'mock' | 'openai' | 'anthropic'

export interface LlmConfig {
  provider: LlmProvider
  apiKey?: string
  model?: string
  baseUrl?: string
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const provider = (env.PIMKO_LLM_PROVIDER ?? 'mock') as LlmProvider
  if (!['mock', 'openai', 'anthropic'].includes(provider)) {
    throw new Error(`未知的 PIMKO_LLM_PROVIDER: ${provider}`)
  }
  const config: LlmConfig = {
    provider,
    apiKey: env.PIMKO_LLM_API_KEY || undefined,
    model: env.PIMKO_LLM_MODEL || undefined,
    baseUrl: env.PIMKO_LLM_BASE_URL || undefined,
  }
  if (provider !== 'mock' && !config.apiKey) {
    throw new Error(`使用 ${provider} 时必须设置 PIMKO_LLM_API_KEY`)
  }
  return config
}
