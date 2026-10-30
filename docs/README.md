# Pimko 文档索引

| 类型 | 状态 | 更新 | 文档 |
|---|---|---|---|
| 项目意图 | 生效 | 2026-10-29 | [intent.md](intent.md) — 通用短视频定位、任务、原则、质量契约与范围 |
| 架构 | 生效 | 2026-10-29 | [architecture.md](architecture.md) — 当前实现、数据流、存储与验证 |
| 调研 | 已归档 | 2026-10-24 | [research/2026-10-24-agentic-video-editing-prior-art.md](research/2026-10-24-agentic-video-editing-prior-art.md) — 技术路线与可复用项目 |
| 调研 | 已归档 | 2026-10-26 | [research/2026-10-26-agentic-video-editing-products.md](research/2026-10-26-agentic-video-editing-products.md) — 竞品与体验清单 |
| 调研 | 已归档 | 2026-10-29 | [research/2026-10-29-reference-implementations.md](research/2026-10-29-reference-implementations.md) — openfilm、video-use、auto-editor 等实测与实现拆解 |
| 设计 | 已实现 | 2026-10-29 | [design/2026-10-29-editing-architecture.md](design/2026-10-29-editing-architecture.md) — EditDocument、补丁计划、编译时间线与质量闸门 |
| 计划 | 已实现（有限制） | 2026-10-29 | [plans/2026-10-29-editing-core-rebuild.md](plans/2026-10-29-editing-core-rebuild.md) — P0–P6 已落地；B-roll 为全屏单 overlay 轨，B1/B3 有已知限制 |

文档按功能命名：常青文档用裸 slug，一次性记录带 ISO 日期前缀。`intent.md` 只写为什么做与验收标准；当前实现写进 `architecture.md`；调研结论进入计划后再落代码。
