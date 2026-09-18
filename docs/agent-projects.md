# 独立 Agent 项目

Agent 将模型或 API、资源准备、输入处理、推理和结果展示组成一个独立项目。
不要求 Agent 是 LLM，也不依赖其他已安装 Agent。例如声纹比较项目自带声纹模型，
说话人分离项目自带分段和声纹资源，语音克隆项目直接接收参考音频及其文本。

## 两个基础仓库

- Toolkits：桌面应用和可 pip 安装的 `qwenaudio-toolkits`，通过 `import toolkits` 使用 SDK。
- Agent Server：网站/API 与 `agents/` 中的 51 个正式独立项目。教学代码单独放在 `examples/`。

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
`Select.choices` 的字典是「实际值 → 显示文字」。参考文本属于 `tk.Audio(..., transcript=True)`，无需独立文本胶囊。

在项目目录运行 `pip install -r requirements.txt`、`toolkits .` 即可动态预览。
`prepare()` 可选：负责下载、校验项目资源，在安装阶段执行。函数内只使用本项目缓存，
重开项目复用缓存和运行环境。`create_ui()` 不应加载模型或联网查询音色。

## 浏览、安装、更新、卸载

Agent Server 挂载已提交的 Git 项目，提供 README、文件、提交记录和源码下载。
各 Agent 可随 server 仓库管理，也可拆成自己的 Git 仓库。

网站在 Toolkits 内请求安装时，桌面下载源码、创建独立 Python 环境、执行资源准备并缓存 UI。
项目在首页对应分类中出现，打开后动态渲染 Python 界面。新增或修改 Agent 无需重新编译 Toolkits。
云端 Agent 通过设置中的百炼账号使用 API；独立运行时配置 `DASHSCOPE_API_KEY`。

安装状态操作为「安装 / 更新 / 卸载」。源码归档采用稳定内容摘要，其他项目或 server 的提交不会造成假更新。
更新失败保留原项目；卸载删除托管的项目与环境。旧宿主适配器仅保留兼容原有工作流，新的 51 个项目安装入口均走独立 Python 项目。

## 验证与限制

完整清单、真实推理测试及已知限制记录在 Agent Server 的 `MIGRATION.md`。
云端协议使用模拟测试，未执行付费请求。部分原流式识别项目目前在录音完成后返回结果；
大模型资源和平台支持范围以各项目 README/资源声明为准，不能把一次短音频冒烟测试当作完整精度评测。

## 桌面预览

```sh
npm run tauri -- build --debug --bundles app --config src-tauri/tauri.agent-preview.conf.json
```

预览使用独立应用标识、数据目录与 `127.0.0.1:3848`，不自动更新为正式发行版本。
