import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveFfmpeg, resolveFfprobe } from '../src/infra/ffmpeg-bin'

const execFileAsync = promisify(execFile)

/**
 * 生成确定性合成测试集：无需网络，覆盖尺寸/比例/音轨/停顿/边界等场景。
 * 输出 sample-assets/fixtures/ 与 manifest.json（期望值供 check-fixtures 断言）。
 */

type AudioPart = { kind: 'speech'; text: string } | { kind: 'silence'; durationSec: number }

interface FixtureSpec {
  name: string
  /** 奇数尺寸无法用 H.264/yuv420p 存储，需 FFV1/yuv444p + mkv。 */
  extension?: 'mp4' | 'mkv'
  size: string
  fps: number
  audio: AudioPart[] | 'silent' | 'none'
  expectations: {
    hasAudio: boolean
    /** 期望导出前的素材宽高（源）。 */
    sourceWidth: number
    sourceHeight: number
    minDurationSec: number
    maxDurationSec: number
    minSilences?: number
    /** 预期抛出的中文错误片段（如无音轨）。 */
    expectError?: string
  }
}

const SPEECH_PARTS: AudioPart[] = [
  { kind: 'speech', text: 'Um hello and welcome to Pimko.' },
  { kind: 'silence', durationSec: 1.2 },
  { kind: 'speech', text: 'Uh this is a test of the editing agent.' },
  { kind: 'silence', durationSec: 0.9 },
  { kind: 'speech', text: 'Today um we are going to talk about short videos.' },
  { kind: 'silence', durationSec: 1.6 },
  { kind: 'speech', text: 'Uh you can cut pauses and remove filler words.' },
]

const FIXTURES: FixtureSpec[] = [
  {
    name: 'talking-head-en',
    size: '640x360',
    fps: 30,
    audio: SPEECH_PARTS,
    expectations: {
      hasAudio: true,
      sourceWidth: 640,
      sourceHeight: 360,
      minDurationSec: 8,
      maxDurationSec: 25,
      minSilences: 2,
    },
  },
  {
    name: 'portrait-en',
    size: '720x1280',
    fps: 30,
    audio: SPEECH_PARTS,
    expectations: {
      hasAudio: true,
      sourceWidth: 720,
      sourceHeight: 1280,
      minDurationSec: 8,
      maxDurationSec: 25,
      minSilences: 2,
    },
  },
  {
    name: 'odd-dims-en',
    extension: 'mkv',
    size: '641x361',
    fps: 25,
    audio: [{ kind: 'speech', text: 'Odd dimensions need rounding to even numbers.' }, { kind: 'silence', durationSec: 1 }],
    expectations: {
      hasAudio: true,
      sourceWidth: 641,
      sourceHeight: 361,
      minDurationSec: 3,
      maxDurationSec: 15,
      minSilences: 1,
    },
  },
  {
    name: 'long-pauses',
    size: '960x540',
    fps: 30,
    audio: [
      { kind: 'silence', durationSec: 0.5 },
      { kind: 'speech', text: 'First short sentence.' },
      { kind: 'silence', durationSec: 2.5 },
      { kind: 'speech', text: 'Second short sentence.' },
      { kind: 'silence', durationSec: 3 },
      { kind: 'speech', text: 'Third short sentence.' },
      { kind: 'silence', durationSec: 2.5 },
    ],
    expectations: {
      hasAudio: true,
      sourceWidth: 960,
      sourceHeight: 540,
      minDurationSec: 10,
      maxDurationSec: 30,
      minSilences: 3,
    },
  },
  {
    name: 'silent-track',
    size: '480x270',
    fps: 30,
    audio: 'silent',
    expectations: {
      hasAudio: true,
      sourceWidth: 480,
      sourceHeight: 270,
      minDurationSec: 5,
      maxDurationSec: 12,
      minSilences: 1,
    },
  },
  {
    name: 'no-audio',
    size: '480x270',
    fps: 30,
    audio: 'none',
    expectations: {
      hasAudio: false,
      sourceWidth: 480,
      sourceHeight: 270,
      minDurationSec: 4,
      maxDurationSec: 8,
      expectError: '没有音轨',
    },
  },
  {
    name: 'short-0.8s',
    size: '320x180',
    fps: 30,
    audio: [{ kind: 'speech', text: 'Hi.' }],
    expectations: {
      hasAudio: true,
      sourceWidth: 320,
      sourceHeight: 180,
      minDurationSec: 0.5,
      maxDurationSec: 6,
    },
  },
]


function fliteArgs(text: string): string[] {
  // flite 的 text 里单引号会破坏 lavfi 语法，统一替换。
  return ['-f', 'lavfi', '-i', `flite=text='${text.replace(/'/g, '')}':voice=slt`]
}

