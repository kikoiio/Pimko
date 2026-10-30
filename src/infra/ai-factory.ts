import type { EditingIntelligence } from '../ports/intelligence'
import type { Planner } from '../ports/planner'
import type { Transcriber } from '../ports/transcriber'
import type { LlmConfig } from './llm-config'
import { MockIntelligence } from './mock-intelligence'
import { MockPlanner } from './mock-planner'
import { MockTranscriber } from './mock-transcriber'
import { OpenAiIntelligence } from './openai-intelligence'
import { OpenAiPlanner } from './openai-planner'
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

/** 补丁 planner：mock 保持确定性行为；openai/openrouter 走真实模型，但只产出 ops。 */
export function createPlanner(config: LlmConfig): Planner {
  if (config.provider === 'mock') return new MockPlanner()
  if (config.provider === 'openai') return new OpenAiPlanner(config)
  throw new Error('anthropic 适配器尚未实现；当前请使用 PIMKO_LLM_PROVIDER=mock 或 openai')
}
