import { appendFileSync, existsSync, mkdirSync, rmSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

type Level = 'info' | 'warn' | 'error'

const MAX_BYTES = 5 * 1024 * 1024
const SECRET_KEY = /api[-_]?key|authorization|token|secret|password|cookie/i
let logFile: string | undefined

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]'
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? '***' : sanitize(item, depth + 1),
    ]))
  }
  if (typeof value === 'string' && value.length > 1000) return `${value.slice(0, 1000)}…`
  return value
}

function rotate(): void {
  if (!logFile || !existsSync(logFile)) return
  try {
    if (statSync(logFile).size < MAX_BYTES) return
    const previous = `${logFile}.1`
    if (existsSync(previous)) rmSync(previous, { force: true })
    renameSync(logFile, previous)
  } catch {
    // 日志失败不能影响主流程
  }
}

export function initLogger(dir: string): string {
  mkdirSync(dir, { recursive: true })
  logFile = path.join(dir, 'pimko.log')
  rotate()
  log('info', 'logger', 'log started', { file: logFile })
  return logFile
}

export function currentLogFile(): string | undefined {
  return logFile
}

export function log(level: Level, scope: string, message: string, detail?: unknown): void {
  if (!logFile) return
  rotate()
  const suffix = detail === undefined ? '' : ` ${JSON.stringify(sanitize(detail))}`
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} [${scope}] ${message}${suffix}\n`
  try {
    appendFileSync(logFile, line, 'utf8')
  } catch {
    // 日志失败不能影响主流程
  }
}

export function logError(scope: string, message: string, error: unknown, detail?: unknown): void {
  const info = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) }
  log('error', scope, message, { ...(detail && typeof detail === 'object' ? detail : {}), error: info })
}
