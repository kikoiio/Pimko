# 测试素材

两类素材,都不入库(`sample-assets/` 已在 .gitignore):

| 目录 | 来源 | 需要网络 | 用途 |
|------|------|----------|------|
| `sample-assets/fixtures/` | 脚本合成(ffmpeg + flite) | 否 | 确定性回归:尺寸/比例/音轨/停顿/边界 |
| `sample-assets/public/` | 公开授权素材下载 | 是 | 真实语料:中文/英文口播转写 |

```bash
npm run fixtures        # 生成合成测试集(含 manifest.json 期望值)
npm run samples         # 下载公开素材(含许可证与哈希记录,已存在则跳过;--force 重下)
npm run check:fixtures  # 跑管线断言:探测→静音分析→建稿→导出→尺寸校验
npm run check:fixtures -- --transcribe   # 额外走真实转写(需 .env 配 Groq Key)
```

`check:fixtures` 的 `--only a,b` 可只跑指定素材;`--transcribe` 会检查词级时间戳、英文素材的
口癖检出,中文素材还要求识别出汉字。`samples` 同样支持 `--only`(按样例 id,便于只刷新
单个来源)。

## 合成测试集

全部由 `scripts/make-fixtures.ts` 生成,同一 ffmpeg 版本下结果稳定。

| 素材 | 规格 | 覆盖点 |
|------|------|--------|
| `talking-head-en.mp4` | 640×360@30, 15.6s | 口播基线:句中 um/uh 口癖(真实转写可检出) + 1.2/0.9/1.6s 停顿 |
| `portrait-en.mp4` | 720×1280@30, 15.6s | 竖屏比例,导出不得变形 |
| `odd-dims-en.mkv` | 641×361@25, FFV1/yuv444p | 奇数尺寸 → 导出取偶(642×362) |
| `long-pauses.mp4` | 960×540@30, 13s | 2.5/3/2.5s 长停顿 → 压缩提案 |
| `silent-track.mp4` | 480×270@30, 8s | 有音轨但全静音 |
| `no-audio.mp4` | 480×270@30, 5s | 无音轨 → 友好中文报错 |
| `short-0.8s.mp4` | 320×180@30, 0.5s | 极短素材边界 |

语音由 ffmpeg 的 `flite` 滤镜合成(需要带 libflite 的系统 ffmpeg;静态 ffmpeg-static 不带)。找不到时自动回退为音调占位,结构与时长不变,但词级内容测试会失效。

## 公开素材

由 `scripts/fetch-samples.ts` 下载,记录在 `sample-assets/public/manifest.json`(含 sha256、时长、许可证)。

| 文件 | 样例 id | 来源 | 许可证 | 用途 |
|------|---------|------|--------|------|
| `sintel-trailer.mp4` (854×480, 52s) | `sintel-trailer` | [Blender Foundation / Sintel](https://media.w3.org/2010/05/sintel/trailer.mp4) | CC BY 3.0 | 有对白的真实剪辑素材 |
| `big-buck-bunny-10s.mp4` (640×360, 10s) | `big-buck-bunny-10s` | [test-videos.co.uk](https://test-videos.co.uk/bigbuckbunny/mp4-h264) | CC BY 3.0 | 快速渲染/比例回归 |
| `zh-speaking-portrait.mp4` (720×1280, 45s) | `zh-speech` | [台北市长中文演讲音频](https://commons.wikimedia.org/wiki/File:2008TourDeTaiwan_Stage8_Speech_by_Taipei_City_Mayor_in_Chinese.ogg), Rico Shen (BrockF5) | CC BY-SA 4.0 | 中文口播转写 + 竖屏 |
| `en-speaking.mp4` (854×480, 30s) | `en-speech` | [JFK Berlin address](https://commons.wikimedia.org/wiki/File:Jfk_berlin_address_high.ogg) | Public domain | 英文口播转写 |

注意:

- `zh-speaking-portrait.mp4` 与 `en-speaking.mp4` 是**公开音频 + 合成测试画面**合流,不是原始视频画面;转写与剪辑逻辑测试有效,画面美观度测试请用原片。
- 中文演讲的源 Ogg 是分链文件,时间戳有断点:直接 `-t` 截取会让音轨只剩开头一两秒。`fetch-samples` 先完整解码为连续时间戳的 WAV 再截取,并校验成片音轨时长,避免「视频 45s、音频 1.7s」的坏素材。
- CC BY / CC BY-SA 素材再分发时需保留署名与许可;这些文件只用于本地/CI 测试,不入库、不随产品分发。
- 下载走 HTTPS 且校验最终尺寸/时长/哈希;失败会直接报错,不会静默生成坏文件。
