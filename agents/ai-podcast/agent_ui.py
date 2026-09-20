"""AI Podcast Agent entrypoint."""
import toolkits as tk
from podcast import create_podcast


def prepare():
    tk.report_progress("检查本机播客音频能力")


def create_ui():
    return tk.Interface(
        fn=create_podcast,
        inputs=[{
            "main": tk.Text("播客要求", placeholder="例如：把这篇文章做成 3 分钟中文双人播客，重点解释结论和局限"),
            "additional": [tk.File("资料文档", accept=".txt,.md,.markdown,.pdf,.docx", required=False)],
        }],
        outputs=[
            tk.Audio("播客音频"),
            tk.Text("播客脚本"),
            tk.Table("节目分镜", columns=["角色", "台词"]),
            tk.Text("Agent 回复"),
        ],
        title="AI 播客",
        description="把主题和资料交给 Agent。它会在对话中补齐缺少的来源，再将双人脚本和可播放音频放到右侧；不再让用户另选文本或语音模型。",
    )
