# 参考实现研究：openfilm 与对话式剪辑引擎

> 研究问题：**Pimko 应该从 openfilm 等开源实现里学什么，才能把"对话式短视频剪辑"做到可用？**
> 研究日期：2026-10-29。本文是一次性研究记录；结论进入 [剪辑架构设计](../design/2026-10-29-editing-architecture.md) 与 [剪辑核心重建计划](../plans/2026-10-29-editing-core-rebuild.md)。

## 0. 结论

1. **openfilm 的核心不是"AI 自动剪口播"，而是"film.html 作为唯一工程文档 + 确定性逐帧渲染 + 逐帧自检 + 真正可编辑的 Studio"**。它适合网页动画、片头、拼贴和 agent 写代码生成的影片，不解决转写、静音、词级切点或口播语义。
2. **若只能选一个对象复刻，选 video-use，不选 openfilm**：词级转写 → packed transcript → EDL → 逐段渲染 → 每个切点自检。它的 26 个测试和一次 2 秒 EDL 渲染在本机通过；openfilm 只作为工程文档/自检/编辑器参考。
3. **auto-editor 是缺失的确定性基线**：响度/静音 → label → margin → 切/加速，8 秒合成素材实际剪成 3.47 秒，0.18 秒完成。Pimko 应先用它这一类确定性算法做第一遍，再让 LLM 在受约束的 EDL 上决策。
4. **OpenChatCut 证明同栈可行**：EditorCore + 类型化工具 + MCP + 预览/导出共用一条命令层；但它体量大、AGPL，只学架构，不复制代码。
5. **Pimko 现在的问题不是"缺少更多编辑功能"，而是没有质量基线**：渲染自检只看时长/分辨率，不看切词、爆音、字幕遮挡、画面跳变；真实素材没有固定基准集。现有 `intent.md` 已改为以 8 条质量底线为验收核心。
6. **Pimko 的产品范围不限定口播**。口播是首个验证切片，因为词级时间戳提供了最严格的客观切点标准；无语音/弱语音素材需要镜头、节拍、画面变化分析补上同一层。不要把"口播专用"写进产品边界。

## 1. 研究范围与版本

| 项目 | 版本 / commit | 许可 | 本机验证 |
|---|---|---|---|
| openfilm | 0.2.6 / `ea8cf6d` | MIT | `packages/openfilm` 1321 项：1314 通过、1 失败、6 跳过；shared 20/20、desktop 372 通过/3 跳过（见 §2.1、§2.6）；`look` 与 `render` 成功 |
| video-use | `43cfc56` | MIT | 26 个 unittest 全过；2 秒 EDL 渲染成功 |
| auto-editor | 31.7.2 | Unlicense | 8 秒合成素材 → 3.47 秒，0.18 秒完成；真实 1906 素材也能跑通 |
| kinocut | 1.16.5 | Apache-2.0 | `kino doctor` 退出 0；2 秒 `trim` 成功 |
| OpenChatCut | `7fa4b79` | AGPL-3.0 | 依赖安装被 npm 远程 tarball 策略拦截，未启动；只做静态阅读（见 §2.5） |

工作副本在 `/home/neo/VideoClipAgentResearch/`；素材在 `tests/animated_films/`、`tests/city_traffic/` 等目录。

## 2. 实际运行证据

### 2.1 openfilm

```text
$ node packages/openfilm/bin/openfilm.mjs doctor
✓ OpenFilm 0.2.6 (source checkout)
✓ ffmpeg 8.0.1 / ffprobe 8.0.1
✗ Browser Chromium 149; WebGL ANGLE ... SwiftShader (software)
```

```text
$ cd tests/animated_films
$ OPENFILM_NO_BROWSER=1 node .../openfilm.mjs look 5
film 1920×1080 · 138.5s · 14 sounds
! WebGL runs in software ...
✓ drawn again after another frame: same picture
→ .film/cache/look/5s.png
```

