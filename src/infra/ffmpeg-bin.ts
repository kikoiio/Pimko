import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * ffmpeg/ffprobe 二进制解析。
 * 优先级:打包产物的随包二进制(extraResources/bin,用户无需装 ffmpeg)
 * → 开发态 node_modules 的静态包 → 系统 PATH。
 */

function exeName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function packagedBin(name: string): string | undefined {
  if (!process.resourcesPath) return undefined
  const candidate = path.join(process.resourcesPath, 'bin', exeName(name))
  return existsSync(candidate) ? candidate : undefined
}

function localBin(relative: string): string | undefined {
  const candidate = path.join(process.cwd(), relative)
  return existsSync(candidate) ? candidate : undefined
}

export function resolveFfmpeg(): string {
  return (
    packagedBin('ffmpeg')
    ?? localBin(path.join('node_modules', 'ffmpeg-static', exeName('ffmpeg')))
    ?? 'ffmpeg'
  )
}

export function resolveFfprobe(): string {
  return packagedBin('ffprobe') ?? 'ffprobe'
}
