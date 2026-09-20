"""Local-first editing helpers for the video editing Agent."""
from __future__ import annotations

import json
import platform
import re
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import toolkits as tk


@dataclass(frozen=True)
class VideoMetadata:
    duration: float | None
    width: int | None
    height: int | None
    has_audio: bool


@dataclass(frozen=True)
class SubtitleCue:
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class CaptionResult:
    video: Path | None
    cues: tuple[SubtitleCue, ...]
    error: str | None = None


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


def _caption_requested(instruction: str) -> bool:
    text = instruction.lower()
    disabled = re.search(r"(?:不要|不加|关闭|去掉|移除).{0,6}(?:字幕)|(?:without|no|disable|remove).{0,10}(?:captions?|subtitles?)", text, re.I)
    return not bool(disabled) and any(word in text for word in ("字幕", "caption", "subtitle"))


def _subtitle_language(instruction: str) -> str | None:
    text = instruction.lower()
    if any(word in text for word in ("中文", "汉语", "普通话", "chinese", "mandarin")):
        return "zh"
    if any(word in text for word in ("英文", "英语", "english")):
        return "en"
    return None


def _result_path(source: Path, suffix: str = "preview") -> Path:
    # Source lives in the SDK request directory, which is removed after the
    # response is encoded. Keep results beside it until serialization finishes.
    return source.parent / f"{source.stem}-agent-{suffix}.mp4"


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


@lru_cache(maxsize=1)
def _subtitle_filter_available() -> bool:
    ffmpeg = _command("ffmpeg")
    if not ffmpeg:
        return False
    try:
        result = subprocess.run([ffmpeg, "-hide_banner", "-filters"], check=True,
                                capture_output=True, text=True, timeout=20)
        return bool(re.search(r"\bsubtitles\b", result.stdout, re.I))
    except (OSError, subprocess.SubprocessError):
        return False


@lru_cache(maxsize=1)
def _video_encoder_args() -> tuple[str, ...] | None:
    ffmpeg = _command("ffmpeg")
    if not ffmpeg:
        return None
    try:
        listing = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], check=True,
                                 capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for encoder, args in (("h264_videotoolbox", ("-c:v", "h264_videotoolbox", "-q:v", "60")),
                          ("libx264", ("-c:v", "libx264", "-crf", "23", "-preset", "medium")),
                          ("mpeg4", ("-c:v", "mpeg4", "-q:v", "2"))):
        if re.search(rf"^\s*V.*\s{re.escape(encoder)}\s", listing, re.M):
            return args
    return None


def _timestamp(value: str) -> float:
    hours, minutes, seconds = value.replace(",", ".").split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def _parse_srt(path: Path) -> tuple[SubtitleCue, ...]:
    body = path.read_text(encoding="utf-8-sig", errors="replace").replace("\r\n", "\n")
    cues: list[SubtitleCue] = []
    for block in re.split(r"\n\s*\n", body):
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        if "-->" not in lines[0]:
            lines = lines[1:]
        if not lines or "-->" not in lines[0]:
            continue
        start_text, end_text = (part.strip() for part in lines[0].split("-->", 1))
        try:
            start, end = _timestamp(start_text), _timestamp(end_text.split()[0])
        except (ValueError, IndexError):
            continue
        text = "\n".join(lines[1:]).strip()
        if end > start and text:
            cues.append(SubtitleCue(start, end, text))
    return tuple(cues[:500])


def _transcribe_srt(source: Path, language: str | None) -> tuple[Path | None, str | None]:
    whisper = _command("whisper")
    if not whisper:
        return None, "本机没有 Whisper 语音识别能力。请先安装 openai-whisper 后再生成字幕。"
    directory = source.parent / "captions"
    directory.mkdir(exist_ok=True)
    command = [whisper, str(source), "--model", "base", "--task", "transcribe",
               "--output_dir", str(directory), "--output_format", "srt", "--verbose", "False"]
    if language:
        command.extend(["--language", language])
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20 * 60)
    except subprocess.TimeoutExpired:
        return None, "字幕转写超时，请使用更短的视频或稍后重试。"
    except OSError as error:
        return None, f"无法启动 Whisper：{error}"
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()[-1:] or ["未知错误"]
        return None, f"Whisper 转写失败：{detail[0][:240]}"
    srt = directory / f"{source.stem}.srt"
    if not srt.is_file():
        return None, "Whisper 没有生成字幕文件。"
    return srt, None


