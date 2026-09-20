"""Video editing Agent entrypoint consumed by QwenAudio Toolkits."""
from video_editor import edit_video
import toolkits as tk


def prepare():
    # FFmpeg enables preview exports; Whisper is checked when a caption request arrives.
    tk.report_progress("检查本机视频处理能力")


def create_ui():
    return tk.Interface(
        fn=edit_video,
        inputs=[{
            "main": tk.Text("剪辑要求", placeholder="例如：保留开头 10–45 秒；给视频加中文字幕；做成 30 秒短视频"),
            "additional": [tk.Video("视频素材", required=False)],
        }],
        outputs=[
            tk.Video("剪辑预览"),
            tk.Text("Agent 回复"),
            tk.Table("剪辑时间线", columns=["区间", "动作", "状态"]),
            tk.Text("字幕文稿"),
            tk.VideoInfo("视频信息"),
        ],
        title="视频剪辑",
        description="把素材和剪辑意图发给 Agent。它会先在对话中补齐缺失信息，再把可预览的剪辑结果放到右侧。",
    )
