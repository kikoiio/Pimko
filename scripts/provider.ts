import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadDotEnv } from '../src/infra/env'
import { readProvidersFile, resolveProvidersFile } from '../src/infra/llm-config'

function usage(): string {
  return `用法:
  npm run provider -- list
  npm run provider -- use <name>
  npm run provider -- path

配置文件默认依次查找 PIMKO_PROVIDERS_FILE、./providers.json、~/.config/pimko/providers.json。`
}

async function main(): Promise<void> {
  await loadDotEnv()
  const command = process.argv[2] ?? 'list'
  const file = resolveProvidersFile(process.env)
  if (!file) throw new Error('找不到 providers.json；先复制 providers.example.json 并填写。')
  const data = readProvidersFile(file)
  if (command === 'path') {
    console.log(file)
    return
  }
  if (command === 'list') {
    console.log(`配置文件: ${file}`)
    console.log(`active: ${data.active ?? '(未设置)'}`)
    for (const [name, profile] of Object.entries(data.providers)) {
      const marker = name === data.active ? '*' : ' '
      console.log(`${marker} ${name}: ${profile.protocol ?? 'openai-chat'} · ${profile.model} · ${profile.baseUrl}`)
    }
    return
  }
  if (command === 'use') {
    const name = process.argv[3]
    if (!name || !data.providers[name]) throw new Error(`未知 provider: ${name ?? '(空)'}`)
    data.active = name
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    console.log(`active -> ${name} (${path.basename(file)})`)
    return
  }
  throw new Error(usage())
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
