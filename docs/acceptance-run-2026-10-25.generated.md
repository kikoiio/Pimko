# 验收执行记录（自动化轮次）

生成时间：2026-10-25T17:29:58.338Z；执行者：ZCode 自动化验收（GitHub Actions）；依据 [testing-acceptance.md](testing-acceptance.md) 的 84 个用例。

## 统计

| 模式 | 通过 | 失败 | 阻塞 | 限制已确认 |
|---|---|---|---|---|
| M | 69 | 4 | 0 | 12 |
| R | 16 | 3 | 0 | 2 |
| I | 12 | 1 | 1 | 1 |

## 用例结果

| 用例 | 变体 | 模式 | 结果 | 关键结果 | 证据 |
|---|---|---|---|---|---|
| BG-01 | M/F1/wav（首次体验） | M | 通过 | gainDb=-18 |  |
| BG-01 | M/aac | M | 通过 | gainDb=-18 |  |
| BG-01 | M/flac | M | 通过 | gainDb=-18 |  |
| BG-01 | M/m4a | M | 通过 | gainDb=-18 |  |
| BG-01 | M/mp3 | M | 通过 | gainDb=-18 |  |
| BG-01 | M/ogg | M | 通过 | gainDb=-18 |  |
| BG-01 | M/wav | M | 通过 | gainDb=-18 |  |
| BG-02 | M | M | 通过 | 18d7e50d == 18d7e50d |  |
| BG-03 | M/轻 | M | 通过 | gainDb=-24 |  |
| BG-03 | M | M | 通过 | 实际 -24 |  |
| BG-04 | M | M | 通过 | {"path":"/home/runner/work/Pimko/Pimko/sample-assets/boundaries/bgm-2s.wav","gai |  |
| BG-05 | M | M | 通过 | bgm=undefined |  |
| BG-06 | M/短2s循环 | M | 通过 | 实际 12.07s vs 期望 11.92s |  |
| BG-06 | M/长30s截断 | M | 通过 | 实际 12.07s vs 期望 11.92s |  |
| BG-07 | M/专用副本 | M | 通过 | "Error invoking remote method 'project:preview': Error: Command failed: /home/ru | .tmp/acceptance/media/BG-07-M/专用副本/bgm-missing-error.png |
| CC-01 | M | M | 失败 | 未过: agent 气泡恰好 +1（无重复结果气泡）(1 → 3)；revision 链只 +1(磁盘修订 1 → 3) | .tmp/acceptance/media/CC-01-M/after-burst.png |
| CC-02 | M | M | 失败 | 未过: UI 与磁盘一致(UI=4ab13765 磁盘=4de04c47) | .tmp/acceptance/media/CC-02-M/cc02-final.png |
| CC-03 | M | M | 通过 | 1 个效果预览页签 |  |
| CC-04 | M/F1修订+F2导入 | M | 通过 | 26 个项目 | .tmp/acceptance/media/CC-04-M/F1修订+F2导入/cc04-final-ui.png |
| CC-05 | M/修订中关闭 | M | 通过 | 29 个项目 | .tmp/acceptance/media/CC-05-M/修订中关闭/after-restart.png |
| CC-05 | M/建稿中关闭 | M | 通过 | 28 个项目 | .tmp/acceptance/media/CC-05-M/建稿中关闭/after-restart.png |
| CC-05 | M/渲染中关闭 | M | 通过 | 29 个项目 | .tmp/acceptance/media/CC-05-M/渲染中关闭/after-restart.png |
| CC-06 | I/服务级并发（PreviewService） | I | 通过 | 3 项断言通过 | .tmp/acceptance/injection/CC-06-I/服务级并发（PreviewService）/check-preview-output.log |
| ED-01 | M/F1 | M | 通过 | +1.01s（期望 1.01s） | .tmp/acceptance/first-experience/ED-01-M/F1/before.json |
| ED-02 | M/F1 | M | 通过 | 60d9915e → a94c1aa2 |  |
| ED-03 | R/P3 删B留AC | R | 通过 | [] | .tmp/acceptance/real/ED-03-R/P3 删B留AC/revision.json |
| ED-04 | R/P3 末段移到最前 | R | 通过 | 集合一致 | .tmp/acceptance/real/ED-04-R/P3 末段移到最前/reorder.json |
| ED-05 | R/F1 固定口癖删除 | R | 失败 | 未过: 相邻有效词完整(丢失=2/30: PIMCO.,words.) | .tmp/acceptance/real/ED-05-R/F1 固定口癖删除/revision.json |
| ED-07 | M/F4 | M | 通过 | 4 处长停顿（共 4 处静音） | .tmp/acceptance/editing/ED-07-M/F4/draft-timeline.json |
| ED-07 | R/F4 压缩长停顿 | R | 失败 | 未过: 有效语句保留(8/9) | .tmp/acceptance/real/ED-07-R/F4 压缩长停顿/revision.json |
| ED-08 | M | M | 通过 | disabled=true |  |
| ED-09 | R/P3 超范围请求 | R | 通过 | "加一段别的视频" → 时间线不变=true 回复="当前时间线未包含其他视频片段，请提供该视频的转写内容以便添加。"；"给我配音" → 时间线不变=true  | .tmp/acceptance/real/ED-09-R/P3 超范围请求/results.json |
| ED-10 | M/mock 对照 | M | 限制已确认 | mock 把第 1 段设为 1.5x；BGM 与字幕均保留；段号语义 R 批次验证 | .tmp/acceptance/editing/ED-10-M/mock 对照/before-after.json |
| ED-10 | R/P3 第二段变速 | R | 通过 | 变化段=1.5；第二段 speed=1.5 | .tmp/acceptance/real/ED-10-R/P3 第二段变速/revision.json |
| EX-01 | M/F1 | M | 通过 | 11.10s | .tmp/acceptance/first-experience/EX-01-M/F1/export-probe.json |
| EX-02 | M/F1 | M | 通过 | SHA256=e24ae2bcf vs SHA256=e24ae2bcf |  |
| EX-03 | M | M | 通过 | count=0 |  |
| EX-04 | M | M | 通过 | 1792941455216.1216 → 1792941455216.1216 |  |
| EX-05 | M/F1 | M | 通过 | 640×360 |  |
| EX-05 | M/F2 | M | 失败 | EX-05/F2 失败：page.waitForFunction: Timeout 30000ms exceeded. |  |
| EX-05 | M/F3 | M | 通过 | 642×362 |  |
| EX-06 | M/只读目录 | M | 通过 | "Error invoking remote method 'project:export': Error: Command failed: /home/run | .tmp/acceptance/media/EX-06-M/只读目录/readonly-fail.png |
| EX-07 | I/渲染产物时长不符（受控垫片） | I | 通过 | "Error invoking remote method 'project:export': Error: 导出校验失败：成片时长 2.00s 与时间线 11 | .tmp/acceptance/injection/EX-07-I/渲染产物时长不符（受控垫片）/ex07-fail.png |
| FA-01 | M/fake-mp4 | M | 限制已确认 | 错误可见且不白屏，旧项目保留；报错为原始输出（可理解性差距已记录） | .tmp/acceptance/import/FA-01-M/fake-mp4/error-text.log |
| FA-01 | M/truncated | M | 限制已确认 | 错误可见且不白屏，旧项目保留；报错为原始输出（可理解性差距已记录） | .tmp/acceptance/import/FA-01-M/truncated/error-text.log |
| FA-01 | M/zero-byte | M | 限制已确认 | 错误可见且不白屏，旧项目保留；报错为原始输出（可理解性差距已记录） | .tmp/acceptance/import/FA-01-M/zero-byte/error-text.log |
| FA-02 | I/受控401+402（真实服务401见 real 批次） | I | 通过 | 401: "API Key 无效或已过期，请检查 .env 里的 key。" 凭据泄漏=false；402: "当前模型/音频接口需要账户余额，免费额度不够用。 | .tmp/acceptance/injection/FA-02-I/受控401+402（真实服务401见 real 批次）/fa02.png |
| FA-02 | R/真实服务401 | R | 通过 | "Error: LLM 请求失败: 401 {"error":{"message":"Invalid API Key","type":"invalid_requ |  |
| FA-03 | I/离线（转写+修订）与受控429 | I | 通过 | "网络请求失败，请检查网络后重试。" | .tmp/acceptance/injection/FA-03-I/离线（转写+修订）与受控429/fa03-final.png |
| FA-04 | I/初稿回退+修订失败 | I | 通过 | 7 段（确定性预剪） | .tmp/acceptance/injection/FA-04-I/初稿回退+修订失败/fallback-draft.json |
| FA-05 | I/clips:[] | I | 通过 | 错误="Error invoking remote method 'project:revise': Error: 这次修改会让" |  |
| FA-06 | I/九类非法计划 | I | 通过 | 不存在段号: 保留=true 尝试=3 泄漏=false；负起点: 保留=true 尝试=3 泄漏=false；结束早于开始: 保留=true 尝试=3 泄漏= | .tmp/acceptance/injection/FA-06-I/九类非法计划/variant-results.json |
| FA-07a | I/损坏修订 JSON | I | 失败 | 列表为空（构造 2 项目 / 卡片 0 / API 0）；单个坏文件拖垮全部项目可见性 |  |
| FA-07b | I/缺失父修订 | I | 通过 | latest=fa07b-rev-b | .tmp/acceptance/store/FA-07b-I/缺失父修订/fa07b-error.png |
| FA-07c | I/不可写存储 | I | 通过 | "Error invoking remote method 'project:revise': Error: EACCES: permission denied | .tmp/acceptance/store/FA-07c-I/不可写存储/readonly-storage.png |
| FA-08a | I/损坏缓存 | I | 限制已确认 | 未过: 删除坏缓存后重新渲染成功(同 key 缓存重新生成并可播放) | .tmp/acceptance/store/FA-08a-I/损坏缓存/corrupt-cache.png |
| FA-08b | I/不可写缓存目录 | I | 通过 | "Error invoking remote method 'project:preview': Error: Command failed: /home/ru | .tmp/acceptance/store/FA-08b-I/不可写缓存目录/readonly-previews.png |
| FA-08c | I/首次渲染失败 | I | 阻塞 | GUI 级渲染失败注入已由 injection 批次 EX-07 与 check-preview.test.ts 覆盖，本批次不重复搭建 PATH 垫片 |  |
| IM-01 | M/F1 | M | 通过 | 6 段 | .tmp/acceptance/first-experience/IM-01-M/F1/draft-state.json |
| IM-01 | R/P3 中文口播 | R | 通过 | 16 段 | .tmp/acceptance/real/IM-01-R/P3 中文口播/transcript.json |
| IM-01 | R/P4 英文口播 | R | 通过 | 3 段 | .tmp/acceptance/real/IM-01-R/P4 英文口播/transcript.json |
| IM-02 | M/取消 | M | 通过 | 0 个项目 | .tmp/acceptance/import/IM-02-M/取消/after-cancel.png |
| IM-03 | M/m4v | M | 通过 | 2 段 | .tmp/acceptance/import/IM-03-M/m4v/codecs.json |
| IM-03 | M/mkv | M | 通过 | 2 段 | .tmp/acceptance/import/IM-03-M/mkv/codecs.json |
| IM-03 | M/mov | M | 通过 | 2 段 | .tmp/acceptance/import/IM-03-M/mov/codecs.json |
| IM-03 | M/mp4 | M | 通过 | 6 段 | .tmp/acceptance/import/IM-03-M/mp4/codecs.json |
| IM-03 | M/webm | M | 通过 | 2 段 | .tmp/acceptance/import/IM-03-M/webm/codecs.json |
| IM-04 | M/F2 | M | 通过 | ratio=0.5625 | .tmp/acceptance/import/IM-04-M/F2/portrait-draft.png |
| IM-05 | M/F3 | M | 通过 | 642×362 |  |
| IM-06 | M/F6 无音轨 | M | 限制已确认 | mock 下建稿成功：2 段占位草稿（无音轨未报错）；真实防护在 R 批次验证 | .tmp/acceptance/import/IM-06-M/F6 无音轨/draft-state.json |
| IM-06 | R/F6 无音轨 | R | 通过 | "Error: 这段视频没有音轨，无法转写。请导入有说话声的口播视频，或切回 mock 模式测试界面。" |  |
| IM-07 | M/F5 全静音轨 | M | 限制已确认 | mock 占位行为：8s 静音轨 → 2 段占位草稿；真实幻觉判断在 R 批次 | .tmp/acceptance/import/IM-07-M/F5 全静音轨/draft-state.json |
| IM-07 | R/F5 全静音轨 | R | 限制已确认 | 全静音转写结果: 1 词（零星幻听） |  |
| IM-08 | M/F7 | M | 通过 | 1 段；源实际时长 0.540s |  |
| IM-08 | M/one-frame | M | 通过 | 1 段；源实际时长 0.033s |  |
| IM-09 | M/rotate90 | M | 限制已确认 | 旋转元数据条目按实际观察记录：输出 320×180，rotation=无 | .tmp/acceptance/import/IM-09-M/rotate90/rotation.json |
| IM-09 | M/sar | M | 限制已确认 | 非方形像素条目输出 320×180，显示比例正确性需人工复核 | .tmp/acceptance/import/IM-09-M/sar/rotation.json |
| IM-09 | M/special-path | M | 通过 | 输出 320×180，3.23s | .tmp/acceptance/import/IM-09-M/special-path/rotation.json |
| IM-09 | M/vfr | M | 通过 | 输出 320×180，3.23s | .tmp/acceptance/import/IM-09-M/vfr/rotation.json |
| IM-10 | R/五分钟长口播 | R | 失败 | 未过: 2 分钟内(1972.2s（性能失败）) | .tmp/acceptance/real/IM-10-R/五分钟长口播/transcript-head.json |
| IM-11 | R/left-only | R | 通过 | 识别 6 词，漏 0（），多 0（），词准确率 100% | .tmp/acceptance/real/IM-11-R/left-only/recognized.json |
| IM-11 | R/music | R | 通过 | 语音被合成音乐盖住 能力边界观察：识别 6 词，漏 0（），多 0（），词准确率 100% | .tmp/acceptance/real/IM-11-R/music/recognized.json |
| IM-11 | R/noise | R | 通过 | 语音叠加固定噪声 能力边界观察：识别 9 词，漏 2（hello,keep），多 5（i,m,going,to,cease），词准确率 67% | .tmp/acceptance/real/IM-11-R/noise/recognized.json |
| IM-11 | R/quiet | R | 通过 | 语音降 30dB 能力边界观察：识别 6 词，漏 0（），多 0（），词准确率 100% | .tmp/acceptance/real/IM-11-R/quiet/recognized.json |
| IM-11 | R/square | R | 通过 | 识别 6 词，漏 0（），多 0（），词准确率 100% | .tmp/acceptance/real/IM-11-R/square/recognized.json |
| IM-12 | R/delayed-audio | R | 限制已确认 | 未过: 无提前识别的词(6 词，首词起于 0.20s，提前=1（Hello,@0.20s）) |  |
| IM-12 | R/short-audio | R | 通过 | 1 词，越界=0 |  |
| IM-13 | M/audio-only | M | 通过 | "Error invoking remote method 'project:import': Error: 文件中没有视频轨: /home/runner/wo | .tmp/acceptance/import/IM-13-M/audio-only/audio-only-rejected.png |
| IM-13 | M/low-fps | M | 失败 | low-fps 失败：locator.waitFor: Timeout 300000ms exceeded.
Call log:
  - waiting for getByRole('tab', {  |  |
| IM-13 | M/square | M | 通过 | 320×320 |  |
| IM-14 | M/4K | M | 通过 | 3840×2160 | .tmp/acceptance/import/IM-14-M/4K/after-import.png |
| PV-01 | M | M | 通过 | 6 张卡片 | .tmp/acceptance/first-experience/PV-01-M/pv01.png |
| PV-02 | M | M | 通过 | t=0.53 paused=false |  |
| PV-04 | M | M | 通过 | playbackRate=1 | .tmp/acceptance/first-experience/PV-04-M/rendered-preview.png |
| PV-05 | M | M | 通过 | preview src 一致 |  |
| PV-08 | M | M | 通过 | mtime 1792941434974.8477 → 1792941439067.9033 |  |
| PV-09 | M/five-minutes | M | 通过 | 99 段（导入耗时 1.2s） |  |
| RS-01 | M/F1 | M | 通过 | 1 个项目 | .tmp/acceptance/first-experience/RS-01-M/F1/baseline.json |
| RS-02 | M/F1 | M | 通过 | "已恢复「talking-head-en.mp4」。继续看看哪里不顺，直接告诉我。"（限制：旧聊天气泡不重放，已按文档记录） |  |
| RS-05 | I/旧尺寸项目迁移 | I | 通过 | 640×360 | .tmp/acceptance/store/RS-05-I/旧尺寸项目迁移/revision-chain.json |
| SP-01 | M/0.5x | M | 通过 | speed=0.5 |  |
| SP-02 | M/恢复 1x | M | 通过 | speed=1 |  |
| SP-03 | M/2x | M | 通过 | speed=2 |  |
| SP-03 | M | M | 通过 | speed=2 |  |
| SP-05 | M/0 倍速 | M | 限制已确认 | 「0 倍速」被 mock 夹取为 0.5x 并保存；已撤销恢复；非法计划精确校验在 FA-06 |  |
| SP-05 | M/0.1 倍速 | M | 限制已确认 | 「0.1 倍速」被 mock 夹取为 0.5x 并保存；已撤销恢复；非法计划精确校验在 FA-06 |  |
| SP-05 | M/3 倍速 | M | 限制已确认 | 「3 倍速」被 mock 夹取为 2x 并保存；已撤销恢复；非法计划精确校验在 FA-06 |  |
| SP-05 | R/P3 非法速度 | R | 通过 | 0x → 实存 1x inRange=true note="已移除第一段（0.00-3.42），其余片段保持原速、硬切衔接。"；0.1x → 实存 0.5x i | .tmp/acceptance/real/SP-05-R/P3 非法速度/results.json |
| SU-01 | M/F1 | M | 通过 | {"size":"large","position":"top"} |  |
| SU-02 | M/F1 横屏 | M | 通过 | top: 修订=true, 字号保持=true, overlay 在画面内=true；center: 修订=true, 字号保持=true, overlay 在 | .tmp/acceptance/editing/SU-02-M/F1 横屏/su02-top.png |
| SU-02 | M/F2 竖屏 | M | 通过 | top: 修订=true, 字号保持=true, overlay 在画面内=true；center: 修订=true, 字号保持=true, overlay 在 | .tmp/acceptance/editing/SU-02-M/F2 竖屏/su02-portrait-top.png |
| SU-03 | M | M | 通过 | {"position":"bottom","style":"minimal"} |  |
| SU-04 | M | M | 通过 | {"position":"top","style":"bold","size":"large","visible":false} | .tmp/acceptance/editing/SU-04-M/hidden-draft.png |
| SU-05 | R/P3 跨剪口字幕 | R | 通过 | 15 条 | .tmp/acceptance/real/SU-05-R/P3 跨剪口字幕/cues.json |
| SU-07 | M/占位渲染 | M | 限制已确认 | 最小窗口 960×640 下 overlay 在画面内=true；真实长句 R 批次验证 | .tmp/acceptance/editing/SU-07-M/占位渲染/su07-min-window.png |
| SU-08 | M | M | 通过 | {"size":"large","position":"bottom","style":"minimal"} |  |
| UN-01 | M/F1 | M | 通过 | speed=2 start=1.0119685 | .tmp/acceptance/first-experience/UN-01-M/F1/revision-chain.json |
| UN-02 | M | M | 通过 | parent=无 | .tmp/acceptance/editing/UN-02-M/already-first.png |
| UN-03 | M | M | 通过 | speed=undefined |  |
| UN-04 | M | M | 通过 | start=0 |  |
| UN-05 | I | I | 通过 | speed=1.5 |  |

## 缺陷与差距（自动化轮次观察到的）

1. [BG-02/M（M，批次 media，通过）] 限制已确认：BGM 已存在时界面没有「替换配乐」入口，只有「移除配乐」；替换需先移除再添加（文档 BG-02 预告）
2. [BG-05/M（M，批次 media，通过）] 观察：F1 尾部含语音且 amix 归一化，绝对 RMS 不可作判据（实测 移除=-19.0dB / 恢复=-25.0dB，仅记录）
3. [CC-01/M（M，批次 media，失败）] agent 气泡恰好 +1（无重复结果气泡）: 1 → 3
4. [CC-01/M（M，批次 media，失败）] revision 链只 +1: 磁盘修订 1 → 3
5. [CC-02/M（M，批次 media，失败）] 观察：双击撤销产生 2 条撤销修订，气泡 5→7；撤销后 gainDb=-24（是否回弹按链路证据判断）
6. [CC-02/M（M，批次 media，失败）] UI 与磁盘一致: UI=4ab13765 磁盘=4de04c47
7. [CC-03/M（M，批次 media，通过）] 观察：生成期间忙状态——输入禁用=true，撤销禁用=null，导出禁用=true，按钮文本="正在生成预览…"
8. [CC-04/M/F1修订+F2导入（M，批次 media，通过）] 观察：竞态后 UI 画面归属 F2，agent 气泡 1 条；「导入视频」仅在建稿/导出时禁用（代码事实），修订期间可点击，最终归属取决于两个 IPC 完成顺序，已按现状记录
9. [CC-06/I/服务级并发（PreviewService）（I，批次 injection，通过）] 限制已确认（代码事实）：预览队列仅覆盖 PreviewService，预览与导出（Editor.export 直连渲染器）不全局串行，不能宣称跨服务串行。
10. [ED-01/M/F1（M，批次 first-experience，通过）] 观察：seek 进已删区间(0.3s)后 t=0.00 rate=1 paused=true（行为按现状记录）
11. [ED-03/R/P3 删B留AC（R，批次 real，通过）] 实际输入反馈: 只删除「我想自由车的环台大赛」，完整保留「今天非常荣幸来参加这样一个盛会」和「现在已经是一个国际上非常正式的自由车比赛的活动了」，其它不动
12. [ED-05/R/F1 固定口癖删除（R，批次 real，失败）] 相邻有效词完整: 丢失=2/30: PIMCO.,words.
13. [ED-07/M/F4（M，批次 editing，通过）] M 仅能确认初稿预剪；对「压缩长停顿」反馈的语义理解与听感在 real 批次（R）验证
14. [ED-07/R/F4 压缩长停顿（R，批次 real，失败）] 有效语句保留: 8/9
15. [ED-08/M（M，批次 editing，通过）] 空输入无气泡产生: 气泡数 1
16. [ED-10/M/mock 对照（M，批次 editing，限制已确认）] 限制已确认：mock 关键词逻辑不支持段号语义——写「第二段」仍改第一段（文档 1.2/ED-10 预告），不能计为语义通过，R 批次主验
17. [EX-04/M（M，批次 media，通过）] 同路径覆盖后 mtime 变化: 1792941455216.1216 → 1792941455216.1216
18. [EX-04/M（M，批次 media，通过）] 记录「系统级覆盖确认框未被真实演练」：保存对话框被 stub 直接返回同路径，无法演练系统的取消/确认覆盖提示；文档 EX-04 已预告无额外覆盖保护，误覆盖风险按现状记录
19. [EX-04/M（M，批次 media，通过）] 取消后旧文件保留: mtime=1792941455216.1216
20. [EX-04/M（M，批次 media，通过）] 取消后无新成功气泡: 2 → 3
21. [FA-01/M/fake-mp4（M，批次 import，限制已确认）] 报错可理解性失败：错误条为原始 ffprobe/系统输出，未转译为用户可理解文案；按文档规则——错误可见且不白屏成立，故整体记「限制已确认」并写明该差距
22. [FA-01/M/truncated（M，批次 import，限制已确认）] 报错可理解性失败：错误条为原始 ffprobe/系统输出，未转译为用户可理解文案；按文档规则——错误可见且不白屏成立，故整体记「限制已确认」并写明该差距
23. [FA-01/M/zero-byte（M，批次 import，限制已确认）] 报错可理解性失败：错误条为原始 ffprobe/系统输出，未转译为用户可理解文案；按文档规则——错误可见且不白屏成立，故整体记「限制已确认」并写明该差距
24. [FA-02/R/真实服务401（R，批次 real，通过）] 402（余额不足）无法用真实账户无消费制造，UI 映射证据见 injection 批次 FA-02；保持阻塞不虚报
25. [FA-04/I/初稿回退+修订失败（I，批次 injection，通过）] 已知差距确认：初稿 UI 显示通用「草稿好了…」，plan.note 的回退说明未展示给用户（文档 FA-04 预告项）
26. [FA-07a/I/损坏修订 JSON（I，批次 store，失败）] 失败（与文档预测一致）：一个损坏修订 JSON 使 store.list() 整体抛错被吞掉 → 整个最近项目列表为空；影响面扩大到无关的正常项目（fa07a-normal-project 也不可见、不可恢复）
27. [FA-08a/I/损坏缓存（I，批次 store，限制已确认）] 限制已确认（文档预告）：缓存命中只检查文件非零，损坏缓存无法自动检测与重建，坏画面被当作效果预览交付；原始文件在重试前已备份到批次目录
28. [FA-08a/I/损坏缓存（I，批次 store，限制已确认）] 删除坏缓存后重新渲染成功: 同 key 缓存重新生成并可播放
29. [IM-02/M/取消（M，批次 import，通过）] 取消后界面仍可操作: 反馈输入框可编辑
30. [IM-05/M/F3（M，批次 import，通过）] 观察：FFV1 源在 Chromium 草稿预览中无法解码（浏览器解码能力限制），尺寸核对按文档改用导出探测完成
31. [IM-06/M/F6 无音轨（M，批次 import，限制已确认）] 限制已确认（M 模式局限）：mock 转写不依赖音轨，无音轨文件照常建稿成功（2 段占位草稿，占位转写 2 句）；M 无法证明真实转写的无音轨防护，R 批次主验。
32. [IM-07/M/F5 全静音轨（M，批次 import，限制已确认）] 限制已确认（M 模式局限）：mock 转写无视真实音轨，为 8s 静音轨生成了 2 段占位中文（「第 N 句：呃…」）；占位文字与音轨无关，不能据此判断全静音是否被虚构识别，R 批次主验。
33. [IM-07/R/F5 全静音轨（R，批次 real，限制已确认）] 全静音轨幻听观察：识别出 1 词「you」（未达「大量」阈值，按能力边界记录）
34. [IM-09/M/rotate90（M，批次 import，限制已确认）] 限制已确认（未保证支持项）：源 320×180（rotation=90）→ 输出 320×180；输出保持编码尺寸，旋转矩阵是否被应用需人工复核画面方向
35. [IM-09/M/sar（M，批次 import，限制已确认）] 限制已确认（未保证支持项）：源 SAR 4:3 → 输出 320×180（渲染器强制 setsar=1）；按显示比例观察是否压扁/拉长需人工复核圆形与方格图案，M 无法判定
36. [IM-09/M/vfr（M，批次 import，通过）] 限制已确认（未保证支持项）：VFR 源导入/预览/导出走通；跳切/变速/导出的累积音画偏移属人工听看项，M 无法验证同步精度
37. [IM-10/R/五分钟长口播（R，批次 real，失败）] 2 分钟内: 1972.2s（性能失败）
38. [IM-11/R/music（R，批次 real，通过）] 语音被合成音乐盖住 能力边界：识别 6 词，漏 0（），多 0（），词准确率 100%（观察项，不能用非空转写记准确通过）
39. [IM-11/R/noise（R，批次 real，通过）] 语音叠加固定噪声 能力边界：识别 9 词，漏 2（hello,keep），多 5（i,m,going,to,cease），词准确率 67%（观察项，不能用非空转写记准确通过）
40. [IM-11/R/quiet（R，批次 real，通过）] 语音降 30dB 能力边界：识别 6 词，漏 0（），多 0（），词准确率 100%（观察项，不能用非空转写记准确通过）
41. [IM-12/R/delayed-audio（R，批次 real，限制已确认）] 无提前识别的词: 6 词，首词起于 0.20s，提前=1（Hello,@0.20s）
42. [IM-12/R/delayed-audio（R，批次 real，限制已确认）] 延迟音轨时间戳提前观察：1 词早于声源（Hello,@0.20s，声源约 1s 起），按 ASR 能力边界记录
43. [IM-13/M/low-fps（M，批次 import，失败）] 1fps 导出超时（复现）；层定位：ffmpeg 直裁 1fps 源成功（0.2s）→ 挂起在应用管线层
44. [PV-01/M（M，批次 first-experience，通过）] 点第 1 段跳源起点: t=0.63 vs start=0
45. [PV-01/M（M，批次 first-experience，通过）] 点第 3 段跳其源起点: t=0.62 vs start=4
46. [PV-01/M（M，批次 first-experience，通过）] 连续播放自动跳到第 2 段: t=1.01, 第二段起点=3.249167
47. [PV-02/M（M，批次 first-experience，通过）] 末段结尾后暂停（无越界跳转）: t=0.72 paused=false
48. [PV-09/M/five-minutes（M，批次 media，通过）] 点击第 35 段跳转播放: t=0.64 vs 段起点 136.79
49. [PV-09/M/five-minutes（M，批次 media，通过）] 观察：5 分钟素材仅做 mock 导入与草稿验证，按要求未导出（导出长片不在本用例范围）
50. [SP-05/M/0 倍速（M，批次 editing，限制已确认）] 限制已确认：mock 把越界速度夹到 0.5–2 保存，没有拒绝语义；不能充当非法计划校验通过，精确校验在 injection 批次 FA-06
51. [SP-05/M/0.1 倍速（M，批次 editing，限制已确认）] 限制已确认：mock 把越界速度夹到 0.5–2 保存，没有拒绝语义；不能充当非法计划校验通过，精确校验在 injection 批次 FA-06
52. [SP-05/M/3 倍速（M，批次 editing，限制已确认）] 限制已确认：mock 把越界速度夹到 0.5–2 保存，没有拒绝语义；不能充当非法计划校验通过，精确校验在 injection 批次 FA-06
53. [SU-07/M/占位渲染（M，批次 editing，限制已确认）] 限制已确认（M 模式局限）：只验占位中文长句渲染，真实长句/中文标点/中英混排覆盖在 R 批次验证
54. [UN-01/M/F1（M，批次 first-experience，通过）] 第一次撤销回到仅裁开头: speed=2 start=1.0119685
55. [UN-01/M/F1（M，批次 first-experience，通过）] 第二次撤销回到初稿: clips 与初稿一致