```text
$ ... openfilm.mjs render 0-2 --out /tmp/openfilm-test.mp4 --fps 30 --workers 2
rendering 60 frames with 2 browsers…
60 frames · 2s at 30 fps · 1920×1080 · 2 workers · h264_nvenc · 7.7 s
```

`ffprobe` 复核：h264 + aac，1920×1080，30/1，2.000s，1.5 MB。

本机完整 `pnpm test` 结果：

```text
packages/openfilm
ℹ tests 1321
ℹ pass 1314
ℹ fail 1
ℹ skipped 6
ℹ duration_ms 723666.3
✖ where the person's skills came from: a folder, or the address commitSkills was given; forgotten when removed
  Error: EXDEV: cross-device link not permitted, rename '/tmp/of-skill-origin-.../mine/cards'
       -> '/home/neo/.local/share/Trash/files/cards'

packages/shared（单独重跑）: 20/20 通过
apps/desktop（单独重跑）: 375 项，372 通过、0 失败、3 跳过
```

失败原因是用例把临时目录里的 skill 移到 `~/.local/share/Trash`，而 `/tmp` 与家目录不在同一文件系统；这是环境/清理逻辑问题，不是 `look`/`render` 主链路缺陷。尽管如此，不能声明 openfilm 测试全绿。软件 WebGL 也是环境限制：能跑，画面可能与 GPU 有差异。

### 2.2 video-use

```text
$ python3 -m unittest discover -s tests -v
Ran 26 tests in 0.011s
OK
```

```text
$ python3 helpers/render.py /tmp/video-use-edl.json -o /tmp/video-use-test.mp4 \
    --draft --no-subtitles --no-loudnorm --fps 30
extracting 1 segment(s) → clips_draft/ @ 30/1 fps
concat → base_draft.mp4
done: /tmp/video-use-test.mp4 (0.6 MB)
```

`ffprobe`：h264 + aac，1280×720，2.021s。说明 EDL → 逐段抽取 → 拼接链路在本机可用。

### 2.3 auto-editor

```text
$ /tmp/auto-editor --version
31.7.2

$ /tmp/auto-editor /tmp/ae-src.mp4 --margin 0.1s --output /tmp/ae-cut.mp4
Finished. took 0.18 seconds
```

合成素材 8.000s（两段 1.5 秒声音 + 静音），输出 3.467s。默认阈值在真实 1906 素材上保留 692.3 秒，说明它不是"语义剪辑器"，效果完全取决于阈值、margin 与 label 规则。

### 2.4 kinocut

```text
$ uv run --project . kino doctor
EXIT=0   # 核心 workspace / runtime_policy OK；可选 AI/图像能力标注 Missing

$ uv run --project . kino trim tests/city_traffic/City\ at\ night.webm -s 1 -d 2 -o /tmp/kinocut-test.mp4
Duration: 2.00s · Resolution: 1920x1080 · 1.03 MB
```

### 2.5 OpenChatCut

尝试了 `npm ci --ignore-scripts --no-audit --no-fund`，安装被 npm 策略拦截：

```text
npm error code EALLOWREMOTE
npm error Fetching packages of type "remote" have been disabled
npm error Refusing to fetch "proxy-agent-negotiate@https://registry.npmmirror.com/..."
```

因此没有启动 Electron，也没有运行它的 verify 脚本。只做了静态阅读：`README_ZH.md`、`src/editor/`、`src/agent/tools/`、`src/transcript/`。本文不把未运行的部分当成已验证结论。

### 2.6 ZCode 独立复核

用本机 ZCode（GLM-5.3-Flash）在同一工作区独立跑了一遍，报告在 `/home/neo/VideoClipAgentResearch/zcode-openfilm-report.md`。它额外验证了：

- `tests/city_traffic` 的 `look 0-6`：82.5s、8 个声音、12 帧乱序双画一致，输出接触表 PNG。
- 同一项目 `render 0-3`：90 帧、1920×1080、30fps、h264_nvenc、51.7s，ffprobe 复核 3.000s、BT.709、AAC。
- `apps/desktop` 单独重跑 375 项：372 通过、0 失败、3 跳过；`packages/shared` 单独重跑 20/20。
- 确认 `packages/openfilm` 唯一失败是 `moveToTrash` 的 EXDEV（跨文件系统 rename），并指出这是可修复的小缺陷。

