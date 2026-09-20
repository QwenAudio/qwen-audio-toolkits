# Toolkits SDK

用少量 Python 声明 Agent 交互界面。默认采用对话记录、标准主输入框和胶囊式附加输入。独立运行与 Toolkits 内嵌使用同一套界面；不要求开发者写 HTML、HTTP 服务或桌面适配器。

## 安装与运行

需要 Python 3.10+。SDK 尚未发布到 PyPI，在 Toolkits 仓库中安装：

```sh
python -m pip install .
toolkits /path/to/agent
```

也可安装构建好的 `qwenaudio_toolkits_sdk-0.2.0-py3-none-any.whl`。业务依赖由项目自行提供。SDK 运行时没有第三方 Python 依赖，也不依赖常驻网络服务。

## 一个完整 Agent

唯一入口约定是项目根目录 `agent_ui.py` 提供 `create_ui()`，其他代码自由组织：

```python
import toolkits as tk

def respond(request: tk.InputValue):
    text = request["main"]
    style = request["additional"][0]
    return f"{style}：{text}"

def create_ui():
    return tk.Interface(
        fn=respond,
        inputs=[{
            "main": tk.Text("消息", placeholder="输入内容…"),
            "additional": [tk.Select("风格", choices=["简洁", "详细"])],
        }],
        outputs=tk.Text("回复"),
        title="我的 Agent",
    )
```

## 多主输入与胶囊参数

```python
inputs=[
    {
        "main": tk.Audio("参考音频"),
        "additional": [tk.Text("参考文本")],
    },
    {"main": tk.Text("待合成文本")},
]
```

每组有一个 main；additional 可以省略，界面不留占位。附加输入默认呈现小胶囊，显示名称与当前值，点击编辑，Esc 或点击外部收起。多组共用发送按钮。回调按声明顺序接收每组一个参数，固定为 `{"main": value, "additional": [...]}`，缺省 additional 是空列表。

主输入按组件类型呈现；音频主输入不会出现禁用的文本框。Text 附加输入、音色等参数在发送后保留，主文本输入成功发送后清空。Ctrl/Cmd+Enter 发送。

## 六个基础组件

| 组件 | 用途与 Python 值 |
| --- | --- |
| `Text(label, placeholder="", value="")` | 文本；输入为 str，输出转为纯文本 |
| `Audio(label, sources=("upload", "microphone"))` | 上传或录音；输入为 AudioValue，输出为文件路径或 AudioValue |
| `File(label, accept=".txt,.md", required=False)` | 上传由 Agent 自己解析的文档或数据文件；输入为 FileValue |
| `Number(label, minimum=None, maximum=None, value=None)` | 有限数值与范围校验 |
| `Select(label, choices=[...], multiple=False, value=None)` | 单选字符串或多选字符串列表 |
| `Table(label, columns=[...])` | 标量单元格组成的二维列表 |

所有基础组件均可用作主输入、附加输入或输出。`InputGroup` 和 `InputValue` 仅为 Python 类型提示，不是额外 UI 组件。`AudioInfo` 为早期项目兼容保留，新代码使用 Table。

回调支持同步或 async。多输出返回按声明顺序排列的 tuple/list。UI 展示运行、完成和错误状态；失败重试使用原输入快照。每次提交追加一轮记录，音频可播放和下载，多输出中的辅助表格默认折叠。

## 文件、配置与限制

AudioValue、VideoValue 和 FileValue 都包含 path、name、mime_type；输入文件仅在回调期间有效，长期保存需自行复制。单个文件最大 32 MiB，请求最大 48 MiB。上传不转码；录音为单声道 PCM WAV，最长五分钟。不要把 API Key 声明成普通输入，因为输入会出现在对话中；由 Agent 的运行环境提供凭据。

SDK 绑定随机本机端口。`toolkits . --no-browser --port 9000` 可显式设置端口；`create_ui().run()` 也可启动。Toolkits 桌面自动准备项目环境并注入 SDK，开发者不用写适配器。桌面的 `--desktop` 模式仅允许指定桌面来源嵌入。

旧版平铺 inputs 保留兼容，其回调仍接收平铺值；禁止与输入组混用。HTTP schema 包含 sdk_version 和 input_mode，分组模式的 run 请求保留相同结构。

当前记录仅保存在页面中，不包含持久历史、LLM 自动记忆、流式输出、取消推理或 IDE。运行的 Python 具有当前用户权限。原 Toolkits 工作区组件与持久记录的完整复用尚未完成。

## 开发 SDK

- `toolkits/__init__.py`：组件、分组声明与 Python 调用协议。
- `toolkits/server.py`：本机 HTTP 与资产白名单。
- `toolkits/ui.html`、`ui.css`、`ui.js`：共享界面结构、样式与交互。
- `tests/`：类型校验、音频、分组、HTTP 和桌面嵌入测试。

```sh
python -m unittest discover -s tests -v
python -m build
```

无需构建 JavaScript 即可运行；HTML/CSS/JS 随 wheel 和桌面应用一同打包。

