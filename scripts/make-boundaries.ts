import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveFfmpeg } from '../src/infra/ffmpeg-bin'
import { BOUNDARY_CASES } from './boundary-cases'

const exec = promisify(execFile)
const root = path.resolve(__dirname, '..')
const ffmpeg = resolveFfmpeg()

async function encode(args: string[]): Promise<void> {
  await exec(ffmpeg, ['-y', '-v', 'error', '-filter_threads', '1', '-filter_complex_threads', '1', ...args], {
    timeout: 180000, maxBuffer: 2 * 1024 * 1024,
  })
}
const video = (size = '320x180', duration = 4, rate = 30) =>
  ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${duration}`]
const h264 = ['-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']

async function main(): Promise<void> {
  const out = path.join(root, 'sample-assets', 'boundaries')
  const extended = process.argv.includes('--extended')
  const specs = BOUNDARY_CASES.filter((entry) => extended || !entry.extended)
  await mkdir(out, { recursive: true })
  await mkdir(path.join(root, '.tmp'), { recursive: true })
  const work = await mkdtemp(path.join(root, '.tmp', 'boundary-generation-'))
  try {
    let speechFfmpeg: string | undefined
    for (const candidate of [...new Set([ffmpeg, 'ffmpeg'])]) {
      try {
        const { stdout } = await exec(candidate, ['-hide_banner', '-filters'])
        if (stdout.includes('flite')) { speechFfmpeg = candidate; break }
      } catch { /* 尝试系统 ffmpeg。 */ }
    }
    if (!speechFfmpeg) throw new Error('边界语音素材需要带 libflite 的 ffmpeg；不使用音调冒充语音。')
    const speech = path.join(work, 'speech.wav')
    await exec(speechFfmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i',
      "flite=text='Hello, um, keep this word. Goodbye.':voice=slt",
      '-af', 'apad', '-t', '4', '-ar', '48000', '-ac', '1', speech])
    const base = path.join(work, 'base.mp4')
    await encode([...video(), '-i', speech, ...h264, '-c:a', 'aac', '-t', '4', base])
    for (const spec of specs) {
      const dest = path.join(out, spec.file)
      if (['special-path', 'mov', 'm4v', 'mkv'].includes(spec.id)) {
        await encode(['-i', base, '-c', 'copy', dest])
      } else if (spec.id === 'square') {
        await encode([...video('320x320'), '-i', speech, ...h264, '-c:a', 'aac', '-t', '4', dest])
      } else if (spec.id === 'webm') {
        await encode(['-i', base, '-c:v', 'libvpx-vp9', '-threads', '1', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', dest])
      } else if (spec.id === 'rotate90') {
        await encode(['-display_rotation', '90', '-i', base, '-c', 'copy', dest])
      } else if (spec.id === 'sar') {
        await encode(['-i', base, '-vf', 'setsar=4/3', ...h264, '-c:a', 'copy', dest])
      } else if (spec.id === 'vfr') {
        await encode(['-i', base, '-vf', "select='if(lt(mod(n,10),5),1,not(mod(n,2)))'", '-fps_mode', 'vfr', ...h264, '-c:a', 'copy', dest])
      } else if (spec.id === 'one-frame') {
        await encode([...video('320x180', 1 / 30), '-i', speech, ...h264, '-c:a', 'aac', '-t', String(1 / 30), dest])
      } else if (spec.id === 'low-fps') {
        await encode([...video('320x180', 4, 1), '-i', speech, ...h264, '-c:a', 'aac', '-t', '4', dest])
      } else if (spec.id === 'short-audio') {
        await encode([...video(), '-i', speech, '-filter_complex', '[1:a]atrim=duration=1[a]', '-map', '0:v', '-map', '[a]', ...h264, '-c:a', 'aac', dest])
      } else if (spec.id === 'delayed-audio') {
        await encode([...video(), '-itsoffset', '1', '-i', speech, '-map', '0:v', '-map', '1:a', ...h264, '-c:a', 'aac', '-t', '4', dest])
      } else if (spec.id === 'left-only') {
        await encode(['-i', base, '-af', 'pan=stereo|c0=c0|c1=0*c0', '-c:v', 'copy', '-c:a', 'aac', dest])
      } else if (spec.id === 'quiet') {
        await encode(['-i', base, '-af', 'volume=-30dB', '-c:v', 'copy', '-c:a', 'aac', dest])
      } else if (spec.id === 'noise' || spec.id === 'music') {
        const sound = spec.id === 'noise'
          ? 'anoisesrc=color=white:amplitude=0.12:duration=4:seed=42'
          : 'aevalsrc=0.35*sin(2*PI*220*t)+0.25*sin(2*PI*330*t)+0.2*sin(2*PI*440*t):d=4'
        await encode(['-i', base, '-f', 'lavfi', '-i', sound, '-filter_complex',
          '[0:a]volume=0.4[voice];[voice][1:a]amix=inputs=2:duration=first:normalize=0[a]',
          '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', dest])
      } else if (spec.id === 'silent') {
        await encode([...video(), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=4', ...h264, '-c:a', 'aac', dest])
      } else if (spec.id === 'no-audio') {
        await encode(['-i', base, '-an', '-c:v', 'copy', dest])
      } else if (spec.id === 'zero-byte') {
        await writeFile(dest, Buffer.alloc(0))
      } else if (spec.id === 'fake-mp4') {
        await writeFile(dest, 'Deliberately invalid MP4 fixture. No executable content.\n')
      } else if (spec.id === 'truncated') {
        await writeFile(dest, (await readFile(base)).subarray(0, 48))
      } else if (spec.id === 'audio-only') {
        await encode(['-i', speech, '-vn', '-c:a', 'aac', dest])
      } else if (spec.id === 'four-k') {
        await encode([...video('3840x2160', 2, 15), '-i', speech, ...h264, '-c:a', 'aac', '-t', '2', dest])
      } else if (spec.id === 'five-minutes') {
        await encode(['-stream_loop', '-1', '-i', base, '-t', '300', '-c', 'copy', dest])
      } else {
        throw new Error(`没有生成器: ${spec.id}`)
      }
      console.log(`generated ${spec.id}: ${spec.file}`)
    }
    const cases = []
    for (const spec of specs) {
      const bytes = await readFile(path.join(out, spec.file))
      cases.push({ ...spec, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify({
      generatedAt: new Date().toISOString(), speech: true, extended, cases,
      transcript: 'Hello, um, keep this word. Goodbye.',
      caveat: '合成原音固定为 4 秒；噪声/弱音/音轨偏移项是待人工探测，不是已通过的能力声明。',
    }, null, 2)}\n`)
    console.log(`boundary corpus ready: ${cases.length} files`)
  } finally { await rm(work, { recursive: true, force: true }) }
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