这份独立报告与 §3 的结论一致：openfilm 的竞争力在"单一文档 + 确定性帧 + look 自检 + Studio"，不在语音语义。

## 3. openfilm 实现拆解

### 3.1 工程模型：film.html 是唯一文档

- 一个项目是一个文件夹，核心是 `film.html`；每个 `<section>` 是一条轨道，每个 `<iframe>/<video>/<img>/<audio>` 是一个 clip。
- clip 用 `src`、`#t=in,out`、`at`、`speed`、`volume`、`style`、`class`、`overrides` 描述；时间线、画面位置、裁剪、变速、音量都在同一份 HTML 里。
- 页面 clip 是 `window.film = { frame(t), duration, ready, width, height }`：**同一个 t 必须画出同一张图**。宿主机接管 `Date`、`performance.now`、`requestAnimationFrame`、`Math.random` 与 CSS 动画，使页面在任意顺序、任意并行下都可复现。
- `packages/openfilm/src/film-doc.mjs`（986 行）是唯一的读取/写回实现，`timeline.mjs`、Studio、CLI 都复用它，避免"预览能播、导出不对"的两套解析。

### 3.2 渲染与自检

- `host.mjs` 起 HTTP 服务，只暴露项目文件夹，支持 Range、媒体事实（ffprobe）、精确 seek（`SEEK_INSIDE_FRAME`）和确定性时钟；路径穿越与越界链接被拒绝。
- `render.mjs` 用 Playwright Chromium 逐帧截图，按 worker 数并行，ffmpeg 编码（优先 NVENC，失败回退 libx264），支持运动模糊、alpha、字幕烧录与 4K。
- `look.mjs` 是它真正的质量层：整片抽 12 帧，**打乱顺序画两遍**，比较哈希/块差异；同时检查页面异常、字体加载失败、缺失音频、文字被裁切、轨道重叠、片段中点纯色、字幕/音频响度。`look` 输出 PNG 和可读警告，agent 在 `render` 前先看这些结果。
- `studio/server/server.mjs` 是编辑器服务：两个 origin（编辑器 API 与只读影片），启动 key、cookie、WebSocket 事件、撤销式版本历史（`.film/history` 里的 git）、导出、素材代理、字幕、provider、skills。版本历史按项目文件闭包保存，媒体按内容存副本，避免把大文件塞进 git。

### 3.3 agent 集成

- 仓库里**几乎没有 LLM 代码**。`MANUAL.md` 与 `skills/openfilm/SKILL.md` 是给宿主 coding agent 的手册；agent 直接写/改 `film.html` 和页面，Studio 负责让人继续手改。
- `openfilm skills` 提供 `keynote`、`long-to-short`、`motion-graphics`、`screen-demo`、`whiteboard` 等工艺文件；它们教 agent 怎么排片，不是运行时模型。
- 优势：agent 与编辑器共享同一文档，人的修改不会被 agent 覆盖；劣势：agent 必须会写网页，且没有语音理解。

### 3.4 关键函数索引