def _ffmpeg_filter_path(path: Path) -> str:
    return str(path).replace("\\", r"\\").replace("'", r"\'").replace(":", r"\:")


def _burn_with_ffmpeg_subtitles(source: Path, srt: Path, destination: Path) -> bool:
    ffmpeg, encoder = _command("ffmpeg"), _video_encoder_args()
    if not ffmpeg or not encoder:
        return False
    style = "FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=48"
    filter_value = f"subtitles=filename='{_ffmpeg_filter_path(srt)}':force_style='{style}'"
    try:
        subprocess.run([ffmpeg, "-y", "-i", str(source), "-vf", filter_value, "-map", "0:v:0", "-map", "0:a?", *encoder,
                        "-c:a", "copy", "-movflags", "+faststart", str(destination)],
                       check=True, capture_output=True, timeout=10 * 60)
        return destination.is_file()
    except (OSError, subprocess.SubprocessError):
        return False


def _swift_renderer() -> Path | None:
    renderer = Path(__file__).with_name("subtitle_overlays.swift")
    return renderer if platform.system() == "Darwin" and _command("swift") and renderer.is_file() else None


def _ffconcat_path(path: Path) -> str:
    return str(path).replace("'", r"'\\''")


def _burn_with_macos_overlays(source: Path, srt: Path, destination: Path, metadata: VideoMetadata) -> bool:
    renderer, ffmpeg, encoder = _swift_renderer(), _command("ffmpeg"), _video_encoder_args()
    if not renderer or not ffmpeg or not encoder or not metadata.width or not metadata.height or not metadata.duration:
        return False
    cues = _parse_srt(srt)
    if not cues:
        return False
    directory = source.parent / "subtitle-overlays"
    directory.mkdir(exist_ok=True)
    payload = directory / "cues.json"
    payload.write_text(json.dumps({"width": metadata.width, "height": metadata.height,
                                   "cues": [cue.__dict__ for cue in cues]}, ensure_ascii=False))
    try:
        subprocess.run([_command("swift"), str(renderer), str(payload), str(directory)],
                       check=True, capture_output=True, text=True, timeout=5 * 60)
        entries: list[tuple[Path, float]] = []
        cursor = 0.0
        blank = directory / "blank.png"
        for index, cue in enumerate(cues, 1):
            if cue.start > cursor:
                entries.append((blank, cue.start - cursor))
            entries.append((directory / f"cue-{index:03d}.png", cue.end - cue.start))
            cursor = cue.end
        if metadata.duration > cursor:
            entries.append((blank, metadata.duration - cursor))
        concat = directory / "overlays.ffconcat"
        lines = ["ffconcat version 1.0"]
        for image, duration in entries:
            if image.is_file() and duration > 0.01:
                lines.extend([f"file '{_ffconcat_path(image)}'", f"duration {duration:.3f}"])
        if len(lines) <= 1:
            return False
        # The concat demuxer ignores the duration of its final item; duplicate it
        # so the final visible subtitle interval is preserved.
        last_image, _ = entries[-1]
        lines.append(f"file '{_ffconcat_path(last_image)}'")
        concat.write_text("\n".join(lines) + "\n")
        subprocess.run([ffmpeg, "-y", "-safe", "0", "-f", "concat", "-i", str(concat), "-i", str(source),
                        "-filter_complex", "[0:v]format=rgba[subtitle];[1:v][subtitle]overlay=0:0:eof_action=pass[video]",
                        "-map", "[video]", "-map", "1:a?", *encoder, "-c:a", "copy", "-movflags", "+faststart", str(destination)],
                       check=True, capture_output=True, timeout=10 * 60)
        return destination.is_file()
    except (OSError, subprocess.SubprocessError):
        return False


def _burn_subtitles(source: Path, srt: Path, destination: Path, metadata: VideoMetadata) -> bool:
    if _subtitle_filter_available() and _burn_with_ffmpeg_subtitles(source, srt, destination):
        return True
    return _burn_with_macos_overlays(source, srt, destination, metadata)