Select 支持字符串列表，或 `{实际值: 显示名称}` 字典，例如 `tk.Select("音色", choices={"voice-id": "自然女声"})`。胶囊和菜单显示名称，回调接收实际值。空选项列表支持 placeholder 提示且禁止提交，不会创建虚假选项。

`Audio("参考音频", transcript=True)` 在音频面板内增加配套文本，回调通过 `AudioValue.transcript` 读取。换音频或开始新录音时清空旧文本，默认不启用自动转写。

多个纯音频主输入自动使用双列卡片（窄屏单列），每张卡片独立上传、录音和移除；含文本的任务沿用框外胶囊布局。样式统一维护在 ui.css，不需要 Agent 自定义 CSS。

### 在 Toolkits 中安装

ModelScope 资源仓库通过 `agents/catalog.json` 提供固定内容的项目包和 SHA-256。用户点击「安装」后，Toolkits 下载并校验项目到应用管理的本地目录，创建独立 Python 环境并安装项目依赖；安装成功后，Agent 出现在首页，界面由 `agent_ui.py` 动态加载，无需重新编译 Toolkits。

如果项目需要预先下载模型或运行时，可在同一个 `agent_ui.py` 中提供可选的 `prepare()` 函数（支持 async）。它在安装期间运行；应可重复调用、校验已有资源并复用缓存。普通 UI 打开不会重复调用它。没有额外资源的 API Agent 不需要实现此函数。

```python
def prepare():
    from resources import ensure_model
    ensure_model()
```

开发时可运行 `python -m toolkits . --prepare` 单独检查资源准备和 UI 定义。API Key 等账户凭据不属于下载包；云端 Agent 仍需有效的服务配置。

### 安装时生成界面

Toolkits 安装时使用 `--prepare --ui-cache <path>` 执行 `create_ui()` 并保存界面定义。正常打开时直接读取定义，不导入 Agent 业务模块；第一次执行任务时才在当前 Python 进程中调用 `create_ui()` 恢复回调对象，后续请求复用它。缓存不序列化或执行 pickled Python 对象。

项目 Python 代码、依赖声明、SDK 接口或相关百炼账号环境配置变化时，缓存自动失效。`create_ui()` 应避免产生不可重复的业务副作用。界面定义中的动态选项是生成时的快照，账户配置变化会重新获取。

动态选项可通过 `tk.Select(..., refresh=callback)` 提供显式刷新入口；刷新在当前进程内完成，同时更新界面缓存。

### 再次打开

桌面端在页面切换后保留最近使用的最多 3 个 Agent 进程。重新打开时检查项目源代码、依赖、SDK 和账号配置指纹；未变化且进程存活时直接返回已有服务地址，已初始化的回调和模型对象也继续复用。超过数量限制时释放最久未使用的进程；退出应用时全部释放。音色等动态选项单独刷新，不再使运行进程定时失效。

## Unified inputs and conversation content

`Input` declares a main component and optional additional controls. Existing
`{'main': ..., 'additional': [...]}` declarations remain supported. Both forms
pass the same `{'main': value, 'additional': [...]}` argument to the callback.

```python
import toolkits as tk

def create_ui():
    return tk.Interface(
        fn=transcribe,
        inputs=tk.Input(tk.Audio("音频"), additional=(tk.Text("热词"),)),
        outputs=[tk.Text("转录"), tk.Table("时间段", columns=["开始", "结束", "文本"])],
        title="语音识别",
    )
```

All modalities use paired input and reply messages. A reply can contain multiple
content blocks. Audio players, text, selections, numbers, tables and audio
measurements share a renderer across messages and the optional detail panel.
Tables show their row count in messages and expand in details. Details open only
when requested; they do not take over the conversation after submission.

`submit="auto"` is the default. A single main audio input without a transcript or
additional audio submits on upload or recording completion. Text, multiple main
inputs, and audio requiring a transcript use explicit submission. Set
`submit="manual"` when a user should review the audio and parameters first.
`submit="audio"` explicitly requests completion-triggered submission and rejects
incompatible input configurations. Audio supports `upload`, `microphone`, and
`system`; native system capture is provided by the Toolkits host, while browser
support depends on display-audio capture availability.

The shared renderer is packaged with the pip SDK and native host. No Agent-specific
frontend build is required. Streaming replies and arbitrary custom layout APIs
are not part of this interface yet.

### 实时音频输入

`tk.StreamingAudio("实时音频")` 复用音频输入样式，支持麦克风和电脑音频。
当前限定一个主输入，无附加参数；普通文件输入继续使用 `tk.Audio`。
回调收到 `tk.AudioStream`，迭代得到 16 kHz 单声道、小端 PCM16 字节片段。
调用 `stream.emit(result)` 更新当前回复，返回最终结果结束这一轮。
每次 emit 的结果与 Interface 的 outputs 对应，是完整快照而非追加片段。
使用分组输入时，通过 `request["main"]` 访问流。
最大录音五分钟，发送队列有上限；切走页面取消会话，空闲会话自动清理。