| 文件 | 关键函数/常量 | 作用 |
|---|---|---|
| `packages/openfilm/src/film-doc.mjs` | `readFilmFile`、`filmHtml`、`clipSpan`、`pictureRect`、`fadeGain` | 唯一读写 film.html；计算片段在源/输出上的时间与画面矩形 |
| `packages/openfilm/src/timeline.mjs` | `draw`、`drawClip`、`load`、`showVideoAt`、`change` | 浏览器内的播放/编辑 runtime；精确 seek 视频帧；原地改时间线 |
| `packages/openfilm/src/host.mjs` | `folderFiles`、`FILM_CLOCK`、`SEEK_INSIDE_FRAME`、`mediaFacts` | 只读服务项目文件夹；注入确定性时钟、随机种子、seek 修正 |
| `packages/openfilm/src/render.mjs` | `render`、`defaultWorkers`、`chipFormat`、`encode` | Playwright 逐帧截图 + ffmpeg 编码；硬件编码回退 |
| `packages/openfilm/src/look.mjs` | `look`、`draw`、`compare`、`checkCuts`、`checkOverlaps` | 抽帧乱序双画、块差异、切点/重叠/文字检查 |
| `packages/openfilm/studio/server/server.mjs` | `startStudio`、`route` | 双 origin、key 鉴权、WebSocket、项目/导出/设置路由 |
| `packages/openfilm/studio/server/history.mjs` | `saveVersion`、`checkoutVersion`、`log` | 以 `.film/history` git 仓库保存版本 |
| `packages/openfilm/studio/server/exports.mjs` | `createExports`、`encoding` | 视频/GIF/音频/静帧/字幕/PPT/NLE 导出 |

### 3.5 对 Pimko 的启示

**可借用**

- 单一工程文档 + 单一读写器：Pimko 的 `ProjectRevision` 也应该有唯一序列化/反序列化与渲染读取路径。
- 逐帧/逐切点自检：把 `look` 的"同 t 两遍、乱序、抽帧、检查错误"迁移到 Pimko 的输出切点。
- 给人看的检查结果：不要只返回成功/失败，返回时间点、前后文、失败原因和证据路径。
- agent 手册/技能与运行时分离：Pimko 的 LLM prompt 也应只描述可用的类型化操作，不直接教 ffmpeg flag。

**不应照搬**

- 不把 `film.html` 作为 Pimko 的核心工程格式。语音驱动素材的事实源是词级转写与源时间，无语音素材的事实源是镜头/节拍与画面变化；HTML 页面模型无法直接表达这些剪辑约束。
- 不引入 Chromium 逐帧渲染作为主路径。Pimko 已有 ffmpeg 渲染；为了短视频剪辑引入 100MB 浏览器和软件 WebGL 只会放大问题。
- 不让 LLM 每次生成网页代码。Pimko 的第一用户不会调试 HTML/CSS。

## 4. video-use 实现拆解

### 4.1 管线

`SKILL.md` 把流程写成：

```text
Transcribe → Pack → LLM Reasons → EDL → Render → Self-Eval
```

- `helpers/transcribe.py`：ElevenLabs Scribe 词级时间戳、说话人、音频事件；缓存原始 JSON。
- `helpers/pack_transcripts.py`：把多段素材压成 `takes_packed.md`，每行是短语级时间范围，LLM 只读这个文本，不读原始帧。
- `helpers/render.py`：按 EDL 逐段抽取 → `-c copy` 拼接 → 叠加动画 → **字幕最后叠加**；每段边界加 30ms 音频淡入/淡出；支持 loudnorm、HDR/竖屏探测、固定输出帧率。
- 自检：在**渲染输出**的每个切点 ±1.5s 抽 `timeline_view`，看跳变、爆音、字幕遮挡、overlay 错位；最多修 3 轮。还要求用 `ebur128` 测响度，不能靠"听不到"报告成功。
- `SKILL.md` 的 12 条硬规则把生产正确性（不切词、边距、字幕最后、输出时间轴 SRT、缓存转写、策略确认）与审美自由分开。

### 4.2 关键函数索引

| 文件 | 关键函数 | 作用 |
|---|---|---|
| `helpers/transcribe.py` | Scribe 请求 | 词级时间戳、说话人、音频事件，按源缓存 |
| `helpers/pack_transcripts.py` | `group_into_phrases`、`pack_one_file` | 把原始 JSON 压成短语级 `takes_packed.md` |
| `helpers/render.py` | `extract_all_segments`、`concat_segments`、`build_master_srt`、`build_final_composite`、`apply_loudnorm_two_pass` | 逐段抽取、无损拼接、输出时间轴字幕、最后叠加、响度归一 |
| `helpers/timeline_view.py` | filmstrip + waveform | 只在决策点调用，不扫全片 |
| `helpers/grade.py` | `auto_grade_for_clip`、`apply_grade` | 按段调色，避免拼接后二次编码 |