def _caption_video(source: Path, metadata: VideoMetadata, instruction: str) -> CaptionResult:
    if not metadata.has_audio:
        return CaptionResult(None, (), "视频没有音轨，无法生成字幕。")
    srt, error = _transcribe_srt(source, _subtitle_language(instruction))
    if error:
        return CaptionResult(None, (), error)
    assert srt is not None
    cues = _parse_srt(srt)
    if not cues:
        return CaptionResult(None, (), "没有识别到可用于生成字幕的语音内容。")
    destination = _result_path(source, "captioned")
    if not _burn_subtitles(source, srt, destination, metadata):
        return CaptionResult(None, cues, "字幕已转写，但本机无法烧录到视频。请确认 FFmpeg 支持字幕滤镜，或在 macOS 上安装 Swift。")
    return CaptionResult(destination, cues)


def _subtitle_text(cues: tuple[SubtitleCue, ...]) -> str:
    return "\n".join(f"{cue.start:05.2f}–{cue.end:05.2f}  {cue.text}" for cue in cues)


def _plan(instruction: str, metadata: VideoMetadata) -> list[list[str]]:
    text = instruction.lower()
    rows: list[list[str]] = []
    if any(word in text for word in ("静音", "停顿", "口头禅", "重复", "silence", "pause", "filler", "repeat")):
        rows.append(["待识别", "标记语音停顿 / 口头禅", "需要先完成语音分析"])
    if _caption_requested(instruction):
        rows.append(["全片", "生成并烧录字幕", "准备转写"])
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
                [["素材", "等待上传视频", "缺少素材"]], "", {"状态": "等待素材"})

    metadata = _probe(video.path)
    info = {
        "文件": video.name,
        "时长": f"{metadata.duration:.2f} 秒" if metadata.duration is not None else "暂未读取",
        "分辨率": f"{metadata.width} × {metadata.height}" if metadata.width and metadata.height else "暂未读取",
        "音轨": "有" if metadata.has_audio else "未检测到或暂未读取",
    }
    if not instruction:
        return (video.path,
                "我已收到视频。告诉我想保留的时间段、要删掉的内容、是否生成字幕，或最终视频的时长；我会把结果直接更新到右侧。",
                [["全片", "等待剪辑要求", "需要意图"]], "", info)

    rows = _plan(instruction, metadata)
    keep_range = extract_keep_range(instruction, metadata.duration)
    working_source = video.path
    trimmed = False
    if keep_range:
        start, end = keep_range
        trimmed_path = _result_path(video.path, "trimmed")
        if not _trim(video.path, trimmed_path, start, end):
            rows.insert(0, [f"{start:.2f}s–{end:.2f}s", "保留该片段", "本机 FFmpeg 导出失败"])
            return (video.path, "我识别到要保留的时间段，但本机没有成功导出。右侧先保留原片预览；请检查 FFmpeg 后重试。", rows, "", info)
        working_source = trimmed_path
        trimmed = True
        rows.insert(0, [f"{start:.2f}s–{end:.2f}s", "保留该片段", "已生成预览"])
        metadata = _probe(working_source)

    if _caption_requested(instruction):
        result = _caption_video(working_source, metadata, instruction)
        if result.video:
            rows = [["全片", "生成并烧录字幕", f"已生成 {len(result.cues)} 条"]] + rows
            info["字幕"] = f"已烧录 {len(result.cues)} 条"
            action = "截取并添加字幕" if trimmed else "添加字幕"
            return (result.video,
                    f"已{action}，字幕已烧录到右侧预览的视频中。你可以继续在对话里要求修改字幕语言、保留时间段或编辑节奏。",
                    rows, _subtitle_text(result.cues), info)
        rows = [["全片", "生成并烧录字幕", "未完成"]] + rows
        info["字幕"] = "未生成"
        return (working_source,
                result.error or "字幕生成失败。",
                rows, _subtitle_text(result.cues), info)

    if trimmed:
        return (working_source,
                "已按要求截取片段，并把可预览结果放到右侧。接下来可以继续说要加字幕、调整节奏或换一个保留范围。",
                rows, "", info)

    destination = _result_path(video.path)
    if _copy_preview(video.path, destination):
        return (destination,
                "我已收到剪辑要求，并生成了可审阅预览。对于停顿、口头禅、字幕或画面风格，请继续在对话中补充语言、目标时长和取舍规则；右侧不会再重复让你填参数。",
                rows, "", info)
    return (video.path,
            "我已收到剪辑要求。右侧先展示原片；本机未找到可用的 FFmpeg，因此还不能导出新文件。补充具体时间段后，我会先生成可审阅的剪辑结果。",
            rows, "", info)
