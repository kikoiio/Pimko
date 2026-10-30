# 视频剪辑 Agent 产品与开源项目体验清单

调研日期：2026-10-26（America/New_York）。

本文归档本次会话的两轮搜索、产品链接和后续需求讨论，方便以后逐项体验。共收录 **30 个不同项目：20 个产品、9 个其他开源项目或集成工具、1 个暂不推荐的候选**。其中部分产品本身也开源，分类仅用于导航。

与 [2026-10-24 的先行研究](2026-10-24-agentic-video-editing-prior-art.md) 的区别：旧文侧重 Pimko 的技术与工具面；本文侧重现成产品、使用入口、YC 背景和普通用户的体验选择。

## 1. 调研性质与限制

- 第一轮主要查看官网和 GitHub；用户追问后，第二轮补查 Hacker News、Product Hunt、X 的公开搜索索引及 YC 官方目录。
- 本文是会话搜索结果归档，保存时未重新开展一轮搜索。下述功能、平台支持、YC 批次和入口反映会话中得到的信息，不代表未来持续有效。
- 未拿同一套素材进行横评；未安装、登录、付费、上传视频或完成实际剪辑。文中的优先级是体验建议，不能当作实测质量排名。
- 官网及创始人的功能描述属于产品声明；社区发布、YC 背景、开源身份都不能单独证明成片质量或稳定性。
- X 的帖子及讨论串公开索引有限，只能确认部分账号和线索，不能称为完整的 X 口碑调查。
- 免费额度、价格、模型 API 成本、操作系统支持和开源许可证，应在实际使用或二次开发前查看最新官方说明。没有把会话中的套餐价格当作长期承诺写入清单。

## 2. 用户的真实使用起点

用户表示：从未剪辑过，没有素材，不懂如何剪辑，也无法事先描述一个好视频应该是什么样。

因此，体验时优先检查以下能力：

1. 能否从一个简单主题开始，协助策划、找素材或生成素材，并交付第一版。
2. 能否提供合理默认值，避免要求用户先决定专业参数。
3. 能否理解“这里太久了”“字看不清”“音乐太吵”等普通反馈并完成修改。
4. 能否在成片后检查字幕、画面异常、音量和内容连贯性。
5. 是否能在支付前说明成本，并保留可继续修改的工程。

没有素材时，单纯的长视频切片器、口播清理器或底层 MCP 工具未必适合作为第一站。支持主题到成片的产品也仍需实际验证，不能假定所有标注 Agent 的产品都覆盖全流程。

## 3. 现成产品与入口

“主要方向”为会话中检索到的定位或官方声明，尚未实测。

