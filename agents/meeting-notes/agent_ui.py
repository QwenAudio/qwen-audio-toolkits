"""Meeting-notes Agent entrypoint."""
import toolkits as tk
from meeting_notes import create_meeting_notes


def prepare():
    tk.report_progress("检查本机语音识别能力")


def create_ui():
    return tk.Interface(
        fn=create_meeting_notes,
        inputs=[{
            "main": tk.Audio("会议录音", sources=("upload", "microphone", "system")),
            "additional": [tk.Text("纪要要求", placeholder="例如：重点列出决策、待办和负责人")],
        }],
        outputs=[
            tk.Text("会议摘要"),
            tk.Table("时间线", columns=["时间", "内容"]),
            tk.Text("逐字稿"),
            tk.AudioInfo("录音信息"),
        ],
        title="会议纪要",
        description="上传或录制会议音频。Agent 会完成转写并在右侧给出摘要、待办和可核对的时间线；缺少录音时不会出现第二套设置页。",
    )
