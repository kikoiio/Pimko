import type { MediaAsset } from '../domain/media'
import type { Transcript, TranscriptSegment, TranscriptWord } from '../domain/transcript'
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
        words: mockWords(
          `第 ${index} 句：这是 mock 转写内容，接入真实语音识别后会替换。`,
          start,
          Math.min(start + segmentLength, asset.durationSec),
        ),
      })
    }
    return { assetId: asset.id, language: 'zh-CN', segments }
  }
}

/** 与真实转写同构的词级数据：按空白切词，时长线性分布。 */
function mockWords(text: string, startSec: number, endSec: number): TranscriptWord[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const span = (endSec - startSec) / tokens.length
  return tokens.map((token, index) => ({
    startSec: startSec + index * span,
    endSec: startSec + (index + 1) * span,
    word: token,
  }))
}
