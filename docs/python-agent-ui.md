# Python Agent UI

Toolkits 是 Agent UI 的加载与体验工具，不是 IDE。使用你自己的编辑器、终端和 Git 工具开发、提交和发布项目。

Python 项目只约定一个 UI 入口：根目录的 `agent_ui.py` 提供无参数的 `create_ui()`，返回 `toolkits.Interface`。其余代码目录、函数、模型/API 调用及依赖管理方式由项目作者决定。新 Python 项目不需要 `agent.json`；已有宿主适配器的清单导入继续兼容。

```python
import toolkits as tk
from your_package.pipeline import process

def create_ui():
    return tk.Interface(
        fn=process,
        inputs=[{"main": tk.Audio("输入音频")}],
        outputs=tk.Text("处理结果"),
        title="我的 Agent",
    )
```

## 安装和独立体验

需要 Python 3.10+。SDK 尚未发布到 PyPI，从本仓库安装（路径可换成绝对路径）：

```sh
python -m pip install -e .
python -m toolkits ./agents/python-agents/audio-inspector
```

也可运行 `toolkits /path/to/project`。服务绑定随机的本机端口，自动打开浏览器。`--no-browser` 禁止自动打开，`--port` 可指定端口。Ctrl+C 结束服务。运行前用项目自己选择的工具安装业务依赖。

SDK 不要求业务函数继承任何基类，不要求顶层 `app` 变量。函数可同步或 async；输入按组顺序传入，每组为包含 main 和 additional 的字典，多输出返回相同顺序的 tuple/list。`create_ui()` 只负责构造 UI，耗时模型加载可放在处理函数中按需执行。

## 组件与数据

| 组件 | Python 边界 |
| --- | --- |
| `tk.Text(label)` | 输入为字符串；输出转为文本，不解释 HTML |
| `tk.Audio(label, sources=["upload", "microphone"])` | 输入为 `AudioValue`；输出接受 `AudioValue`、文件路径字符串或 Path |
| `tk.Video(label, required=False)` | 输入为 `VideoValue`，或在可选输入未上传时为 `None`；输出接受文件路径或 `VideoValue` |
| `tk.File(label, accept=".txt,.md", required=False)` | 输入为 `FileValue`，用于文档、资料和其他 Agent 自己解析的文件 |
| `tk.AudioInfo(label)` / `tk.VideoInfo(label)` | 输出为可 JSON 序列化的媒体信息字典 |

音频界面提供上传、录音、播放器、波形和浏览器解码的时长/采样率/声道信息。录音编码为单声道 PCM WAV，最长约 5 分钟；上传保留原文件格式，不自动转码。浏览器解码采样率可能不同于原文件采样率。示例的 Python WAV 信息给出原始文件参数。

`AudioValue.path`、`VideoValue.path` 和 `FileValue.path` 是请求期间的临时文件，另有 `name` 和 `mime_type`。回调结束并序列化输出后会删除临时文件；需要长期保存时由业务代码自行复制。每个媒体文件最大 32 MiB，HTTP 请求最大 48 MiB（包括 base64 开销）。当前 UI 一次只运行一个请求，回调异常显示为错误文本。

## 桌面 Agent 目录

桌面应用直接读取 QwenAudio-Toolkits ModelScope 仓库中的 `agents/catalog.json`。目录条目包含项目包路径、版本和 SHA-256；点击“安装”后，Toolkits 下载并校验归档，再写入应用管理的本地目录，创建独立 Python 环境、安装 requirements.txt / pyproject.toml、注入内置 SDK，并调用可选的 prepare() 下载模型和运行时。成功后在首页选择 Agent，动态调用 `agent_ui.py:create_ui()` 展示界面。

SDK 随桌面应用内置。当前环境准备使用本机 uv（macOS 支持 PATH、~/.local/bin、Homebrew 安装）；uv 可自动准备 Python 3.12。项目依赖变更后，下次打开会重新安装。pyproject.toml 项目以 editable 方式安装，因此支持 src 等自由目录布局。

远程目录只用于浏览、安装和更新。Agent 包安装完成后从本地项目目录启动，离线时仍可处理本地文件。目录出现不同 SHA-256 时提示用户显式更新；更新失败保留旧版本。远程页面不参与桌面安装或本地能力调用。

SDK 独立启动默认禁止 iframe 嵌入；由桌面启动时通过 --desktop 仅允许 Tauri 和本机开发来源。Agent UI 在独立的本机来源中展示，不获得 Tauri API 权限。关闭 Agent 界面、离开页面或退出应用时，Toolkits 回收启动的 Python 进程。启动与依赖错误记录在应用数据目录 `agent-environments/<id>/runtime.log`。

当前不包含 IDE、在线代码编辑、任意远程仓库克隆、热重载、流式输出或 Python 代码沙箱。运行的 Agent 具有当前用户的 Python 进程权限。

## 输入组协议

`inputs` 是输入组列表。每组必须有一个 `main` 组件，可选 `additional` 组件列表；省略时等价于空列表。不限制主输入的组件类型，也不根据类型或声明顺序猜测主输入。

```python
def process(reference, text):
    audio = reference["main"]        # AudioValue
    transcript = reference["additional"][0]  # str
    prompt = text["main"]            # str
    # 调用任意业务函数，返回与 outputs 对应的结果
    return prompt

ui = tk.Interface(
    fn=process,
    inputs=[
        {"main": tk.Audio("参考音频"), "additional": [tk.Text("参考文本")]},
        {"main": tk.Text("待合成文本")},
    ],
    outputs=tk.Text("结果"),
)
```

回调每组接收一个位置参数，顺序与 inputs 一致。每个参数固定包含 `main` 和 `additional`，后者始终是列表，包括未声明时的空列表。组件数据类型不变；SDK 负责将音频和视频解码为请求期间的 AudioValue / VideoValue。业务模块不需要遵守任何目录或类继承约定。

界面按组排列主输入，每组附加输入位于自己的主输入上方；没有附加输入就不显示附加区域。纯音频组不显示无关的文本框。所有组共用发送按钮，一次提交整项任务。Text 可通过 placeholder 设置输入提示。

HTTP schema 的 inputs 同样保留 main/additional 分组，input_mode 为 grouped；run 请求传入同结构的数据。为已有项目保留旧的组件列表写法，它的 input_mode 为 legacy，回调和请求仍接收原来的平铺参数；新项目使用输入组，禁止混用两种声明。

当前 SDK 预览仍使用独立渲染器，对话仅保留在当前页面。输入协议重构不代表已经完成原 Toolkits 工作区组件、持久记录及结果详情的复用。
