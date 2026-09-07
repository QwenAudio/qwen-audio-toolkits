# Audio to Text · SenseVoice Small GGUF Agent

将音频转换为文本，并提供模型支持的语言、情感和音频事件标签。

## 使用

在桌面应用 Agents 页面选择“导入 Agent”，选择本项目文件夹。
也可以将本目录打包为 ZIP，通过旁边的安装包按钮导入。首次安装会下载 Q8 模型、FSMN-VAD 和
清单中声明的 FunASR 运行时。如果已有同 ID 的 SenseVoice 安装，导入不会覆盖它。

安装完成后上传音频并执行识别。音频在本机处理。

## 项目组成

- SenseVoice Small Q8 模型。
- 本项目的 `fsmn-vad.gguf` 分段资源。
- `funasr-llamacpp-0.1.9` 运行时包。
- `funasr-sensevoice-gguf` 宿主 Harness 契约。
- 输入输出、使用说明和限制。

不依赖独立的 VAD Agent。结果不包含会议纪要或说话人分离。
模型与运行时按需下载；项目 ID 对应官方资源仓库路径，不能在使用
`repositoryHosted` 时随意更改。自有项目可改用明确的 HTTPS 资源地址。
