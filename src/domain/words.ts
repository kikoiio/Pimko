import type { Transcript, TranscriptWord } from './transcript'

const WORD_PAD_SEC = 0.03
const MAX_SNAP_STEPS = 32

/**
 * Whisper 的词时间戳可能重叠（同一句重复词、跨段边界）。
 * 先按起点排序，把重叠词裁到上一个词的结束；零长度词丢弃。
 * 这样 cut 吸附有唯一、非重叠的词边界可依据。
 */
export function normalizedWords(transcript: Transcript | undefined): TranscriptWord[] {
  if (!transcript) return []
  const sorted = transcript.segments
    .flatMap((segment) => segment.words ?? [])
    .filter((word) => Number.isFinite(word.startSec) && Number.isFinite(word.endSec) && word.endSec > word.startSec)
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)
  const result: TranscriptWord[] = []
  let lastEnd = -Infinity
  for (const word of sorted) {
    const startSec = Math.max(word.startSec, lastEnd)
    if (word.endSec - startSec < 0.01) continue
    result.push({ ...word, startSec })
    lastEnd = word.endSec
  }
  return result
}

/** 若 start 落在词内，反复向左扩到词外；有重叠词时可能需要多步。 */
export function snapStartToWords(words: TranscriptWord[], startSec: number): number {
  let value = startSec
  for (let step = 0; step < MAX_SNAP_STEPS; step++) {
    const inside = words.find((word) => word.startSec < value && value < word.endSec)
    if (!inside) return value
    value = Math.max(0, inside.startSec - WORD_PAD_SEC)
  }
  return value
}

/** 若 end 落在词内，反复向右扩到词外；有重叠词时可能需要多步。 */
export function snapEndToWords(words: TranscriptWord[], endSec: number): number {
  let value = endSec
  for (let step = 0; step < MAX_SNAP_STEPS; step++) {
    const inside = words.find((word) => word.startSec < value && value < word.endSec)
    if (!inside) return value
    value = inside.endSec + WORD_PAD_SEC
  }
  return value
}

export { WORD_PAD_SEC }
