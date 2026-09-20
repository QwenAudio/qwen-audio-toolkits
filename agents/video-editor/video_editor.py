"""Local-first deterministic editing helpers for the video editing Agent."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import toolkits as tk


@dataclass(frozen=True)
class VideoMetadata:
    duration: float | None
    width: int | None
    height: int | None
    has_audio: bool


def _command(name: str) -> str | None:
    return shutil.which(name)


def _probe(source: Path) -> VideoMetadata:
    ffprobe = _command("ffprobe")
    if not ffprobe:
        return VideoMetadata(None, None, None, False)
    try:
        completed = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", str(source)],
            check=True, capture_output=True, text=True, timeout=20,
        )
        payload = json.loads(completed.stdout)
        streams = payload.get("streams", [])
        video = next((item for item in streams if item.get("codec_type") == "video"), {})
        duration = float(payload.get("format", {}).get("duration"))
        return VideoMetadata(duration, int(video.get("width")) if video.get("width") else None,
                             int(video.get("height")) if video.get("height") else None,
                             any(item.get("codec_type") == "audio" for item in streams))
    except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError):
        return VideoMetadata(None, None, None, False)


def _seconds(value: str) -> float:
    parts = [float(part) for part in value.strip().split(":")]
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    raise ValueError("invalid timestamp")


def extract_keep_range(instruction: str, duration: float | None) -> tuple[float, float] | None:
    """Find a safe explicit keep range such as '保留 00:10–00:45'."""
    keep_words = r"(?:保留|截取|只留|取|keep|trim|clip)"
    stamp = r"(?:\d{1,2}:\d{2}(?::\d{2})?|\d+(?:\.\d+)?\s*(?:秒|s)?)"
    match = re.search(rf"{keep_words}.{{0,12}}?({stamp})\s*(?:到|至|[-–—~]|to)\s*({stamp})", instruction, re.I)
    if not match:
        return None
    try:
        start = _seconds(re.sub(r"\s*(?:秒|s)$", "", match.group(1), flags=re.I))
        end = _seconds(re.sub(r"\s*(?:秒|s)$", "", match.group(2), flags=re.I))
    except ValueError:
        return None
    if start < 0 or end <= start or (duration is not None and end > duration):
        return None
    return start, end


def _result_path(source: Path) -> Path:
    # Source lives in the SDK request directory, which is removed after the
    # response is encoded. Keep the preview beside it so no edited file leaks.
    return source.parent / f"{source.stem}-agent-preview.mp4"


def _copy_preview(source: Path, destination: Path) -> bool:
    ffmpeg = _command("ffmpeg")
    if not ffmpeg:
        return False
    try:
        subprocess.run([ffmpeg, "-y", "-i", str(source), "-map", "0", "-c", "copy", "-movflags", "+faststart", str(destination)],
                       check=True, capture_output=True, timeout=90)
        return destination.exists()
    except (OSError, subprocess.SubprocessError):
        return False


def _trim(source: Path, destination: Path, start: float, end: float) -> bool:
    ffmpeg = _command("ffmpeg")
    if not ffmpeg:
        return False
    try:
        subprocess.run([ffmpeg, "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(source),
                        "-map", "0", "-c", "copy", "-movflags", "+faststart", str(destination)],
                       check=True, capture_output=True, timeout=90)
        return destination.exists()
    except (OSError, subprocess.SubprocessError):
        return False


def _plan(instruction: str, metadata: VideoMetadata) -> list[list[str]]:
    text = instruction.lower()
    rows: list[list[str]] = []
    if any(word in text for word in ("静音", "停顿", "口头禅", "重复", "silence", "pause", "filler", "repeat")):
        rows.append(["待识别", "标记语音停顿 / 口头禅", "需要先完成语音分析"])
    if any(word in text for word in ("字幕", "caption", "subtitle")):
        rows.append(["全片", "生成字幕", "需要先确认字幕语言"])
    if any(word in text for word in ("竖屏", "9:16", "横屏", "16:9", "封面", "配乐", "音乐")):
        rows.append(["全片", "调整画面或音轨", "需要确认素材和风格"])
    if not rows:
        duration = f"0:00–{metadata.duration:.0f}s" if metadata.duration else "全片"
        rows.append([duration, "建立预览副本", "已准备"])
    return rows


def edit_video(request: dict):
    instruction = request["main"].strip()
    video: tk.VideoValue | None = request["additional"][0]
    if video is None:
        return (None,
                "请先告诉我想怎么剪。需要实际预览或导出时，再在输入区上传视频素材。",
                [["素材", "等待上传视频", "缺少素材"]],
                {"状态": "等待素材"})

    metadata = _probe(video.path)
    info = {
        "文件": video.name,
        "时长": f"{metadata.duration:.2f} 秒" if metadata.duration is not None else "暂未读取",
        "分辨率": f"{metadata.width} × {metadata.height}" if metadata.width and metadata.height else "暂未读取",
        "音轨": "有" if metadata.has_audio else "未检测到或暂未读取",
    }
    if not instruction:
        return (video.path,
                "我已收到视频。告诉我想保留的时间段、要删掉的内容，或最终视频的时长；我会把结果直接更新到右侧。",
                [["全片", "等待剪辑要求", "需要意图"]], info)

    rows = _plan(instruction, metadata)
    keep_range = extract_keep_range(instruction, metadata.duration)
    destination = _result_path(video.path)
    if keep_range:
        start, end = keep_range
        if _trim(video.path, destination, start, end):
            rows.insert(0, [f"{start:.2f}s–{end:.2f}s", "保留该片段", "已生成预览"])
            return (destination,
                    f"已按要求保留 {start:.2f}–{end:.2f} 秒，并把可预览结果放到右侧。接下来可以继续说要加字幕、调整节奏或换一个保留范围。",
                    rows, info)
        rows.insert(0, [f"{start:.2f}s–{end:.2f}s", "保留该片段", "本机 FFmpeg 导出失败"])
        return (video.path, "我识别到要保留的时间段，但本机没有成功导出。右侧先保留原片预览；请检查 FFmpeg 后重试。", rows, info)

    if _copy_preview(video.path, destination):
        return (destination,
                "我已收到剪辑要求，并生成了可审阅预览。对于停顿、口头禅、字幕或画面风格，请继续在对话中补充语言、目标时长和取舍规则；右侧不会再重复让你填参数。",
                rows, info)
    return (video.path,
            "我已收到剪辑要求。右侧先展示原片；本机未找到可用的 FFmpeg，因此还不能导出新文件。补充具体时间段后，我会先生成可审阅的剪辑结果。",
            rows, info)
