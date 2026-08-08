# QwenAudio Toolkits

[中文](README_ZH.md) | [English](README.md)

[![CI](https://github.com/QwenAudio/qwen-audio-toolkits/actions/workflows/ci.yml/badge.svg)](https://github.com/QwenAudio/qwen-audio-toolkits/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![macOS](https://img.shields.io/badge/macOS-14.2%2B-black?logo=apple)](docs/getting-started.md)

一个面向音频 AI 模型的本地优先桌面工作台。安装模型后，直接以对话方式上传、
录制或监听音频；结果可以即时预览，并在详情面板中查看波形、Mel 频谱、时间戳、
说话人片段和运行信息。

QwenAudio Toolkits 用统一的 **Harness 能力协议**连接本地模型与云端 API。模型权重
按需下载，不随应用打包；同一套界面可以承载 ASR、VAD、降噪、音频理解、TTS、
音色克隆和文本处理模型。

> 当前公开预览版主要面向 Apple Silicon，要求 macOS 14.2 或更高版本。Windows
> 与 Linux 的界面和基础代码已考虑跨平台，但尚未达到正式发布质量。

![QwenAudio Toolkits 界面](docs/assets/qwenaudio-toolkits-overview.png)

## 核心能力

- **音频处理**：VAD、语音增强、降噪、音源分离和实时音频监听
- **音频理解**：ASR、语种识别、关键词检测、音频标签、声纹和说话人分离
- **音频生成**：多音色 TTS、流式合成、参考音频音色克隆
- **文本处理**：标点恢复、TN / ITN 文本归一化
- **统一交互**：音频输入、流式状态、结果预览和详情组件按能力复用
- **模型商店**：远程目录、按需安装、量化版本、SHA-256 校验和依赖模型
- **本地与云端**：支持 sherpa-onnx、FunASR llama.cpp、CosyVoice.cpp、
  DeepFilterNet、RNNoise、kaldifst 与阿里云百炼 API

模型不会因为作为其他模型的依赖而重复出现在工作台。共享模型权重只有在没有
任何引用时才会被物理删除。

## 安装

### 下载桌面版

预编译的 Apple Silicon 安装包发布在
[GitHub Releases](https://github.com/QwenAudio/qwen-audio-toolkits/releases)。选择最新
版本，下载其中的 `.dmg` 安装包，打开后将应用拖入 Applications。模型权重和运行时
仍会在应用内按需从 [ModelScope](https://www.modelscope.cn/models/funaudio_public/QwenAudio-Toolkits)
下载。

当前构建尚未经过 Apple notarization。macOS 首次阻止启动时，请在
**系统设置 → 隐私与安全性**中确认打开。不要从非项目发布页下载二次打包版本。

### 从源码运行

需要 Node.js 20.19+、Rust 1.77.2+、CMake，以及
[Tauri 2 平台依赖](https://v2.tauri.app/start/prerequisites/)。macOS 还需要 Xcode
Command Line Tools。

```bash
git clone https://github.com/QwenAudio/qwen-audio-toolkits.git
cd qwen-audio-toolkits
npm ci
npm run desktop:dev
```

`npm run dev` 只启动浏览器界面预览。模型推理、麦克风、电脑音频和自动更新必须
运行在 Tauri 桌面进程中。完整步骤见[快速开始](docs/getting-started.md)。

发布版本和自动更新流程见[发布指南](docs/releasing.md)。

## 模型与数据边界

本地模型只在用户点击安装后下载，推理音频不会上传。选择云端 API 模型时，输入
会发送给相应服务商；界面会明确标记“离线运行”或“云端 API”。模型权重、云端
服务和数据集各自适用其原始许可证与服务条款，不因本仓库采用 Apache-2.0 而改变。

应用不包含遥测、广告分析或自动崩溃上报。详细的数据目录、凭据和网络请求边界见
[隐私说明](PRIVACY.md)。

## 架构

```text
React / TypeScript workspace
            │ Tauri commands + events
            ▼
Rust Harness runtime ─── local HTTP API (127.0.0.1:3847)
            │
            ├── reviewed local adapters ── on-demand model assets
            └── configured cloud providers
```

Harness 使用有限的能力、端口和参数类型描述模型。模型插件不能向主进程注入任意
本地代码；新架构需要先增加经过评审的适配器，兼容模型再通过声明式 manifest
复用它。详见：

- [架构说明](docs/architecture.md)
- [模型商店与目录](docs/model-catalog.md)
- [Model Plugin v2](docs/model-plugin-v2.md)
- [Plugin JSON Schema](docs/plugin-manifest.schema.json)

## 开发与验证

```bash
npm run lint
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/workflow-smoke.mjs
# 需要运行中的本地 Harness；未安装的可选本地依赖会标记为跳过。
npm run workflow:smoke
```

本地模型冒烟测试需要先运行桌面版，并安装对应模型：

```bash
npm run models:smoke
```

## 参与贡献

欢迎提交 Issue 和 Pull Request。开始较大的 UI、运行时或插件协议改动前，请先发
Issue 对齐设计。开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请按
[SECURITY.md](SECURITY.md) 私密报告。

## 许可证

项目原创源代码使用 [Apache License 2.0](LICENSE)。第三方运行时、库和模型仍受
各自许可证约束，见 [NOTICE](NOTICE) 与
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
