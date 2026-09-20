# 两个发布边界

## Toolkits

当前仓库同时提供桌面应用与 Python SDK。根目录的 `toolkits/` 是唯一的 Python 实现；桌面应用从这里内置组件和运行时，pip 包也从这里打包。

```sh
python -m pip install .
python -c "import toolkits as tk; print(tk.Interface)"
toolkits /path/to/agent
```

- `toolkits/`：组件、界面协议、动态预览服务和前端资源。
- `tests/`：Python SDK 测试。
- `src/`、`src-tauri/`：桌面应用。

## QwenAudio-Toolkits ModelScope 仓库

模型、平台运行时和正式 Agent 都发布在同一个 ModelScope 仓库 `funaudio_public/QwenAudio-Toolkits`。它是桌面应用唯一的远程资源来源，不需要独立 Agent Server。

```text
QwenAudio-Toolkits/
├── model-catalog.json
├── models/                 # 模型权重
├── runtimes/               # 共享本地运行时
└── agents/
    ├── catalog.json        # Agent 目录
    └── <agent-id>.tar      # 固定内容的 Agent 项目包
```

每个目录条目声明 Agent ID、名称、版本、分类、归档路径和 SHA-256。桌面刷新目录时读取 `agents/catalog.json`；安装时下载相应归档、校验摘要、创建独立 Python 环境并运行 `prepare()`。已安装项目保存在应用数据目录，之后可以离线启动。

更新是显式操作：目录中的 SHA-256 改变时提示更新，更新失败会保留旧版本。Agent 项目仅通过 `import toolkits` 使用 SDK，不从 Toolkits 源码作相对路径导入。

发布前在本仓库更新 `catalog/agent-catalog.json`，并执行：

```sh
npm run agents:repository -- /path/to/QwenAudio-Toolkits
```

该命令会校验每个 `.tar` 的 SHA-256，再写入资源仓库的 `agents/catalog.json`。
