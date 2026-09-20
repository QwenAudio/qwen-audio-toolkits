# AI 播客 Agent

独立的资料到双人播客 Agent。上传 TXT、Markdown、DOCX 或可提取文本的 PDF，并说明节目目标；右侧会展示脚本、分镜和本机生成的 WAV。

若 Agent 从桌面目录以 `provider: bailian` 安装，会自动继承已配置的百炼凭据以生成更完整的脚本，不需要在 Agent 页面选择文本模型。没有云端凭据时仍可按资料生成本地初稿。音频使用 macOS 系统语音和 FFmpeg；单次产物受 SDK 32 MiB 限制。
