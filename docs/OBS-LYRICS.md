# OBS Lyrics

## 导入字体、互动挂件与弹幕歌词（2026-11-18）

- 下边栏「网页歌词」增加「导入字体」与「恢复默认字体」，导入后立即保存；设置页「OBS 透明歌词」也有同样入口，在预览确认后点击「保存设置」应用。
- 支持 TTF / OTF / WOFF / WOFF2，单个文件最大 20 MB。前端先用浏览器字体解码器检查，后端校验格式与大小，将原始字体复制到应用数据目录 `lyrics-fonts/`；持久设置只保存内容哈希文件名和显示名，不依赖导入源路径，也不安装系统字体。
- 本机只读服务新增 `/fonts/<SHA256>.<extension>`，按字体 MIME 返回二进制；只接受固定格式文件名，不提供任意路径读取。网页字体使用独立字体名、`font-display:swap` 和系统回退，缺失字形仍能显示；重置只取消当前选择，不删除其他已导入文件。
- 新增四套透明预设：`aurora` 极光流彩、`hologram` 赛博全息、`ripple` 音浪跃动、`danmaku` 弹幕应援 · 超级字幕。弹幕风格包含弹入、描边、错开词块与斜切退场，不增加底板或付费留言卡片。
- 「歌词互动挂件」可选跟随预设、关闭、星轨应援、跳动音符、歌词节拍条。换句和逐字歌词进入新词块时触发动作，旋转/位移/条高由当前句歌词进度推进，**不代表音频频谱或真实节拍检测**。挂件使用左右专用留白；暂停停止动画，关闭动效隐藏挂件。原有 `.word` 逐字时间与进度不变。
- 自定义 CSS 与可复制的中文 AI 提示词增加了新预设、字体与挂件说明。`data-widget` 表示挂件类型，`--widget-progress` 为句进度，`--bar-0` 至 `--bar-4` 为条高；`.widgets.lyric-beat` 用于换句/新词的短促动作。

本轮验证：`scripts/verify-nowplaying-lyrics.mjs`（13 样式 × 2 宽度、字体解码与重置、三类挂件、透明背景、逐字同步与暂停）、`scripts/verify-web-lyrics-css.mjs`（真实字体文件 + 模拟本机命令的界面测试，24 种主题/配色/尺寸布局、保存失败、预览、重新挂载）、`cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --bin rustmusic obs_lyrics::tests`（字体复制、二进制 HTTP 回传、拒绝路径穿越/无效文件、设置兼容）。
本轮没有启动/重启用户播放器或 OBS；下方历史 OBS 实测不作为这四个新预设的 OBS 实测结果。

Browser source URL: `http://127.0.0.1:17842/lyrics`. The listener binds only to IPv4 loopback. `/state` is a read-only JSON snapshot; settings are changed only through the Tauri settings commands. The page polls every 150 ms, uses engine-reported position, and refreshes from a complete snapshot after reload/reconnect. No JavaScript customization is executed.

Stable DOM: `#lyrics.lyrics` root; `#current.current` active line; `#next.next` following lines; `.translation` translation; `.word` timed lyric words; `#widgets.widgets` with stable `.widget-orbit` and `.widget-spark` decoration slots. Root attributes include `data-playing`, `data-mode`, `data-preset`, and `data-motion`. CSS variables include `--size`, `--gap`, `--width`, `--weight`, `--lyric-color`, `--stroke-color`, `--stroke-width`, `--shadow`, `--font`, `--line-height`, `--letter-spacing`, `--translation-size`, and `--offset-y`. Custom CSS loads after generated presentation styles and is persisted through the Settings controls. Preview edits are isolated to an iframe; Save commits them. Reset requires confirmation and is not applied until saved. CSS can style and animate but cannot inspect arbitrary playback data or create arbitrary HTML; use the two widget slots or pseudo-elements for decoration.

Paste one example at a time in Custom CSS:

```css
/* Looping breathing lyric, 3 seconds */
.lyrics[data-motion="on"] .current { animation: obs-breathe 3s ease-in-out infinite; }
@keyframes obs-breathe { 50% { transform: scale(1.04); opacity: .78; } }
```

```css
/* Continuous gradient flow, 5 seconds */
.lyrics[data-motion="on"] .current { background:linear-gradient(90deg,#fff,#48eaff,#e6a7ff,#fff);background-size:200% auto;background-clip:text;color:transparent;-webkit-text-stroke:0;animation:obs-flow 5s linear infinite; }
@keyframes obs-flow { to { background-position:200% center; } }
```

```css
/* Rotating independent decoration around the lyrics, 8 seconds */
.lyrics[data-motion="on"] .widgets::before { content:"♪";position:absolute;left:8%;top:20%;font-size:30px;animation:obs-spin 8s linear infinite; }
@keyframes obs-spin { to { transform:rotate(360deg); } }
```

Change animation duration to adjust cycle speed. Animations are infinite loops; setting the motion control off applies `animation:none` to the managed region. License: application stylesheet and examples are distributed under the repository Apache-2.0 license; no plugin or external animation runtime is required.

