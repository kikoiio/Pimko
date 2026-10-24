# Pimko

对话式短视频剪辑 agent。第一用户是不懂剪辑的创作者：导入口播素材，用自然语言反馈，得到可直接发布的竖版成片。

当前状态：架构设计（`docs/architecture.md`）+ 项目骨架。领域模型与 ports 已定型，`Editor` 服务与 mock 基础设施为待实现的 stub。

## 开发

```bash
npm install
npm run dev       # Electron 开发模式
npm run typecheck
npm run build
npm run smoke     # 端到端冒烟：草稿 → 修订 → 导出
```

## LLM 配置

复制 `.env.example` 为 `.env` 并填入 API Key。当前管线默认 `mock`，接入真实模型时把 `PIMKO_LLM_PROVIDER` 切到 `openai` 或 `anthropic`；`.env` 不会提交。

## 验证

推送和 PR 会自动跑 GitHub Actions（typecheck / build / smoke），本机不承担测试负载。
```
