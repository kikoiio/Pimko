# Pimko

对话式短视频剪辑 agent。第一用户是不懂剪辑的创作者：导入口播素材，用自然语言反馈，得到可直接发布的成片。

当前状态：M4「剪辑工具面扩展」——词级转写、确定性静音分析、口癖检测、按段变速、LLM 输出加固，以及本地 MCP 服务器（外部 agent 可驱动同一引擎）。领域模型与 ports 见 `docs/architecture.md`，需求与里程碑见 `docs/requirements.md`，先行调研见 `docs/research/`。

## 开发

```bash
npm install
npm run dev       # Electron 开发模式
npm run typecheck
npm run build
npm run smoke     # 端到端冒烟：草稿 → 修订 → 变速 → 导出
npm run smoke:mcp # MCP 冒烟：外部客户端经 stdio 驱动引擎闭环
npm run mcp       # 启动 MCP 服务器（供 Claude Code 等 agent 接入）
```

没有素材时可以生成测试视频（已加入 .gitignore，不会提交）：

```bash
mkdir -p sample-assets
ffmpeg -f lavfi -i 'testsrc=duration=15:size=640x360:rate=30' \
       -f lavfi -i 'sine=frequency=330:duration=15' \
       -c:v libx264 -pix_fmt yuv420p -c:a aac sample-assets/testsrc.mp4
```

带真实语音的素材（需要 ffmpeg 编译了 libflite，Ubuntu 仓库版默认带）：

```bash
ffmpeg -f lavfi -i "flite=text=Hello and welcome to Pimko. This is a test talking head video.:voice=slt" \
       -f lavfi -i 'testsrc=duration=8:size=640x360:rate=30' \
       -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac sample-assets/voice.mp4
```

## LLM 配置

复制 `.env.example` 为 `.env` 并填入 API Key。当前管线默认 `mock`，接入真实模型时把 `PIMKO_LLM_PROVIDER` 切到 `openai` 或 `anthropic`；`.env` 不会提交。

产品需求、验收标准和路线图见 [docs/requirements.md](docs/requirements.md)。

## 打包分发(Linux + Windows)

CI(`Release` 工作流)打云端全流程包,本机零负担:

- push tag `v*` 或手动 dispatch 触发;
- ffmpeg/ffprobe 静态二进制随包分发(`extraResources/bin`),**用户无需安装 ffmpeg**;
- 产物:Linux AppImage/deb + Windows NSIS 安装包,Artifacts 可下载。

本机打包(需要时):`npm run dist:linux` / `npm run dist:win`。

## 验证

推送和 PR 会自动跑 GitHub Actions(typecheck / build / smoke / mock UI E2E / 真实 LLM E2E),本机不承担测试负载。
```