| 产品 | 官方入口 | 主要方向与使用备注 |
| --- | --- | --- |
| Motion / Mosaic | [Motion](https://motion.so/) · [Mosaic](https://mosaic.so/) | 通用视频 Agent，涉及剪辑、视频理解和动态图形；会话中查到 Mosaic 当前主推产品名为 Motion。 |
| Cardboard | [官网](https://www.cardboard.ai/) | 素材和目标生成初剪，支持对话与时间线修改。网页版存在客户端渲染负载，不能等同于全部在云端处理。 |
| ChatCut | [官网](https://chatcut.io/) · [说明](https://chatcut.io/docs/what-is-chatcut) · [价格](https://chatcut.io/pricing) | 对话式多轨剪辑、转写文本剪辑、反复修改；会话中查到免费体验入口。 |
| Tellers | [官网](https://tellers.ai/) · [应用](https://app.tellers.ai/) | 结合用户素材、素材库与生成模型进行视频制作；有对话剪辑、MCP 和 API 的产品声明。 |
| Arsaze | [官网](https://www.arsaze.com/) | Agent 操作多轨时间线及 MCP 集成。最初访问失败，后续链接核实时已能访问；会话中查到网页及 Linux 版本信息。 |
| Descript / Underlord | [Underlord](https://www.descript.com/underlord) | 文本驱动剪辑、口播及播客后期、删口头禅与重录、音频处理。中文适用性未在本次完成实测。 |
| OpusClip / AI Producer | [官网](https://www.opus.pro/) | 长视频切短视频、找高光和竖屏重构。会话中 AI Producer 的说明限定单人口播、素材最长 5 分钟；不应把该限制套用到整个 OpusClip。 |
| invideo Editor | [编辑器介绍](https://invideo.io/ai-video-editor/) · [另一官方入口](https://invideo.io/make/ai-video-editor/) | 指令粗剪、素材检索、补充镜头、音效及自动成片。 |
| Vizard / Vizard Agent | [官网](https://vizard.ai/) · [Agent](https://agent.vizard.ai/) · [Agent 介绍](https://vizard.ai/blog/the-next-shift-in-ai-is-coming-to-video) | 长视频切片；Agent 方向还涉及从视频、图片、文档、脚本或网站开展视频创作。 |
| Captions | [官网](https://www.captions.ai/) · [AI Edit 文档](https://help.captions.ai/docs/project/ai-edit) | 口播及社交短视频，自动字幕、补充镜头、音乐、转场和对话修改。 |
| Kestroll | [官网](https://www.kestroll.com/) | 口播、播客、多机位剪辑及长视频切片。 |
| Wideframe | [官网](https://wideframe.com/) | 素材查找、标注、整理、编排和粗剪，与 Premiere 工程衔接。 |
| Clueso | [官网](https://clueso.io/) | 产品演示、教程及培训视频；Agent 方向包括操作产品录屏、配音、动效和剪辑。 |
| Overlap | [官网](https://www.overlap.ai/) | 视频检索、分析、寻找具体时刻、生成片段，偏素材库与媒体处理。 |
| Vyra | [官网](https://usevyra.com/) | 上传真实素材，通过聊天指导剪辑；会话中查到网页和 iOS 入口。 |
| Craze | [官网](https://www.craze.ai/) | 创作 Agent、素材生成、分镜、广告及时间线；有 MCP 集成声明。 |
| Palmier Pro | [官网与下载](https://www.palmier.io/) | 开源编辑器，供外部 coding agent 操作时间线和导出。会话中官网说明仅支持 macOS 26，不是当前 Ubuntu 的直接体验路径。 |
| Diffusion Studio | [官网与下载](https://www.diffusion.studio/) · [GitHub](https://github.com/diffusionstudio/editor) | 面向 Agent 的编辑器，代码与可视化工程同步；会话中官方下载列出 Mac / Windows，未确认 Ubuntu 安装路径。 |
| 剪映 / 剪映助手 / 小映 | [剪映官网](https://www.capcut.cn/) · [另一官方入口](https://lv.ulikecam.com/) | 中文剪辑、口播与解说粗剪；助手涉及对话剪辑、素材整理、字幕纠错和包装。不同版本的入口及能力需实际确认。 |
| 小云雀 | [官网](https://xyq.jianying.com/) | 中文视频创作、短剧和营销 Agent，含参考视频复刻及 Vlog 等创作方向。 |

### 商业 ChatCut 与 OpenChatCut 的区别

本次会话把 `chatcut.io` 的商业 ChatCut 与 `0xsline/OpenChatCut` 的开源项目列为独立项目。不要因为名字相似而混用账号、安装包或文档。

## 4. 其他开源项目、框架与集成工具

这部分通常需要安装、模型服务配置或已有素材；适合后续技术体验，不必作为零基础用户的起点。Palmier Pro 和 Diffusion Studio 已列在上一节，未重复计数。

| 项目 | 链接 | 会话检索到的定位与备注 |
| --- | --- | --- |
| FireRed-OpenStoryline | [GitHub / 安装说明](https://github.com/FireRedTeam/FireRed-OpenStoryline) | 素材理解、脚本、配乐、配音、对话修改和可复用 Skill；Apache-2.0。会话中查到 Linux、Web 界面及在线 Demo 说明；演示部分效果依赖额外字体、音乐等素材。 |
| OpenChatCut | [GitHub](https://github.com/0xsline/OpenChatCut) · [Releases](https://github.com/0xsline/OpenChatCut/releases) | 内置 Agent、多轨时间线、文本剪辑、字幕、特效和 MCP；AGPL。会话中查到 Linux AppImage；AI 功能需要配置相应服务，属于早期项目。 |
| FunClip | [GitHub / 使用说明](https://github.com/modelscope/FunClip) | 阿里通义语音团队的语音识别、按文本或说话人剪切、字幕及 LLM 辅助选片；MIT。偏访谈、课程、会议等已有语音素材。 |
| NarratoAI | [GitHub / 安装说明](https://github.com/linyqh/NarratoAI) | 影视解说文案、剪辑、配音和字幕。认准主仓库；本次不对许可证作最终判断。 |
| VideoDB Director | [GitHub](https://github.com/video-db/Director) | 视频 Agent 框架，涉及素材检索、高光、字幕和配音；依赖 VideoDB 服务，不等同于完全独立的离线免费工具。 |
| DaVinci Resolve MCP | [GitHub / 配置说明](https://github.com/samuelgursky/davinci-resolve-mcp) | 让 Agent 经达芬奇脚本 API 操作工程。使用前核对 Resolve 版本、系统支持和 Studio 授权要求。 |
| HKUDS VideoAgent | [GitHub](https://github.com/HKUDS/VideoAgent) | 视频理解与 Agent 研究方向；会话中查到 8GB 显存要求。与旧研究对其“理解型、非编辑”的分类存在表述差异，应以仓库实际支持的操作为准，不视为已验证的通用成片工具。 |
| OpenVids | [官网](https://openvids.ai/) · [GitHub](https://github.com/bazodev/open-vids) | 多 Agent 视频编辑、渲染后检查和修改回退。Product Hunt 发布者说明仍处早期；会话中查到 Mac / Windows 支持。 |
| RxFilm Studio | [GitHub / 项目入口](https://github.com/rxtech-lab/film-workflow) | 从网站、图片或已有素材制作产品视频的工作流，线索来自 Hacker News。 |

## 5. YC 背景核对入口

以下批次为本次会话从 YC 官方目录记录的信息。YC 身份用来补充公司背景，不作为成片效果或成熟度评分。

| 项目 | 会话记录的 YC 批次 | YC 官方目录 |
| --- | --- | --- |
| Cardboard | W26 | [公司页](https://www.ycombinator.com/companies/cardboard) |
| Mosaic / Motion | W25 | [公司页](https://www.ycombinator.com/companies/mosaic-2) |
| Palmier | S24 | [公司页](https://www.ycombinator.com/companies/palmier) |
| Diffusion Studio | F24 | [公司页](https://www.ycombinator.com/companies/diffusion-studio) |
| Kestroll | S25 | [公司页](https://www.ycombinator.com/companies/kestroll) |
| Wideframe | W26 | [公司页](https://www.ycombinator.com/companies/wideframe) |
| Clueso | W23 | [公司页](https://www.ycombinator.com/companies/clueso) |
| Overlap | S24 | [公司页](https://www.ycombinator.com/companies/overlap) |
| Vyra | F26 | [公司页](https://www.ycombinator.com/companies/vyra) |
| Craze | S22 | [公司页](https://www.ycombinator.com/companies/craze) |

## 6. 社区搜索来源与局限

### Hacker News

- [Cardboard 发布与讨论](https://news.ycombinator.com/item?id=47170174)：会话关注了浏览器兼容性、客户端渲染、渲染可靠性及如何评价初剪效果。
- [Palmier Pro 发布与讨论](https://news.ycombinator.com/item?id=47495570)：会话记录了创始人对粗剪能力、创意剪辑限制及平台支持的说明。
- [RxFilm Studio 线索](https://news.ycombinator.com/item?id=49815095)：从网站、图片或已有素材制作产品视频。
- 另搜索了 Mosaic 和 Diffusion Studio 的相关发布；本文没有为未保留精确讨论链接的条目补造 URL，也不使用热度分数作推荐依据。

### Product Hunt

- [Tellers](https://www.producthunt.com/products/tellers-ai)
- [Arsaze](https://www.producthunt.com/products/arsaze-ai-native-video-editor)
- [OpenVids](https://www.producthunt.com/products/openvids)
- [Rushilo](https://www.producthunt.com/products/rushilo)

Product Hunt 主要用于发现产品，再查看官网和仓库。发布页描述不等于当前官网仍提供对应功能。

### X

- [Diffusion Studio 官方账号](https://x.com/diffusionhq)
- 会话还找到了 Mosaic 联合创始人账号线索，但没有保存可可靠复用的具体 URL，本文不补造。
- 搜索范围是公开索引，不包含完整账号历史、登录后的全部内容或系统性的用户反馈采样。

## 7. 暂不推荐与会话勘误

### Rushilo：宣传与当前落地页不一致

- [官网](https://rushilo.com/)
- Product Hunt 曾以 Agent 视频编辑器介绍；会话后续打开官网，显示的是 AI 视频课程销售页。
- 在确认可实际使用的编辑器入口前，不建议为了体验视频剪辑产品而付费。

### 其他更正与待确认项

1. **Cardboard 网页版不等于全云端处理。** 第一轮曾建议用浏览器避开本机负载，后续 HN 信息显示存在客户端渲染，应保留本机资源预算。
2. **Arsaze 可达性后来已恢复。** 第二轮早期访问失败，整理链接时已能访问，不能沿用“官网打不开”的结论。
3. **Mosaic 与 Motion 名称并存。** 会话检索到官方于 2026-10-20 介绍 Motion；以两个官方站点当前的产品入口为准。
4. **开源不等于零成本。** 模型调用、转写、素材生成和托管服务可能收费；许可证也应逐仓库核对。
5. **网页不等于不占本机资源。** 对 Ubuntu 用户，仍需区分服务端处理与客户端渲染；未在本次实际测量各产品资源占用。

## 8. 建议的体验路线

以下是会话形成的候选顺序，不是实测排名，也不代表已经逐个确认适合无素材起步。

- **通用对话成片候选**：Motion、Cardboard、ChatCut、Tellers、Vyra、Arsaze。先确认能否自行找素材或生成素材，再尝试完整成片。
- **中文主题创作候选**：小云雀、剪映相关助手。需确认账号、地区、版本和入口。
- **有口播、播客或长视频后**：Descript、OpusClip、Kestroll、Vizard、FunClip。
- **软件演示或教程**：Clueso；产品宣传片还可考察 RxFilm Studio。
- **后续开源体验**：OpenStoryline、OpenChatCut 优先；其他项目按安装、平台、模型服务和硬件条件安排。

### 给零基础用户的首次体验提示词

> 我完全没剪辑经验，没有素材，也不会写剪辑要求。请承担策划、找素材、剪辑和检查的工作，带我完成第一条视频。
>
> 这次做一条 20 秒的中文竖屏短片，主题是“下班后的几个小幸福”，用于发给朋友看。
>
> 请先用一句话说明你准备讲什么，然后直接制作第一版，不要让我选择专业参数。
>
> 默认要求：
> - 用可合法使用的素材；缺少素材时，可以生成或替换镜头。
> - 画面可以包含回家路上的灯光、一顿热饭、舒服的房间。
> - 风格温暖、自然，字幕少而清楚，音乐轻一点。
> - 先用简单剪辑，不堆特效。
> - 如果某个功能需要额外付费，先说明价格，等我确认。
>
> 完成后，请检查字幕错误、画面异常、音乐是否盖住人声，以及内容是否连贯。告诉我你认为最需要改的一处，并说明原因。

第一轮只检查：能否理解内容、哪里想跳过或看着不舒服、是否愿意发给朋友。无法描述偏好时，让产品仅提供两个不同开头供比较，不必先学习专业术语。

## 9. 待实际体验后补充

当前尚无已完成的体验记录。后续建议逐项记录：

- 实际使用日期、产品版本、平台与套餐。
- 无素材起步是否成功，是否需要自行找素材或录音。
- 输入要求、首版输出、制作耗时和费用。
- 中文字幕、旁白和素材匹配情况。
- 第二轮自然语言修改是否正确执行，是否破坏其他内容。
- 是否可导出、是否带水印、能否保留或迁移工程。
- 本机资源占用、阻塞问题与最终是否愿意继续使用。
