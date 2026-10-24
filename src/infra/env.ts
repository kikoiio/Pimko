import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** 极简 .env 加载：不覆盖已有环境变量，够用且零依赖。 */
export async function loadDotEnv(filePath = path.join(process.cwd(), '.env')): Promise<void> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}
