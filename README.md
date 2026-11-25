# RustMusic 公开版

成品官网：[www.声卡.com](https://www.声卡.com)

播放器、AI 伴奏、Studio One 控制、Folia OBS 透明歌词和官网前端。Windows 构建需要 Node.js、Rust、MSVC C++ 构建工具和 WebView2。

## 构建

```powershell
git submodule update --init
npm ci
npm ci --prefix folia-overlay
npm run build
cd src-tauri
cargo build --release --features custom-protocol
```

## 上游项目与许可

- 播放器框架来自 [LingyunStudio/RustMusic](https://github.com/LingyunStudio/RustMusic)。
- 歌词渲染器来自 [folia-ce/folia-web](https://github.com/folia-ce/folia-web)，源码固定在 Git 子模块所记录的提交。
- 依赖项目和作者信息见 [开源署名](src/openSourceNotices.json)。

公开版源码使用 [AGPL-3.0](LICENSE)，保留 [RustMusic 上游 Apache-2.0 许可](docs/RustMusic-Upstream-Apache-2.0-LICENSE.txt)和 [Folia AGPL-3.0 许可](docs/Folia-AGPL-3.0-LICENSE.txt)。

如需分发、二改，请遵循 [AGPL-3.0 license](https://github.com/xl6671112/RustMusic#AGPL-3.0-1-ov-file) 的规则。

## 歌词包与社区

歌词包入口在 **设置 → OBS 透明歌词**。选择 Folia 样式后可导入或导出 `.folia`。在 Folia 的全局设置里可以打开原版背景。官网前端依赖线上账号与歌词社区 API。
