import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type LlmProvider = 'mock' | 'openai' | 'anthropic'
export type LlmApiStyle = 'chat' | 'responses'

export interface LlmConfig {
  provider: LlmProvider
  apiKey?: string
  model?: string
  transcribeModel?: string
  transcribeApiKey?: string
  baseUrl?: string
  transcribeBaseUrl?: string
  /** OpenAI chat/completions 或 Responses API；由 provider profile 决定。 */
  apiStyle?: LlmApiStyle
  timeoutMs?: number
  /** 诊断用：当前使用的 providers.json profile 名称，不代表厂商。 */
  profileName?: string
}

export interface ProviderProfile {
  /** openai-chat（默认）或 openai-responses；只描述协议，不绑定厂商。 */
  protocol?: 'openai-chat' | 'openai-responses'
  baseUrl: string
  model: string
  /** 直接写 key 或引用环境变量；两者都支持，环境变量优先。 */
  apiKey?: string
  apiKeyEnv?: string
  timeoutMs?: number
  transcription?: {
    baseUrl?: string
    model?: string
    apiKey?: string
    apiKeyEnv?: string
  }
}

export interface ProvidersFile {
  active?: string
  providers: Record<string, ProviderProfile>
}

export function resolveProvidersFile(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PIMKO_DISABLE_PROVIDERS === '1') return undefined
  const explicit = env.PIMKO_PROVIDERS_FILE?.trim()
  if (explicit) {
    const resolved = path.resolve(explicit)
    if (!existsSync(resolved)) throw new Error(`PIMKO_PROVIDERS_FILE 指向的文件不存在: ${resolved}`)
    return resolved
  }
  const local = path.join(process.cwd(), 'providers.json')
  if (existsSync(local)) return local
  const user = path.join(homedir(), '.config', 'pimko', 'providers.json')
  return existsSync(user) ? user : undefined
}

export function readProvidersFile(file: string): ProvidersFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`无法解析 providers.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('providers.json 顶层必须是对象。')
  }
  const data = parsed as ProvidersFile
  if (data.providers == null || typeof data.providers !== 'object' || Array.isArray(data.providers)) {
    throw new Error('providers.json 缺少 providers 对象。')
  }
  return data
}

function keyFor(profile: ProviderProfile, env: NodeJS.ProcessEnv, fallback: string | undefined): string | undefined {
  if (profile.apiKeyEnv) return env[profile.apiKeyEnv] || fallback
  return profile.apiKey || fallback
}

function profileConfig(profile: ProviderProfile, name: string, env: NodeJS.ProcessEnv): LlmConfig {
  const protocol = profile.protocol ?? 'openai-chat'
  if (protocol !== 'openai-chat' && protocol !== 'openai-responses') {
    throw new Error(`provider ${name} 的 protocol 只能是 openai-chat 或 openai-responses。`)
  }
  if (!profile.baseUrl || !profile.model) {
    throw new Error(`provider ${name} 必须配置 baseUrl 和 model。`)
  }
  const apiKey = keyFor(profile, env, env.PIMKO_LLM_API_KEY)
  if (!apiKey) throw new Error(`provider ${name} 缺少 API key：设置 ${profile.apiKeyEnv ?? 'apiKey'} 或 PIMKO_LLM_API_KEY。`)
  const transcription = profile.transcription
  return {
    provider: 'openai',
    apiKey,
    model: profile.model,
    baseUrl: profile.baseUrl,
    apiStyle: protocol === 'openai-responses' ? 'responses' : 'chat',
    profileName: name,
    ...(profile.timeoutMs ? { timeoutMs: profile.timeoutMs } : {}),
    transcribeBaseUrl: transcription?.baseUrl ?? env.PIMKO_TRANSCRIBE_BASE_URL ?? profile.baseUrl,
    transcribeModel: transcription?.model ?? env.PIMKO_TRANSCRIBE_MODEL,
    transcribeApiKey: transcription
      ? keyFor(transcription as ProviderProfile, env, env.PIMKO_TRANSCRIBE_API_KEY) ?? apiKey
      : env.PIMKO_TRANSCRIBE_API_KEY ?? apiKey,
  }
}

function legacyConfig(env: NodeJS.ProcessEnv): LlmConfig {
  const provider = (env.PIMKO_LLM_PROVIDER ?? 'mock') as LlmProvider
  if (!['mock', 'openai', 'anthropic'].includes(provider)) {
    throw new Error(`未知的 PIMKO_LLM_PROVIDER: ${provider}`)
  }
  const baseUrl = env.PIMKO_LLM_BASE_URL || undefined
  const apiStyle = env.PIMKO_LLM_API_STYLE === 'openai-responses' || env.PIMKO_LLM_API_STYLE === 'responses'
    ? 'responses'
    : env.PIMKO_LLM_API_STYLE === 'openai-chat' || env.PIMKO_LLM_API_STYLE === 'chat'
      ? 'chat'
      : baseUrl?.replace(/\/+$/, '').endsWith('/responses') ? 'responses' : 'chat'
  const timeout = Number(env.PIMKO_LLM_TIMEOUT_MS)
  const config: LlmConfig = {
    provider,
    apiKey: env.PIMKO_LLM_API_KEY || undefined,
    model: env.PIMKO_LLM_MODEL || undefined,
    transcribeModel: env.PIMKO_TRANSCRIBE_MODEL || undefined,
    transcribeApiKey: env.PIMKO_TRANSCRIBE_API_KEY || undefined,
    baseUrl,
    transcribeBaseUrl: env.PIMKO_TRANSCRIBE_BASE_URL || undefined,
    apiStyle,
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  }
  if (provider !== 'mock' && !config.apiKey) {
    throw new Error(`使用 ${provider} 时必须设置 PIMKO_LLM_API_KEY，或使用 providers.json。`)
  }
  return config
}

/**
 * 配置优先级：
 * 1. providers.json + PIMKO_LLM_PROFILE（多服务；provider 只是协议，不绑定厂商）
 * 2. 旧版 PIMKO_LLM_* 单服务环境变量
 * 3. mock
 */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const file = resolveProvidersFile(env)
  if (!file) return legacyConfig(env)
  const data = readProvidersFile(file)
  const name = env.PIMKO_LLM_PROFILE?.trim() || data.active
  if (!name) throw new Error('providers.json 需要设置 active，或设置 PIMKO_LLM_PROFILE。')
  const profile = data.providers[name]
  if (!profile) throw new Error(`providers.json 中找不到 provider: ${name}`)
  return profileConfig(profile, name, env)
}
