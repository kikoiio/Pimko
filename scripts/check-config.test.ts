import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadLlmConfig } from '../src/infra/llm-config'

async function withProvidersFile(
  data: unknown,
  run: (file: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'pimko-config-'))
  try {
    const file = path.join(root, 'providers.json')
    await writeFile(file, JSON.stringify(data), 'utf8')
    await run(file)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

void test('providers.json：任意 OpenAI-compatible chat/responses profile，不绑定厂商', async () => {
  await withProvidersFile({
    active: 'xunfei',
    providers: {
      xunfei: {
        protocol: 'openai-responses',
        baseUrl: 'https://example.invalid/v1',
        model: 'spark-x2.6',
        apiKeyEnv: 'XKEY',
        timeoutMs: 600000,
        transcription: {
          baseUrl: 'https://transcribe.invalid/v1',
          model: 'whisper-large-v3',
          apiKeyEnv: 'TKEY',
        },
      },
      groq: {
        protocol: 'openai-chat',
        baseUrl: 'https://groq.invalid/openai/v1',
        model: 'openai/gpt-oss-120b',
        apiKeyEnv: 'GKEY',
      },
    },
  }, async (file) => {
    const config = loadLlmConfig({
      PIMKO_PROVIDERS_FILE: file,
      XKEY: 'llm-key',
      TKEY: 'transcribe-key',
    })
    assert.equal(config.provider, 'openai')
    assert.equal(config.apiStyle, 'responses')
    assert.equal(config.model, 'spark-x2.6')
    assert.equal(config.apiKey, 'llm-key')
    assert.equal(config.timeoutMs, 600000)
    assert.equal(config.transcribeBaseUrl, 'https://transcribe.invalid/v1')
    assert.equal(config.transcribeModel, 'whisper-large-v3')
    assert.equal(config.transcribeApiKey, 'transcribe-key')
    assert.equal(config.profileName, 'xunfei')

    const groq = loadLlmConfig({
      PIMKO_PROVIDERS_FILE: file,
      PIMKO_LLM_PROFILE: 'groq',
      GKEY: 'groq-key',
    })
    assert.equal(groq.apiStyle, 'chat')
    assert.equal(groq.model, 'openai/gpt-oss-120b')
    assert.equal(groq.apiKey, 'groq-key')
  })
})

void test('providers.json：缺少 active/profile 或 key 时给出明确错误', async () => {
  await withProvidersFile({ providers: {} }, async (file) => {
    assert.throws(() => loadLlmConfig({ PIMKO_PROVIDERS_FILE: file }), /active|profile/i)
  })
  await withProvidersFile({
    active: 'x',
    providers: { x: { baseUrl: 'https://x.invalid/v1', model: 'm', apiKeyEnv: 'MISSING' } },
  }, async (file) => {
    assert.throws(() => loadLlmConfig({ PIMKO_PROVIDERS_FILE: file }), /API key/)
  })
})

void test('旧版单服务 env 仍兼容：chat/responses 由 base URL/style 决定', () => {
  const chat = loadLlmConfig({
    PIMKO_LLM_PROVIDER: 'openai',
    PIMKO_LLM_API_KEY: 'key',
    PIMKO_LLM_MODEL: 'model',
    PIMKO_LLM_BASE_URL: 'https://groq.invalid/openai/v1',
  })
  assert.equal(chat.apiStyle, 'chat')
  assert.equal(chat.provider, 'openai')
  const responses = loadLlmConfig({
    PIMKO_LLM_PROVIDER: 'openai',
    PIMKO_LLM_API_KEY: 'key',
    PIMKO_LLM_MODEL: 'model',
    PIMKO_LLM_BASE_URL: 'https://example.invalid/v1/responses',
  })
  assert.equal(responses.apiStyle, 'responses')
  const explicit = loadLlmConfig({
    PIMKO_LLM_PROVIDER: 'openai',
    PIMKO_LLM_API_KEY: 'key',
    PIMKO_LLM_MODEL: 'model',
    PIMKO_LLM_BASE_URL: 'https://example.invalid/v1',
    PIMKO_LLM_API_STYLE: 'openai-responses',
  })
  assert.equal(explicit.apiStyle, 'responses')
})

void test('单个 provider 文件即可运行；apiKey 也可直接写在 profile 里', async () => {
  await withProvidersFile({
    active: 'only',
    providers: {
      only: { baseUrl: 'https://only.invalid/v1', model: 'only-model', apiKey: 'literal-key' },
    },
  }, async (file) => {
    const config = loadLlmConfig({ PIMKO_PROVIDERS_FILE: file })
    assert.equal(config.model, 'only-model')
    assert.equal(config.apiKey, 'literal-key')
    assert.equal(config.apiStyle, 'chat')
    assert.equal(config.profileName, 'only')
  })
})