## OBS 实际载入追加排查（2026-11-18）

隔离启动工作目录改为 bin/64bit 后，OBS 已真实完成视频初始化及浏览器模块加载；测试场景改为 versioned_id=scene、将 items 放入 settings 后，日志确认 Live lyrics 浏览器源已载入。Lua 调用真实 source screenshot 得到包含歌词的 1920×1080 图片，保存于 testdata/obs-live/obs-source.png，已人工读取图片内容（没有鼠标/键盘操作）。

当前仍不是通过：Lua os.rename 无法把截图移到含中文的项目路径；截图按 OBS 日志的精确文件路径由 PowerShell 复制。图片抽样未发现透明像素，需进一步区分 OBS 截图是否丢失 alpha 与浏览器源透明合成问题，不能以此宣称透明合成通过。报告 report-source-observed.json，日志 _obs-scene-fix.log；最新源日志在隔离 runtime/config/obs-studio/logs 下。此前“无法初始化视频”的结论已被本轮真实运行证据取代，但完整 OBS 验收仍未完成。

## OBS 透明合成实测通过（2026-11-18，更新前述排查状态）

最新隔离 OBS 应用验收已通过真实浏览器源加载及有色背景合成。测试脚本把不透明洋红底图放在真实歌词浏览器源下方，分别通过 OBS API 截取源和合成场景：在 129,600 个采样点中，128,014 点仍为底图颜色，1,586 点为歌词/挂件渲染区域，并已查看真实场景截图。这证明源在歌词周围透出下层，而非用独立源截图的 PNG alpha 推断透明性。截图自动保存改为 Lua 输出实际路径、PowerShell 复制，规避 Lua 中文路径重命名失败；没有修改歌词网页以适配测试。

证据：`testdata/obs-live/report-obs-composite.json`、`obs-composite.png`、`obs-source.png`、`obs-live.log`，以及 `_obs-composite.log`、`_native-obs-composite.log`。浏览器 CSS 为已有持久化验收样式，截图可见其自定义内容。测试未开始录制或推流，无鼠标/键盘操作，结束已关闭隔离 OBS 并恢复原播放器。随后脚本追加了日志创建时间过滤，防止误读旧会话截图标记；此防护追加后尚未再次执行完整流程。

范围限制：本次不是五套预设在 OBS 中的逐套对照，也没有对 OBS 自身断线恢复和所有动画周期进行应用级验证；这些仍仅有页面/接口层证据。整体交付不能据此标记全部完成。

## 五套预设的真实 OBS 载入（2026-11-18）

`scripts/verify-obs-presets.ps1` 已完整运行通过。classic / karaoke / neon / minimal / stage 均通过真实内部设置命令保存，HTTP 当前状态精确确认预设及空自定义 CSS，随后分别启动隔离 OBS、取得源和合成场景截图、检查有色背景透出且歌词区域非空。证据汇总 `testdata/obs-live/report-presets.json`；各预设子目录 `testdata/obs-live/presets/<preset>` 保留 native 日志、浏览器报告、OBS 日志和两种真实截图。日志新鲜度防护也已在这次完整流程中执行。运行日志 `_obs-presets.log`。

这是五套预设实际载入与透明合成通过，不是所有语义分支都验收：真实歌曲没有翻译或逐字数据，因此双语显示、有时间戳的逐字推进仍依靠已有 fixture 测试；OBS 自身断线恢复、完整装饰动效周期还未在应用级覆盖。本轮云盘操作仅精确读取既有测试条目，没有重新上传或 AI 推理。更改仅涉及验收 feature 和测试脚本，普通发布 EXE 未改变。

## 真实 OBS 请求断线恢复通过（2026-11-18）

同一个 OBS 进程及浏览器源保持运行，没有手动刷新：验收版歌词服务连续 5 秒主动关闭 /state 的真实 TCP 请求连接、不返回响应，共观测到 32 次关闭。恢复后通过真实设置命令改为 neon；同一场景的恢复后截图出现青色歌词（抽样青色点从 0 增至 271），HTTP 状态也确认 neon。`testdata/obs-live/report-obs-recovery.json` 为通过报告；`obs-recovered.png`、`obs-live.log` 及 `_obs-recovery.log`、`_native-obs-recovery.log` 为证据。

这是实际 OBS 对响应中断的自动恢复验证，不是关闭整个监听服务或跨机器网络故障的模拟；未改用浏览器 mock，也未宣称覆盖所有故障类型。连接故障注入仅由 acceptance-tests feature 编入，没有新增 HTTP 控制入口；普通发布包不包含这些开关。本轮 native/OBS 进程均已结束，原播放器按原路径恢复。完整装饰周期的 OBS 应用级验证仍未覆盖。

复现：并行启动 `scripts/verify-native.ps1 -IncludeCloudReadOnly -HoldCloudForObs -ObsPreset classic -ObsRecovery` 与 `scripts/verify-obs-live.ps1 -ExpectedPreset classic -CheckRecovery`；保持两者运行至结束，不强制终止 native 恢复流程。