### 4.3 对 Pimko 的启示

**直接可迁移**

- EDL schema：`sources` + `ranges` + 可选 `grade`/`overlays`/`subtitles`；Pimko 的 `EditPlan` 应收缩成这个形状。
- 每个切点吸附词边界，保留 30–200ms 边距；不要把"删多少秒"直接交给 LLM 的自由裁量。
- 逐段抽取 + 无损拼接，避免整片 filtergraph 二次编码。
- 字幕按输出时间轴重建，最后叠加；变速后重新计算字幕时间。
- 自检必须看渲染结果，不看源素材；最多 3 轮，失败要报告而不是无限循环。

**Pimko 需要补的**

- video-use 没有本地 GUI、编辑器和修订链；Pimko 的 `Editor` + `ProjectRevision` 应保留，把 EDL 作为修订内容，而不是把 agent 当唯一入口。
- video-use 依赖 ElevenLabs；Pimko 已有 OpenAI/Groq/OpenRouter 路径，应把 `Transcriber` 保持在端口后面。
- video-use 的 agent 流程是"先确认策略再执行"；Pimko 的对话循环可以更轻，但每轮必须展示 diff 与切点证据。

## 5. auto-editor 实现拆解

- 输入按音频响度（或 motion）打整数 label：`0` 静音、`1` 活跃；`--edit` 定义什么算 1，`-w:0/-w:1` 定义每个 label 的动作（cut/keep/speed），`--margin` 在切点前后保留呼吸。
- 它不推理语义，也不理解口癖；但它把"先把死空间剪掉"做成确定性、可重复、极快的基线。README 明确把 label→action 作为核心模型。
- 本机合成测试：8s（两段 1.5s 声音）→ 3.47s；真实素材默认阈值几乎不剪，说明阈值与 margin 必须按素材/语言调，不能一套参数走天下。
- 对 Pimko：把 `--margin`、响度阈值、label→action 作为确定性预剪层；LLM 只决定"保留哪些语义片段/是否加速"，不直接决定每个静音的毫秒边界。

## 6. OpenChatCut 实现拆解（静态）

- 同栈：Electron + React + Remotion Player + 本地 ffmpeg；`src/editor/` 是 `EditorCore`，`src/agent/tools/` 是 agent 工具，`src/agent/skills/` 是技能，`src/transcript/` 是词级编辑。
- README 明确：内置 agent 与外部 MCP 共用同一套编辑工具和 `EditorCore`，不存在两套工程格式；agent 的编辑可追踪、可撤销；外部草稿准备期间不改正式时间线。
- 预览与导出、多轨、字幕、转场、导出到 FCPXML/SRT 都已产品化；`verify` 脚本数量很大，说明它把验证当一等公民。
- 许可 AGPL-3.0：只能学架构与交互，不复制代码。
- 对 Pimko：`Editor` 作为唯一命令层已经方向正确；需要补的是类型化工具注册表、提案式编辑（先预览 diff 再落盘）、以及把预览/渲染/导出统一到一个 job 模型。

## 7. kinocut 实现拆解

- 204+ 类型化 MCP 工具/CLI，覆盖 trim、字幕、重排、竖屏、音频、质检、release checkpoint；所有输出带 Video Receipt（操作、输入、输出、警告、下一步）。
- 核心价值是"guardrail"：不猜 ffmpeg flag、预检、输出路径保护、质量闸门、人类可读的回执。
- 风险是工具面过大：205 个工具对 Pimko 这种单用户短视频产品是负担。Pimko 应只保留少量领域动词（建稿、修订、撤销、预览、导出、配乐），把细节藏在服务里。
- 可借用：receipt 结构、quality gate、失败后的下一步命令；不借用其全量工具目录。

