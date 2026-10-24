import type { EditingIntelligence } from '../ports/intelligence'
import type { Transcriber } from '../ports/transcriber'
import type { LlmConfig } from './llm-config'
import { MockIntelligence } from './mock-intelligence'
import { MockTranscriber } from './mock-transcriber'
import { OpenAiIntelligence } from './openai-intelligence'
import { OpenAiTranscriber } from './openai-transcriber'
import { OpenRouterTranscriber } from './openrouter-transcriber'

export function createTranscriber(config: LlmConfig): Transcriber {
  const baseUrl = config.transcribeBaseUrl ?? config.baseUrl ?? ''
  if (baseUrl.includes('openrouter.ai')) return new OpenRouterTranscriber(config)
  return config.provider === 'openai' ? new OpenAiTranscriber(config) : new MockTranscriber()
}

export function createIntelligence(config: LlmConfig): EditingIntelligence {
  if (config.provider === 'openai') return new OpenAiIntelligence(config)
  if (config.provider === 'mock') return new MockIntelligence()
  throw new Error('anthropic 适配器尚未实现；当前请使用 PIMKO_LLM_PROVIDER=mock 或 openai')
}
