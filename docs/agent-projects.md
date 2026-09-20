# 独立 Agent 项目

Agent 将模型或 API、资源准备、输入处理、推理和结果展示组成一个独立项目。
不要求 Agent 是 LLM，也不依赖其他已安装 Agent。例如声纹比较项目自带声纹模型，
说话人分离项目自带分段和声纹资源，语音克隆项目直接接收参考音频及其文本。

## 发布与安装

- Toolkits：桌面应用和可 pip 安装的 `qwenaudio-toolkits`，通过 `import toolkits` 使用 SDK。
- QwenAudio-Toolkits ModelScope 仓库：同时托管模型、运行时和 `agents/catalog.json` 所列的正式 Agent 项目包。

不需要单独的 SDK 仓库。Toolkits 的 Python 包只打包运行和渲染界面所需的 Python、HTML、CSS、JS，不要求开发者编译桌面应用。

## 开发入口

项目根目录提供 `agent_ui.py`，其中 `create_ui()` 返回界面即可；其余目录和业务代码组织自由。
不要求 `agent.json`，也不需要修改 Toolkits 的 React 或 Rust 代码。

```python
import toolkits as tk
from processing import process


def run(request):
    return process(request["main"], request["additional"][0])


def create_ui():
    return tk.Interface(
        fn=run,
        inputs=[{
            "main": tk.Text("输入文本"),
            "additional": [tk.Select("语言", choices={"zh": "中文", "en": "英语"}, value="zh")],
        }],
        outputs=tk.Text("结果"),
    )
```

每组输入有一个主输入，可选 `additional`；允许多组主输入。附加控件以胶囊呈现在输入框上方。
`Select.choices` 的字典是「实际值 → 显示文字」。参考文本属于 `tk.Audio(..., transcript=True)`，无需独立文本胶囊。`tk.Video(required=False)` 可让 Agent 先在对话中澄清剪辑意图，等用户上传素材后再生成右侧视频预览。

在项目目录运行 `pip install -r requirements.txt`、`toolkits .` 即可动态预览。
`prepare()` 可选：负责下载、校验项目资源，在安装阶段执行。函数内只使用本项目缓存，
重开项目复用缓存和运行环境。`create_ui()` 不应加载模型或联网查询音色。

## 浏览、安装、更新、卸载

ModelScope 目录为每个 Agent 指向固定归档和 SHA-256。桌面下载并校验源码、创建独立 Python 环境、执行资源准备并缓存 UI。
项目在首页对应分类中出现，打开后动态渲染 Python 界面。新增或修改 Agent 只需发布新归档和目录版本，无需重新编译 Toolkits。
云端 Agent 通过设置中的百炼账号使用 API；独立运行时配置 `DASHSCOPE_API_KEY`。

安装状态操作为「安装 / 更新 / 卸载」。源码归档采用稳定内容摘要，其他目录条目或模型的提交不会造成假更新。
更新失败保留原项目；卸载删除托管的项目与环境。新的 Agent 安装入口均走独立 Python 项目。

## 验证与限制

完整清单、真实推理测试及已知限制随每个 Agent 的 README 和发布版本维护。
云端协议使用模拟测试，未执行付费请求。部分原流式识别项目目前在录音完成后返回结果；
大模型资源和平台支持范围以各项目 README/资源声明为准，不能把一次短音频冒烟测试当作完整精度评测。

## 桌面预览

```sh
npm run tauri -- build --debug --bundles app --config src-tauri/tauri.agent-preview.conf.json
```

预览使用独立应用标识、数据目录与 `127.0.0.1:3848`，不自动更新为正式发行版本。

## 发布视频剪辑 Agent

源码位于 `agents/video-editor/`。发布到 ModelScope 资源仓库时，将该目录归档为 `agents/video-editor.tar`，计算归档的 SHA-256 后写入本仓库的 `catalog/agent-catalog.json`，再运行 `npm run agents:repository -- /path/to/QwenAudio-Toolkits`。不要把临时归档或未经校验的摘要提交到桌面仓库。