## 8. 横向对比

| 维度 | openfilm | video-use | auto-editor | OpenChatCut | kinocut |
|---|---|---|---|---|---|
| 核心模型 | film.html + `frame(t)` 页面 | packed transcript + EDL | 响度/motion label + action | 多轨工程 + EditorCore | 类型化 FFmpeg 工具 |
| 谁做剪辑决策 | 宿主 coding agent 写页面 | 宿主 agent 读转写选 EDL | 确定性算法 | 内置/外部 agent 经工具 | 调用方 agent |
| 口播理解 | 无 | 强（词级、停顿、说话人） | 弱（只看响度） | 强（转写/词级编辑） | 弱到中（工具层） |
| 质量验证 | 逐帧双画、字/音频/重叠检查 | 切点抽帧 + 响度 + 3 轮自检 | 快速确定性输出 | 大量 verify、可撤销 | receipts + release gate |
| 运行时 | Chromium + ffmpeg | Python + ffmpeg | Nim 单二进制 | Electron + Remotion + ffmpeg | Python + ffmpeg |
| 与 Pimko 的匹配 | 中：学验证/文档，不学内容模型 | **高** | **高（基线层）** | 高（架构） | 中（guardrail） |
| 许可 | MIT | MIT | Unlicense | AGPL（只学设计） | Apache-2.0 |

## 9. 对 Pimko 的决策输入

### 9.1 问题诊断

Pimko 已经具备：词级转写、静音分析、按段变速、修订链、ffmpeg 渲染、预览缓存、MCP。缺的不是功能数量，而是：

- **没有确定性基线**：LLM 直接产出完整时间线，错误会整体传播。
- **没有切点级验证**：导出只查时长/分辨率，切词、爆音、字幕遮挡不可见。
- **没有固定基准**：无法判断一次修改是变好还是变坏。
- **没有把"编辑决策"与"渲染实现"分开**：`EditPlan` 既承载语义又承载时间线细节。

### 9.2 推荐路线

**保留**：`Editor` 命令层、`ProjectRevision` 修订链、`Transcriber`/`SilenceAnalyzer`/`Renderer` 端口、MCP、Electron UI。

**替换/新增**：

1. `EditPlan` 收缩为 EDL：源、范围、速度、理由；语音边界由本地词级校验器吸附，无语音边界由镜头/节拍检测器吸附。
2. 新增确定性 first-pass：auto-editor 式响度/margin + ffmpeg 镜头边界，作为 LLM 之前的基线，也是 LLM 失败时的 fallback。
3. 语音素材新增 packed transcript；无语音/弱语音素材把镜头、节拍、响度、画面变化打包成素材摘要，减少 token 与幻觉。
4. 新增 render self-eval：按输出切点抽帧 + 波形 + 字幕 + 镜头连续性检查，最多 3 轮。
5. 新增 receipt/diff：每个修订带切点证据、失败原因、下一步；GUI 与 MCP 共用。
6. 用 openfilm 的"单一读写器"约束：时间线 JSON 的读取、渲染、预览、MCP 只能走同一实现。

**不采用**：openfilm 的 `film.html`、页面 `frame(t)`、Chromium 逐帧合成作为 Pimko 主路径；OpenChatCut 的 AGPL 代码；kinocut 的 205 工具全景。

## 10. 未验证与限制

- openfilm 本机测试 1321 项：1314 通过、1 失败（skills provenance 的跨文件系统移入回收站）、6 跳过；不能声称全绿。
- openfilm 的 `look`/`render` 在软件 WebGL 下运行；GPU 环境下的画面可能不同。
- OpenChatCut 依赖安装被 `EALLOWREMOTE`（远程 tarball 被 npm 禁用）拦截，未启动；只读了 README 与源码目录，运行时行为未验证。
- auto-editor 只验证了合成/真实素材的命令行输出，没有评估语义正确性。
- 所有运行只证明"管线可用"，不证明"成片好看"；主观质量仍需固定素材 + 人工盲评。
