# 两个基础仓库

## Toolkits

当前仓库同时提供桌面应用与 Python SDK。根目录的 `toolkits/` 是唯一的 Python 实现；
桌面应用从这里内置组件和运行时，pip 包从这里打包，不存在独立 SDK 仓库。

```sh
# 在 Toolkits 仓库根目录
python -m pip install .
python -c "import toolkits as tk; print(tk.Interface)"
toolkits /path/to/agent
```

开发时使用 `pip install -e .`。构建 wheel 使用 `python -m build`。
Python 包只包含 Python 运行时与界面资源，不需要 Node、Rust 或桌面编译工具。
发行名为 `qwenaudio-toolkits`，导入名为 `toolkits`；此整理不包含向 PyPI 发布。

- `toolkits/`：组件、界面协议、动态预览服务和前端资源。
- `tests/`：Python SDK 测试。
- `src/`、`src-tauri/`：桌面应用。
- `src-tauri/tests/fixtures/`：兼容性测试样本，不是可安装 Agent。

## agent-server

位于相邻的独立 Git 仓库 `../agent-server`，包含网站、API 和 `agents/` Agent 项目。
独立安装和运行，不读取 Toolkits 源码。Agent 项目只通过 `import toolkits` 使用公共接口，
各自维护依赖、模型/API 与任务代码。Agent 可以独立成各自的 Git 仓库。

本地协作时目录如下：

```text
workspace/
├── qwen-audio-toolkits/   # Toolkits Git 仓库，pip install .
│   ├── pyproject.toml
│   ├── toolkits/
│   ├── tests/
│   ├── src/
│   └── src-tauri/
└── agent-server/          # 独立 Git 仓库，pip install .
    ├── pyproject.toml
    ├── agent_server/
    ├── tests/
    ├── agents/            # 正式 Agent 项目
    └── examples/          # 最小教学示例
```

两个仓库通过 HTTP 和 Agent 项目下载协议协作，不通过相对路径导入。
需要更新初始目录时，在 Toolkits 运行
`npm run agents:export -- /path/to/agent-server/agent_server/builtin-agents.json`。
