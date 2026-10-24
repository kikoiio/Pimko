# Pimko 架构设计

## Problem

Pimko 是一个面向"完全不会剪辑"用户的短视频剪辑 agent。用户给一段口播素材，用自然语言提出需求和反馈，系统产出一条可直接发布的竖版成片（字幕 + BGM + 转场）。第一用户是作者本人；MVP 是桌面技术演示（Electron + 本地 ffmpeg），模型层可插拔（先 mock 后接真实 API），Android 上传/审阅推迟到 V2。

核心难点不是线性地"跑完一条流水线"，而是**多轮对话式迭代**：用户说"开头太拖"，系统要基于当前成片产出下一版。这个循环决定了架构必须以"项目状态 + 修订"为中心，而不是以处理阶段为中心。

## Usage（调用方视角）

```ts
// 主进程装配（composition root）
const editor = new Editor({
  prober: new FfmpegProber(),
  transcriber: new MockTranscriber(),        // V1: mock；之后换 WhisperTranscriber
  intelligence: new MockIntelligence(),      // V1: mock；之后换 LlmIntelligence
  renderer: new FfmpegRenderer(),
  store: new FsProjectStore(appDataPath),
})

// UI 通过 IPC 触发的两个核心动作
const draft = await editor.createDraft('/path/to/talking-head.mp4')
const v2 = await editor.revise(draft.project.id, { text: '开头太拖，直接进正题' })
const out = await editor.export(v2.project.id, '~/Desktop/final.mp4')
```

UI 不接触 ffmpeg、转写器、模型；它只看到 `ProjectRevision`（可播放的时间线 + 字幕 + 反馈历史）和三个动词：`createDraft / revise / export`。

## 候选方案

### 候选 A：流水线架构（拒绝）

按执行顺序组织模块：`Ingest → Transcribe → Analyze → Assemble → Render`，一个 Pipeline 编排器依次调用各阶段，UI 调各阶段 API。

被红旗清单否决：
- **时间分解**：模块按执行顺序而非知识归属划分。"分析"和"组装"共享对时间线的全部理解，却分属两处。
- **迭代不匹配**：`revise` 在线性流水线里是"回到上游重跑"，状态归属模糊——这正是产品核心循环，不能是架构的补丁。
- **浅模块**：调用方要协调多个阶段才能完成一次剪辑。

### 候选 B：项目即事实源 + 修订循环（采纳为基础）

领域模型（`Project` / `Timeline` / `Transcript`）拥有全部剪辑知识；渲染是 `Project → 视频` 的纯函数；流水线被藏进 `Editor` 服务内部；基础设施（ffmpeg、whisper、LLM、存储）全部躲在 port 接口后面。

从候选 A 移植的一点：**素材探测（probe）保留为独立 port**。它拥有独立的媒体知识（时长/分辨率/编码），与转写、渲染都不共享，值得独立抽象。

## Shape

``+src/
  domain/       纯类型与规则，零 I/O
    media.ts        MediaAsset
    transcript.ts   Transcript / TranscriptSegment
    timeline.ts     Timeline / TimelineClip / SubtitleCue / BgmTrack / Transition
    project.ts      Project / ProjectSettings / ProjectRevision / Feedback
  ports/        基础设施接口（main 进程实现）
    prober.ts        probeMedia(path) -> MediaAsset
    transcriber.ts   transcribe(asset) -> Transcript
    intelligence.ts  draftFromTranscript / reviseTimeline（LLM 可插拔点）
    renderer.ts      render(project, outPath) -> RenderResult
    store.ts         ProjectStore：修订持久化
  services/
    editor.ts    唯一编排者：createDraft / revise / export / open
  infra/        ports 的适配器
    mock-transcriber.ts, mock-intelligence.ts, ffmpeg-prober.ts,
    ffmpeg-renderer.ts, fs-store.ts
  main/         Electron 主进程（装配 editor，暴露 IPC）
  preload/      薄 IPC 桥
  renderer/     React UI：导入、时间线预览、对话反馈、导出
```

关键不变量：
- `Project`（含 timeline）是唯一事实源；渲染、UI 预览都是它的纯投影。
- `Editor.revise` 永不改入参，产出新 `ProjectRevision`（可回退、可 diff）。
- 时间线内坐标是源素材时间（`sourceStartSec/sourceEndSec`）；输出时间轴由渲染时派生，不手工同步。
- 领域层零 I/O；所有 I/O 在 ports 之后，边界处校验、内部信任类型。

接口深度：`Editor` 三个动词隐藏了转写、选段、字幕对齐、BGM、转场、渲染全部策略；UI 与未来的 Android 端都只需这一层。

## Tradeoffs accepted

- 接受"渲染纯函数化"带来的重建成本，换取 revise/export/预览永远一致。
- 接受 mock intelligence 的演示性成片质量，换取全链路先跑通、模型层可替换。
- 接受 V1 无时间线手动微调，换取对话迭代回路最早闭环（用户明确选择）。

## Alternatives considered

候选 A（流水线）输在迭代回路与知识归属。第三方移动优先架构（云端渲染 + 薄客户端）输在用户已选桌面本地渲染，且 MVP 验收是桌面技术演示。

## Implementation reconciliation

（实现期间记录对偏差的接受与理由。）

## Open questions and risks

- 字幕样式预设（字体/安全区）是否需要 per-platform 预设？可在 `ProjectSettings` 中先留枚举。
- mock transcriber 需要一段带假时间戳的样例数据来驱动演示，导入真实素材时无转写可用如何降级？
- BGM 版权：内置音乐库素材来源待定，演示版先用静音或用户自带文件。

## Next implementation step

按此骨架补全 domain/ports/services 与 mock infra 的可运行实现，打通 `createDraft → revise → export`（renderer 可先用 ffmpeg-static 输出占位视频）。
