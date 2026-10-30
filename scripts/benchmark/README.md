# P0 基准 harness

对应 [重建计划](../../../docs/plans/2026-10-29-editing-core-rebuild.md) §4 固定基准与 §5 P0：用同一套固定反馈跑当前 Pimko，留下可复现的 baseline，后续每个阶段跑同一套基准对比。

## 组成

| 文件 | 作用 |
|---|---|
| `manifest.json` | 正式基准清单 B1–B5（中文口播 / 英文口播 / 蒙太奇 / 教程 / 合成边界）与 5 轮固定反馈 |
| `manifest.standin.json` | 本地 mock baseline 的替代素材映射（映射到主仓 `sample-assets` 现成样品，非正式语料） |
| `run.ts` | harness：对每个 case 执行 createDraft → 5 轮 revise → export + 空时间线拒绝探针 |
| `score.ts` | 汇总各 case 的 `result.json`，按内容类型分组输出评分报告 |

## 运行

```bash
# mock baseline（不联网；provider 只支持 mock，真实模型基准属 P6）
PIMKO_BENCHMARK_DIR=/path/to/assets npm run benchmark
# 用主仓现成样品跑（在主仓只读，不动主仓文件）：
PIMKO_BENCHMARK_DIR=/home/neo/Projects/Pimko/sample-assets npm run benchmark -- \
  --manifest scripts/benchmark/manifest.standin.json

# 只跑一个 case
PIMKO_BENCHMARK_DIR=... npm run benchmark -- --case B5

# 评分（读 <out>/*/result.json，写 score-report.md）
npm run benchmark:score
npm run benchmark:score -- --out /custom/dir
```

- 素材目录通过环境变量 `PIMKO_BENCHMARK_DIR` 指定；正式清单期望目录内有 `b1-zh-speech.mp4` 等文件（见 `manifest.json`）。文件缺失时明确报缺失并把该 case 标为 `missing-assets`，不伪造数据。
- 输出默认在 `.tmp/benchmark/`（已 gitignore）：每个 case 一个目录，含 `result.json`（全量数据）、`summary.md`（人读摘要）、`export-final.mp4`（成片）；另有一份 `run.json`（运行上下文）。
- 退出码：`0` 全部 case ok；`1` 有失败/缺素材（结果仍完整落盘）；`2` 用法/清单/环境错误。
- 修订链的 store 在 `<out>/.work/<caseId>/store`，属中间产物，可整目录删除。

## 测量口径

已测量（harness 可观测）：

- 建稿/每轮修订/导出耗时（`performance.now()` 墙钟，含分析、LLM(mock)、渲染）
- 每轮 `revisionId`、片段数、时间线时长（`timelineDurationSec`，计变速与叠化重叠）、`RevisionDiff`、agentNote、错误
- 导出预计时长（编译口径）vs 实际时长（ffprobe 读输出文件），误差按计划 §4.2 目标 <100ms 标注
- 空时间线拒绝探针：向 store 追加一条空时间线修订后调用 `Editor.export`，必须被拒绝（不变量；违反会在结果与报告中显式标记）

未测量（报告中标 `unmeasured`，不是 0）：

- 切词率、切点爆音、镜头切断、黑帧/冻结帧、字幕同步误差、质量闸门通过率、主观可发布——当前链路（P0，pre-P1）没有质量闸门与切点检查，P2/P3/P4 接入后此节才有数据。

## 可复现性

同一输入两次运行：片段数、diff、时长误差、拒绝探针等结构指标一致；耗时随机器负载波动。素材 sha256 记录在 `result.json` 里供比对。

## 约束

- 不联网：provider 仅 `mock`；`--provider openai` 等会被拒绝并说明。
- 只通过 `Editor` 驱动（GUI/MCP 同一命令层），不旁路写时间线；探针只通过公开的 `ProjectStore` 端口追加修订。
- 渲染 CPU 密集，case 串行执行（计划 §6）。

## worktree 注意

worktree 若没有 `node_modules`，`npm run` 不可直接用；可指向主仓已装好的依赖（只读复用，不重新安装）：

```bash
ln -s /home/neo/Projects/Pimko/node_modules node_modules
```
