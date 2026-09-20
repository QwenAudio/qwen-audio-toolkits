"""Video-dubbing Agent entrypoint."""
import toolkits as tk
from dubbing import dub_video


def prepare():
    tk.report_progress("检查本机配音与视频处理能力")


def create_ui():
    return tk.Interface(
        fn=dub_video,
        inputs=[{
            "main": tk.Text("配音要求", placeholder="例如：翻译成中文并做自然配音；或保留中文，改成更简洁的旁白"),
            "additional": [tk.Video("视频素材", required=False)],
        }],
        outputs=[
            tk.Video("配音预览"),
            tk.Text("配音稿"),
            tk.Table("配音时间线", columns=["时间", "原文", "配音稿"]),
            tk.Text("Agent 回复"),
        ],
        title="视频配音",
        description="在对话中说明目标语言和风格，上传视频后 Agent 直接生成右侧配音预览与逐段文稿；文本能力和云端凭据由已安装 Agent 自动获得。",
    )
