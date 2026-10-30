import type { CompiledTimeline } from '../domain/compiler'
import type { ContentKind } from '../domain/document'
import type { MediaAsset } from '../domain/media'
import type { ProjectSettings } from '../domain/project'
import type { QualityReport } from '../domain/quality'
import type { Transcript } from '../domain/transcript'

/**
 * 成片检查端口：输入是渲染后的文件与它对应的编译事实，输出实际测量报告。
 * 实现不得只回放编译产物；至少要通过 ffprobe/ffmpeg 读取 outputPath。
 */
export interface InspectRequest {
  compiled: CompiledTimeline
  assets: MediaAsset[]
  transcript?: Transcript
  contentKind: ContentKind
  outputPath: string
  /** 用于核对分辨率；缺省时只要求存在有效视频流。 */
  settings?: ProjectSettings
  revisionId?: string
  /** 可选证据目录；提供时把 ffprobe/黑帧/波形证据落盘并写进报告。 */
  evidenceDir?: string
}

export interface Inspector {
  inspect(request: InspectRequest): Promise<QualityReport>
}
