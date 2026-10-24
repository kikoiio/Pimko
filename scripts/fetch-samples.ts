import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveFfmpeg, resolveFfprobe } from '../src/infra/ffmpeg-bin'

const execFileAsync = promisify(execFile)

/**
 * 下载公开授权素材到 sample-assets/public/（不入库）。
 * 每个条目记录来源、作者与许可证，并做尺寸/时长/哈希校验。
 */

interface SampleSpec {
  id: string
  url: string
  /** 原始文件名（缓存用）。 */
  cacheName: string
  /** 最终产物（可能经过裁剪/合流）。 */
  outputName: string
  license: string
  author: string
  sourcePage: string
  description: string
  /** 仅取前 N 秒，控制体积。 */
  trimSec?: number
  /** 纯音频素材：合成测试画面后合流成 mp4。 */
  muxSize?: string
  /** 期望最终视频宽高。 */
  expectWidth: number
  expectHeight: number
}

const SAMPLES: SampleSpec[] = [
  {
    id: 'sintel-trailer',
    url: 'https://media.w3.org/2010/05/sintel/trailer.mp4',
    cacheName: 'sintel-trailer.mp4',
    outputName: 'sintel-trailer.mp4',
    license: 'CC BY 3.0',
    author: 'Blender Foundation / durian.blender.org',
    sourcePage: 'https://media.w3.org/2010/05/video/mediaevents.html',
    description: '有对白的动画预告片：真人语音近似的剪辑素材，用于转写与切点测试。',
    expectWidth: 854,
    expectHeight: 480,
  },
  {
    id: 'big-buck-bunny-10s',
    url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
    cacheName: 'bbb-10s.mp4',
    outputName: 'big-buck-bunny-10s.mp4',
    license: 'CC BY 3.0',
    author: 'Blender Foundation',
    sourcePage: 'https://test-videos.co.uk/bigbuckbunny/mp4-h264',
    description: '10 秒短片段，用于快速渲染/比例测试。',
    expectWidth: 640,
    expectHeight: 360,
  },
  {
    id: 'zh-speech',
    url: 'https://upload.wikimedia.org/wikipedia/commons/8/8f/2008TourDeTaiwan_Stage8_Speech_by_Taipei_City_Mayor_in_Chinese.ogg',
    cacheName: 'zh-speech.ogg',
    outputName: 'zh-speaking-portrait.mp4',
    license: 'CC BY-SA 4.0',
    author: 'Rico Shen (BrockF5), Wikimedia Commons',
    sourcePage:
      'https://commons.wikimedia.org/wiki/File:2008TourDeTaiwan_Stage8_Speech_by_Taipei_City_Mayor_in_Chinese.ogg',
    description: '中文演讲音频 + 合成竖屏画面：中文口播转写、竖版比例测试。',
    trimSec: 45,
    muxSize: '720x1280',
    expectWidth: 720,
    expectHeight: 1280,
  },
  {
    id: 'en-speech',
    url: 'https://upload.wikimedia.org/wikipedia/commons/3/3a/Jfk_berlin_address_high.ogg',
    cacheName: 'jfk-berlin.ogg',
    outputName: 'en-speaking.mp4',
    license: 'Public domain',
    author: 'John F. Kennedy (US Government work)',
    sourcePage: 'https://commons.wikimedia.org/wiki/File:Jfk_berlin_address_high.ogg',
    description: '公有领域英文演讲 + 合成画面：英文口播转写测试。',
    trimSec: 30,
    muxSize: '854x480',
    expectWidth: 854,
    expectHeight: 480,
  },
]

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function download(url: string, dest: string): Promise<number> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(dest, buffer)
  return buffer.length
}

async function probe(file: string): Promise<{ width?: number; height?: number; durationSec: number }> {
  const { stdout } = await execFileAsync(resolveFfprobe(), [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ])
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: { codec_type?: string; width?: number; height?: number }[]
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video')
  return {
    width: video?.width,
    height: video?.height,
    durationSec: Number(parsed.format?.duration ?? 0),
  }
}

async function buildSample(spec: SampleSpec, workDir: string, outDir: string): Promise<void> {
  const cachePath = path.join(outDir, '.cache', spec.cacheName)
  const outputPath = path.join(outDir, spec.outputName)
  const bytes = await download(spec.url, cachePath)
  console.log(`  downloaded ${(bytes / 1024 / 1024).toFixed(2)} MB`)
  const source = await probe(cachePath)

  if (spec.muxSize) {
    const duration = Math.min(spec.trimSec ?? source.durationSec, source.durationSec)
    await execFileAsync(resolveFfmpeg(), [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${spec.muxSize}:rate=30:duration=${duration}`,
      '-i', cachePath,
      '-map', '0:v', '-map', '1:a',
      '-t', String(duration),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      outputPath,
    ])
  } else if (spec.trimSec) {
    await execFileAsync(resolveFfmpeg(), [
      '-y', '-v', 'error', '-i', cachePath, '-t', String(spec.trimSec), '-c', 'copy', outputPath,
    ])
  } else {
    await execFileAsync(resolveFfmpeg(), ['-y', '-v', 'error', '-i', cachePath, '-c', 'copy', outputPath])
  }

  const final = await probe(outputPath)
  if (final.width !== spec.expectWidth || final.height !== spec.expectHeight) {
    throw new Error(`${spec.id}: 期望 ${spec.expectWidth}x${spec.expectHeight}，实际 ${final.width}x${final.height}`)
  }
  if (!(final.durationSec > 0.5)) throw new Error(`${spec.id}: 时长异常 ${final.durationSec}`)
  const hash = createHash('sha256').update(await readFile(outputPath)).digest('hex')
  console.log(`  ok ${final.width}x${final.height} ${final.durationSec.toFixed(1)}s sha256=${hash.slice(0, 12)}`)

  spec.hash = hash
  spec.durationSec = Number(final.durationSec.toFixed(2))
}

interface SampleSpecWithProbe extends SampleSpec {
  hash?: string
  durationSec?: number
}

async function main(): Promise<void> {
  const outDir = path.resolve(__dirname, '..', 'sample-assets', 'public')
  const cacheDir = path.join(outDir, '.cache')
  await mkdir(cacheDir, { recursive: true })
  const force = process.argv.includes('--force')
  const specs = SAMPLES as SampleSpecWithProbe[]
  for (const spec of specs) {
    const outputPath = path.join(outDir, spec.outputName)
    if (!force && (await exists(outputPath))) {
      const existing = await probe(outputPath)
      console.log(`skip ${spec.id} (${existing.width}x${existing.height} ${existing.durationSec.toFixed(1)}s)`)
      spec.durationSec = Number(existing.durationSec.toFixed(2))
      continue
    }
    console.log(`fetch ${spec.id}: ${spec.url}`)
    await buildSample(spec, cacheDir, outDir)
  }
  await writeFile(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), samples: specs }, null, 2)}\n`,
  )
  console.log(`samples ready in ${outDir}`)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
