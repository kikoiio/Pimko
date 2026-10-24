export type LlmProvider = 'mock' | 'openai' | 'anthropic'

export interface LlmConfig {
  provider: LlmProvider
  apiKey?: string
  model?: string
  transcribeModel?: string
  transcribeApiKey?: string
  baseUrl?: string
  transcribeBaseUrl?: string
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
    transcribeModel: env.PIMKO_TRANSCRIBE_MODEL || undefined,
    transcribeApiKey: env.PIMKO_TRANSCRIBE_API_KEY || undefined,
    baseUrl: env.PIMKO_LLM_BASE_URL || undefined,
    transcribeBaseUrl: env.PIMKO_TRANSCRIBE_BASE_URL || undefined,
  }
  if (provider !== 'mock' && !config.apiKey) {
    throw new Error(`使用 ${provider} 时必须设置 PIMKO_LLM_API_KEY`)
  }
  return config
}
