import type { MediaAsset } from '../domain/media'
import type { Transcript, TranscriptSegment } from '../domain/transcript'
import type { Transcriber } from '../ports/transcriber'

export class MockTranscriber implements Transcriber {
  async transcribe(asset: MediaAsset): Promise<Transcript> {
    const segmentLength = 4
    const segments: TranscriptSegment[] = []
    for (let start = 0; start < asset.durationSec; start += segmentLength) {
      const index = segments.length + 1
      segments.push({
        startSec: start,
        endSec: Math.min(start + segmentLength, asset.durationSec),
        text: `第 ${index} 句：这是 mock 转写内容，接入真实语音识别后会替换。`,
        confidence: 0.9,
      })
    }
    return { assetId: asset.id, language: 'zh-CN', segments }
  }
}
