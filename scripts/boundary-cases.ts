export type BoundaryCheck =
  | { kind: 'video'; width: number; height: number; audio: boolean; minDuration: number; maxDuration: number }
  | { kind: 'reject' }

export interface BoundaryCase {
  id: string
  file: string
  purpose: string
  expected: string
  check: BoundaryCheck
  /** 实际渲染验收；旋转/VFR/HDR 等先保留为人工能力边界探测。 */
  render: boolean
  extended?: boolean
}

const video = (width = 320, height = 180, audio = true, minDuration = 3.9, maxDuration = 4.2): BoundaryCheck =>
  ({ kind: 'video', width, height, audio, minDuration, maxDuration })

export const BOUNDARY_CASES: BoundaryCase[] = [
  { id: 'square', file: 'square.mp4', purpose: '正方形视频', expected: '预览与导出保持 1:1，不拉伸', check: video(320, 320), render: true },
  { id: 'mov', file: 'container.mov', purpose: 'MOV 容器', expected: '可导入、抽音频并导出', check: video(), render: true },
  { id: 'm4v', file: 'container.m4v', purpose: 'M4V 扩展名', expected: '可导入、抽音频并导出', check: video(), render: true },
  { id: 'mkv', file: 'container.mkv', purpose: 'Matroska 容器', expected: '可导入、抽音频并导出', check: video(), render: true },
  { id: 'webm', file: 'container.webm', purpose: 'VP9/Opus WebM', expected: '可导入并导出；源预览的解码能力另行检查', check: video(), render: true },
  { id: 'special-path', file: '中文 空格 (括号) quote\' & [test].mp4', purpose: '中文、空格、单引号与符号路径', expected: '导入/缩略图/预览/导出不因路径解析失败', check: video(), render: true },
  { id: 'rotate90', file: 'rotation-90.mp4', purpose: '横向编码 + 90° 显示矩阵', expected: '观察实际显示方向；预览与导出不侧倒、不错误留边。此项未保证支持', check: video(), render: false },
  { id: 'sar', file: 'non-square-pixels.mp4', purpose: 'SAR 4:3 非方形像素', expected: '按显示比例观察圆形和方格，不压扁、不拉长。此项未保证支持', check: video(), render: false },
  { id: 'vfr', file: 'variable-frame-rate.mp4', purpose: '交错帧间隔的可变帧率', expected: '跳切/变速/导出无累积音画偏移。此项未保证支持', check: video(320, 180, true, 3.5, 4.2), render: false },
  { id: 'one-frame', file: 'one-frame.mp4', purpose: '约 33ms 单帧视频', expected: '应明确拒绝或生成可播放结果，不能挂死或报成功后没有文件；产品结果待观察', check: video(320, 180, true, 0.02, 0.15), render: false },
  { id: 'low-fps', file: 'one-fps.mp4', purpose: '1 fps 视频', expected: '允许稀疏画面，导出时长与音频连续，不应额外截断', check: video(), render: true },
  { id: 'short-audio', file: 'short-audio.mp4', purpose: '4 秒视频只有前 1 秒音轨', expected: '区分轨道结束和静音；明确检查末尾导出和转写，不能假设音轨覆盖全片', check: video(), render: false },
  { id: 'delayed-audio', file: 'delayed-audio.mp4', purpose: '音轨从第 1 秒开始', expected: '源时间和转写时间对齐，不能把声音剪早 1 秒；待人工验收', check: video(), render: false },
  { id: 'left-only', file: 'speech-left-only.mp4', purpose: '左声道口播、右声道静音', expected: '下混后仍能听清并转写，不误判为全静音', check: video(), render: true },
  { id: 'quiet', file: 'quiet-speech.mp4', purpose: '语音降低 30dB', expected: '观察静音阈值是否误删弱语音；没有自动宣称转写应成功', check: video(), render: false },
  { id: 'noise', file: 'speech-with-noise.mp4', purpose: '语音叠加固定种子噪声', expected: '观察转写漏词/错词及误剪；对照干净原音', check: video(), render: false },
  { id: 'music', file: 'speech-under-music.mp4', purpose: '语音被合成音乐盖住', expected: '观察误转写/幻听/错误口癖删除；不能以非空转写判定正确', check: video(), render: false },
  { id: 'silent', file: 'silence.mp4', purpose: '全静音', expected: '真实转写不应凭空生成对白；mock 导出不代表真实转写通过', check: video(), render: false },
  { id: 'no-audio', file: 'no-audio.mp4', purpose: '完全没有音轨', expected: '抽音频阶段明确提示没有音轨，不白屏', check: video(320, 180, false), render: false },
  { id: 'zero-byte', file: 'empty.mp4', purpose: '零字节文件', expected: '拒绝导入，不创建项目', check: { kind: 'reject' }, render: false },
  { id: 'fake-mp4', file: 'not-video.mp4', purpose: '文本伪装成 MP4', expected: '拒绝导入，不创建项目', check: { kind: 'reject' }, render: false },
  { id: 'truncated', file: 'truncated.mp4', purpose: '仅保留 MP4 文件头，缺少媒体及索引', expected: '拒绝导入，不创建项目', check: { kind: 'reject' }, render: false },
  { id: 'audio-only', file: 'audio-only.mp4', purpose: 'MP4 容器仅有音轨', expected: '提示没有视频轨，不创建项目', check: { kind: 'reject' }, render: false },
  { id: 'four-k', file: '4k-short.mp4', purpose: '2 秒 UHD 4K，扩展负载', expected: '检查尺寸、内存和导出可用性；仅在云端扩展任务执行', check: video(3840, 2160, true, 1.9, 2.2), render: false, extended: true },
  { id: 'five-minutes', file: 'five-minutes.mp4', purpose: '5 分钟长视频，低分辨率', expected: '检查请求长度、恢复与持续资源占用；不要把短片表现推广到长片', check: video(320, 180, true, 299.8, 300.3), render: false, extended: true },
]
