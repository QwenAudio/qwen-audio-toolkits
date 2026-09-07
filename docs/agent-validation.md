# Agent 改造校验记录

日期：2026-09-07。环境：macOS，本地 `codex/agent-projects` 工作区，应用版本 0.1.12。

本轮完成代码、清单、资源可用性及可运行链路校验。以下结果不能替代所有模型的推理验收或跨平台测试。

## 本轮修复

- 安装前先检查项目元数据、输入输出、路径和重复 ID，避免无效项目或重复安装先触发下载。
- Agent 输入输出不能为空，同方向端口名称不能重复。
- 修正 JSON Schema：支持合法的连字符端口名、内嵌权重的空文件清单，以及安装器已有的显示字段和可选资源校验和。单个导入项目仍只接受一个选定资源包。
- WeText 原下载地址实际返回 403，已将 AISHELL3 和 WeText 清单中的规则地址切换到 Toolkits 资源镜像。40 处资源声明对应 20 个文件，全部与镜像元数据 SHA256 一致；20 个文件实际下载成功，合计 23,910,980 字节，逐个计算 SHA256 均一致。
- 新增可重复执行的原生回归脚本 `npm run test:agents:native`，仅连接预览端口 3848，清理自身创建的临时项目和运行记录。

## 已验证

| 范围 | 结果 |
| --- | --- |
| Rust 单元测试 | 110 项：98 通过、0 失败、12 显式跳过 |
| 前端 | lint、TypeScript、Vite 构建及全部 npm smoke 测试通过 |
| 项目定义 | 34 个目录 Agent，45 个选定资源包逐一通过安装清单 Schema；两个公开 agent.json 示例通过 |
| 原生目录 | 35 个本地描述符均包含 Agent 元数据和输入输出契约，包括内置 Silero |
| API 定义 | 16 个内置 API 项目和 1 个自定义 API 测试项目的 Agent 契约通过 |
| 资源声明 | 45 个资源包声明的文件均能在主仓库或独立附加资源地址找到；未发现未解析的文件声明 |
| 原生端到端 | 17 组检查通过，详见下文 |
| API 协议 | 本地模拟服务的 8 条请求链路通过，覆盖 JSON、multipart、二进制、PCM、SSE 等 |
| 发布前检查 | 开源检查和 12 个可发布目录条目一致性检查通过；git diff --check 通过 |
| 桌面预览 | 最终代码成功构建为独立 Agent Preview 应用，启动并监听 127.0.0.1:3848 |

原生端到端检查覆盖：目录导入及 README/资源保留、直接 agent.json 导入、ZIP 导入、重复 ID 在下载前拒绝、跨 Agent 依赖拒绝、可执行 Harness 拒绝、多个资源包拒绝、空输入/重复端口/非法类型拒绝、路径穿越拒绝、双清单和符号链接拒绝、跨 Agent 绑定拒绝且不修改原绑定、RNNoise 输出有效 WAV、坏音频明确失败、3D-Speaker 输出 192 维有限数值声纹、相同音频余弦相似度大于 0.999。

API 协议测试使用本地模拟响应，没有调用付费服务。它证明请求构造与响应解析链路工作，不证明真实服务账号或模型效果。

## 验证边界

- 12 个跳过的 Rust 测试需要额外模型、运行时归档或测试音频，涵盖 ASR、TTS、WeText、DeepFilter、VAD、ZipEnhancer、MossFormer 等。本轮未声称这些真实模型测试通过。
- 真实推理实测覆盖 RNNoise 和 3D-Speaker；其他模型进行了契约、资源声明和相关代码回归校验，未逐个下载安装运行。文件存在不等于模型推理质量合格。
- 本轮没有完成界面截图/交互的视觉验收，也没有验证 Windows/Linux、实时麦克风、系统音频采集。
- 当前 Agent Harness 使用宿主支持的适配器；尚不是可随项目执行任意 Python/Rust Harness 的独立运行环境，底层运行时仍由宿主管理。Agent 项目之间不建立依赖。
- 原生构建存在既有 `process_tap.m` 的 macOS availability 编译警告；本地预览采用临时签名，未做 Apple 公证。

## 复跑

```sh
npm run lint
npm run build
npm test
npm run open-source:check
cargo test --manifest-path src-tauri/Cargo.toml --lib
# 启动独立 Agent Preview 后运行：
npm run test:agents:native
QWEN_AUDIO_TOOLKITS_API=http://127.0.0.1:3848/v1 npm run test:custom-provider
```

本地构建使用已有 Sherpa 归档时，需要设置 `SHERPA_ONNX_ARCHIVE_DIR`。原生 smoke 默认生成测试音频，也可通过 `QWEN_AUDIO_AGENT_SMOKE_WAV` 指定 WAV；声纹检查仅在预览中已经安装 3D-Speaker 时执行。