async function buildAudio(parts: AudioPart[], workDir: string, useFlite: boolean, ffmpegBin: string): Promise<string> {
  const outPath = path.join(workDir, 'audio.wav')
  const args: string[] = ['-y', '-v', 'error']
  const filters: string[] = []
  const labels: string[] = []
  parts.forEach((part, index) => {
    if (part.kind === 'silence') {
      args.push('-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${part.durationSec}`)
    } else if (useFlite) {
      args.push(...fliteArgs(part.text))
    } else {
      // 回退：用音调占位，保持与语音段相同的“有声/无声”结构。
      args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=2.5`)
    }
    filters.push(`[${index}:a]aformat=sample_rates=48000:channel_layouts=mono[a${index}]`)
    labels.push(`[a${index}]`)
  })
  filters.push(`${labels.join('')}concat=n=${parts.length}:v=0:a=1[aout]`)
  args.push('-filter_complex', filters.join(';'), '-map', '[aout]', outPath)
  await execFileAsync(ffmpegBin, args)
  return outPath
}

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await execFileAsync(resolveFfprobe(), [
    '-v', 'error', '-print_format', 'json', '-show_format', file,
  ])
  return Number((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration)
}

async function makeFixture(spec: FixtureSpec, outDir: string, useFlite: boolean, ffmpegBin: string): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pimko-fixture-'))
  const extension = spec.extension ?? 'mp4'
  const outPath = path.join(outDir, `${spec.name}.${extension}`)
  const [width, height] = spec.size.split('x').map(Number) as [number, number]
  const odd = width % 2 !== 0 || height % 2 !== 0
  try {
    const args: string[] = ['-y', '-v', 'error']
    let duration: number
    // 奇数尺寸先用大一号的偶数画布生成,再在 yuv444p 下裁剪,否则会被强制取偶。
    const sourceSize = odd ? `${width + 1}x${height + 1}` : spec.size
    const videoFilters = odd ? [`format=yuv444p`, `crop=${width}:${height}`] : []
    if (spec.audio === 'none') {
      duration = 5
      args.push('-f', 'lavfi', '-i', `testsrc2=size=${sourceSize}:rate=${spec.fps}:duration=${duration}`)
    } else if (spec.audio === 'silent') {
      duration = 8
      args.push('-f', 'lavfi', '-i', `testsrc2=size=${sourceSize}:rate=${spec.fps}:duration=${duration}`)
      args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=8')
    } else {
      const audioPath = await buildAudio(spec.audio, workDir, useFlite, ffmpegBin)
      duration = await probeDuration(audioPath)
      args.push('-f', 'lavfi', '-i', `testsrc2=size=${sourceSize}:rate=${spec.fps}:duration=${duration}`)
      args.push('-i', audioPath)
    }
    if (videoFilters.length > 0) args.push('-vf', videoFilters.join(','))
    if (odd) {
      args.push('-c:v', 'ffv1', '-pix_fmt', 'yuv444p')
    } else {
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast')
    }
    if (spec.audio !== 'none') args.push('-c:a', 'aac', '-ar', '48000', '-ac', '2')
    args.push('-shortest', outPath)
    // 视频编码用静态 ffmpeg 即可；音频输入已是 wav，无 flite 依赖。
    await execFileAsync(resolveFfmpeg(), args)
    console.log(`fixture ${spec.name}: ${duration.toFixed(2)}s`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * ffmpeg-static 的静态构建通常不带 libflite，系统 ffmpeg 往往带。
 * 生成语音素材时挑第一个支持 flite 的二进制，找不到再回退音调占位。
 */
async function pickFliteFfmpeg(): Promise<string | undefined> {
  for (const candidate of [resolveFfmpeg(), 'ffmpeg']) {
    try {
      const { stdout } = await execFileAsync(candidate, ['-hide_banner', '-filters'])
      if (stdout.includes('flite')) return candidate
    } catch {
      // 该候选不可用，继续下一个
    }
  }
  return undefined
}

async function main(): Promise<void> {
  const outDir = path.resolve(__dirname, '..', 'sample-assets', 'fixtures')
  await mkdir(outDir, { recursive: true })
  const ffmpegBin = await pickFliteFfmpeg()
  const useFlite = ffmpegBin !== undefined
  if (!ffmpegBin) console.warn('未找到带 libflite 的 ffmpeg，语音段将用音调占位（结构不变）。')
  else console.log(`使用 ${ffmpegBin} 合成语音`)
  for (const spec of FIXTURES) {
    await makeFixture(spec, outDir, useFlite, ffmpegBin ?? resolveFfmpeg())
  }
  await writeFile(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), speech: useFlite, fixtures: FIXTURES }, null, 2)}\n`,
  )
  console.log(`fixtures written to ${outDir}`)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
