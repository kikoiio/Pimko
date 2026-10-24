import type { Transcript } from './transcript'

/** 固定口癖：无语义的语气词，机械检测后默认删除。 */
export const FIXED_FILLERS = ['呃', '嗯', '呣', '唔', '额', '啊', 'emm', 'em', 'um', 'uh', 'uhh', 'umm']

/** 语境口癖：可能有语义（承接、转折），由 LLM 结合上下文判断是否删除。 */
export const CONTEXTUAL_FILLERS = ['然后', '就是', '那个', '这个', '其实', 'basically', 'like', 'so', 'you know']

export interface FillerHit {
  segmentIndex: number
  startSec: number
  endSec: number
  word: string
}

/** 归一化词元：去空白与首尾标点、转小写，供口癖匹配。 */
function normalizeToken(token: string): string {
  return token.trim().replace(/^[，。！？、：；,.!?;:"“”'()（）\s]+|[，。！？、：；,.!?;:"“”'()（）\s]+$/g, '').toLowerCase()
}

/** 在词级转写中机械查找固定口癖；确定性：同一转写必然同一结果。 */
export function findFillerWords(
  transcript: Transcript,
  lexicon: string[] = FIXED_FILLERS,
): FillerHit[] {
  const hits: FillerHit[] = []
  const dictionary = new Set(lexicon.map(normalizeToken))
  transcript.segments.forEach((segment, segmentIndex) => {
    for (const word of segment.words ?? []) {
      if (dictionary.has(normalizeToken(word.word))) {
        hits.push({ segmentIndex, startSec: word.startSec, endSec: word.endSec, word: word.word })
      }
    }
  })
  return hits
}
