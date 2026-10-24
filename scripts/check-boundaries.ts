import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { BOUNDARY_CASES } from './boundary-cases'
import { FfmpegProber } from '../src/infra/ffmpeg-prober'
import { FfmpegRenderer } from '../src/infra/ffmpeg-renderer'
import { extractAudio } from '../src/infra/extract-audio'
import { resolveFfmpeg, resolveFfprobe } from '../src/infra/ffmpeg-bin'
import type { Project } from '../src/domain/project'

const exec = promisify(execFile)
const root = path.resolve(__dirname, '..')

async function main(): Promise<void> {
  const corpus = path.join(root, 'sample-assets', 'boundaries')
  const manifest: { extended: boolean; cases: { id: string; sha256: string }[]; supportMedia: { id: string; file: string; durationSec: number; sha256: string }[] } = JSON.parse(await readFile(path.join(corpus, 'manifest.json'), 'utf8'))
  await mkdir(path.join(root, '.tmp'), { recursive: true })
  const work = await mkdtemp(path.join(root, '.tmp', 'boundary-check-'))
  const results: { id: string; status: 'passed' | 'failed'; detail: string; productStatus: string }[] = []
  try {
    for (const spec of BOUNDARY_CASES.filter((entry) => manifest.extended || !entry.extended)) {
      try {
        const file = path.join(corpus, spec.file)
        const hash = createHash('sha256').update(await readFile(file)).digest('hex')
        assert.equal(hash, manifest.cases.find((entry) => entry.id === spec.id)?.sha256, '素材 SHA256 不符')
        if (spec.check.kind === 'reject') {
          await assert.rejects(new FfmpegProber().probe(file))
          results.push({ id: spec.id, status: 'passed', detail: '实际探测器拒绝无效媒体', productStatus: '仅验证拒绝行为；GUI 提示待人工检查' })
          continue
        }
        const expected = spec.check
        const asset = await new FfmpegProber().probe(file)
        assert.equal(asset.width, expected.width)
        assert.equal(asset.height, expected.height)
        assert.ok(asset.durationSec >= expected.minDuration && asset.durationSec <= expected.maxDuration, `源时长 ${asset.durationSec}`)
        const packetArgs = spec.id === 'vfr' ? ['-show_packets', '-show_entries', 'packet=stream_index,pts_time:stream'] : []
        const { stdout } = await exec(resolveFfprobe(), ['-v', 'error', '-show_streams', ...packetArgs, '-of', 'json', file], { maxBuffer: 2 * 1024 * 1024 })
        const probe: {
          streams: { codec_type: string; sample_aspect_ratio?: string; duration?: string; start_time?: string; side_data_list?: { rotation?: number }[] }[]
          packets: { stream_index: number; pts_time?: string }[]
        } = JSON.parse(stdout)
        assert.equal(probe.streams.some((stream) => stream.codec_type === 'audio'), expected.audio)
        const video = probe.streams.find((stream) => stream.codec_type === 'video')
        const audio = probe.streams.find((stream) => stream.codec_type === 'audio')
        if (spec.id === 'rotate90') assert.ok(video?.side_data_list?.some((entry) => Math.abs(entry.rotation ?? 0) === 90), '素材没有真实旋转矩阵')
        if (spec.id === 'sar') assert.equal(video?.sample_aspect_ratio, '4:3')
        if (spec.id === 'short-audio') assert.ok(Number(audio?.duration) < 1.2)
        if (spec.id === 'delayed-audio') assert.ok(Number(audio?.start_time) > 0.8)
        if (spec.id === 'vfr') {
          const times = probe.packets.filter((packet) => packet.stream_index === 0).map((packet) => Number(packet.pts_time)).sort((a, b) => a - b)
          const gaps = new Set(times.slice(1).map((time, i) => Math.round((time - times[i]!) * 1000)))
          assert.ok(gaps.size > 1, '素材实际不是可变帧间隔')
        }
        const caseWork = path.join(work, spec.id)
        await mkdir(caseWork)
        if (spec.id === 'no-audio') await assert.rejects(extractAudio(asset, caseWork), /没有音轨/)
        if (spec.render && process.argv.includes('--render')) {
          const project: Project = {
            id: spec.id, name: spec.id, assets: [asset],
            settings: { width: expected.width, height: expected.height, fps: 30, subtitleStyle: 'bold-center' },
            timeline: {
              clips: [{ assetId: asset.id, sourceStartSec: 0, sourceEndSec: asset.durationSec }],
              subtitles: [{ startSec: 0, endSec: Math.min(2, asset.durationSec), text: '边界测试 Boundary' }], transitions: [],
            },
          }
          await new FfmpegRenderer().render(project, path.join(caseWork, 'export.mp4'))
        }
        results.push({ id: spec.id, status: 'passed', detail: spec.render && process.argv.includes('--render') ? '素材属性 + 实际渲染自检通过' : '素材属性通过', productStatus: '真实转写、剪辑语义、画面和听感仍待人工验收' })
      } catch (error) {
        results.push({ id: spec.id, status: 'failed', detail: error instanceof Error ? error.message : String(error), productStatus: '未通过' })
      }
      console.log(`${results[results.length - 1]?.status}: ${spec.id}`)
    }
    for (const spec of manifest.supportMedia) {
      try {
        const file = path.join(corpus, spec.file)
        assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), spec.sha256, '配乐素材 SHA256 不符')
        const { stdout } = await exec(resolveFfprobe(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { maxBuffer: 1024 * 1024 })
        const probe: { streams: { codec_type: string }[]; format: { duration: string } } = JSON.parse(stdout)
        assert.ok(probe.streams.some((stream) => stream.codec_type === 'audio'))
        assert.ok(!probe.streams.some((stream) => stream.codec_type === 'video'))
        assert.ok(Math.abs(Number(probe.format.duration) - spec.durationSec) < 0.25)
        const audio = path.join(work, `${spec.id}.wav`)
        await exec(resolveFfmpeg(), ['-y', '-v', 'error', '-threads', '1', '-i', file, '-vn', '-c:a', 'pcm_s16le', audio], { timeout: 30000 })
        assert.ok((await stat(audio)).size > 44)
        results.push({ id: spec.id, status: 'passed', detail: '配乐哈希、音轨时长与实际解码通过', productStatus: 'GUI 添加、混音、循环与截断听感待人工验收' })
      } catch (error) {
        results.push({ id: spec.id, status: 'failed', detail: error instanceof Error ? error.message : String(error), productStatus: '未通过' })
      }
      console.log(`${results[results.length - 1]?.status}: ${spec.id}`)
    }
  } finally { await rm(work, { recursive: true, force: true }) }
  const report = { checkedAt: new Date().toISOString(), render: process.argv.includes('--render'), results }
  await writeFile(path.join(corpus, 'check-results.json'), `${JSON.stringify(report, null, 2)}\n`)
  for (const result of results.filter((result) => result.status === 'failed')) console.error(`${result.id}: ${result.detail}`)
  if (results.some((result) => result.status === 'failed')) process.exitCode = 1
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
