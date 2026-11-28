# RustMusic 公开版

成品官网：[www.声卡.com](https://www.声卡.com)

播放器、AI 伴奏、Studio One 控制、Folia OBS 透明歌词和官网前端。Windows 构建需要 Node.js、Rust、MSVC C++ 构建工具和 WebView2。

## 构建

```powershell
git -c core.autocrlf=false submodule update --init
npm ci
npm ci --prefix folia-overlay
npm run build
cd src-tauri
cargo build --release --features custom-protocol
```

## 上游项目与许可

构建会在固定的 Folia 子模块上校验并应用 `patches/folia-glow-colors.patch`，保留原版光晕动画并支持独立选色。补丁可重复应用，无需更换子模块来源。

- 播放器框架来自 [LingyunStudio/RustMusic](https://github.com/LingyunStudio/RustMusic)。
- 歌词渲染器来自 [folia-ce/folia-web](https://github.com/folia-ce/folia-web)，源码固定在 Git 子模块所记录的提交。
- JIZURA 渲染器和效果组合来自 [852wa/JIZURA](https://github.com/852wa/JIZURA)，固定来源和构建方式见 [集成说明](jizura-overlay/README.md)，保留原始 MIT 许可。
- 依赖项目和作者信息见 [开源署名](src/openSourceNotices.json)。

公开版源码使用 [AGPL-3.0](LICENSE)，保留 [RustMusic 上游 Apache-2.0 许可](docs/RustMusic-Upstream-Apache-2.0-LICENSE.txt)和 [Folia AGPL-3.0 许可](docs/Folia-AGPL-3.0-LICENSE.txt)。

如需分发、二改，请遵循 [AGPL-3.0 license](https://github.com/xl6671112/RustMusic#AGPL-3.0-1-ov-file) 的规则。

## 歌词包与社区

歌词包入口在 **设置 → OBS 透明歌词**。选择 Folia 样式后可导入或导出 `.folia`。在 Folia 的全局设置里可以打开原版背景。官网前端依赖线上账号与歌词社区 API。
