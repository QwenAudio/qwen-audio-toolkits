"""A portable, Agent-owned video dubbing path using Whisper, Bailian text, say and FFmpeg."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import toolkits as tk


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    text: str


def _command(name: str) -> str | None:
    return shutil.which(name)


def _time(value: str) -> float:
    hours, minutes, seconds = value.replace(",", ".").split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def parse_srt(path: Path) -> tuple[Cue, ...]:
    cues: list[Cue] = []
    for block in re.split(r"\n\s*\n", path.read_text(encoding="utf-8-sig", errors="replace").replace("\r\n", "\n")):
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if lines and "-->" not in lines[0]:
            lines = lines[1:]
        if not lines or "-->" not in lines[0]:
            continue
        try:
            start, end = (_time(part.strip()) for part in lines[0].split("-->", 1))
        except ValueError:
            continue
        text = " ".join(lines[1:]).strip()
        if text and end > start:
            cues.append(Cue(start, end, text))
    return tuple(cues[:240])


def _transcribe(video: tk.VideoValue) -> tuple[tuple[Cue, ...], str | None]:
    whisper = _command("whisper")
    if not whisper:
        return (), "本机没有 Whisper 语音识别能力。请先安装 openai-whisper。"
    directory = video.path.parent / "dubbing-transcript"
    directory.mkdir(exist_ok=True)
    try:
        result = subprocess.run([whisper, str(video.path), "--model", "base", "--task", "transcribe", "--output_dir", str(directory), "--output_format", "srt", "--verbose", "False"], capture_output=True, text=True, timeout=20 * 60)
    except subprocess.TimeoutExpired:
        return (), "视频转写超时，请使用更短的视频。"
    except OSError as error:
        return (), f"无法启动 Whisper：{error}"
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()[-1:] or ["未知错误"]
        return (), f"视频转写失败：{detail[0][:240]}"
    srt = directory / f"{video.path.stem}.srt"
    cues = parse_srt(srt) if srt.is_file() else ()
    return cues, None if cues else "没有识别到可用于配音的对白。"


def _target(instruction: str) -> str:
    value = instruction.lower()
    if any(word in value for word in ("英文", "英语", "english")):
        return "English"
    if any(word in value for word in ("日语", "japanese")):
        return "Japanese"
    if any(word in value for word in ("中文", "汉语", "普通话", "chinese", "mandarin")):
        return "Chinese"
    return "same language"


def _chat(prompt: str) -> list[str] | None:
    key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    base = os.environ.get("DASHSCOPE_HTTP_BASE_URL", "").strip().rstrip("/")
    if not key or not base:
        return None
    body = json.dumps({"model": os.environ.get("DASHSCOPE_MODEL", "qwen-plus"), "messages": [
        {"role": "system", "content": "你是视频配音译者。忠实、口语化地翻译或改写每一条对白，保持数组长度和顺序。只返回 JSON 字符串数组，不要解释。"},
        {"role": "user", "content": prompt},
    ], "temperature": 0.3, "max_tokens": 2400}, ensure_ascii=False).encode()
    request = urllib.request.Request(base + "/compatible-mode/v1/chat/completions", data=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = json.loads(response.read())
        content = str(raw["choices"][0]["message"]["content"])
        values = json.loads(content[content.find("["):content.rfind("]") + 1])
        return [str(value).strip() for value in values] if isinstance(values, list) else None
    except (KeyError, ValueError, OSError, urllib.error.URLError, json.JSONDecodeError):
        return None


def _rewrite(cues: tuple[Cue, ...], instruction: str) -> tuple[list[str] | None, str | None]:
    target = _target(instruction)
    if target == "same language" and not any(word in instruction.lower() for word in ("改写", "旁白", "rewrite", "narration")):
        return [cue.text for cue in cues], None
    values = _chat(json.dumps({"targetLanguage": target, "instruction": instruction, "lines": [cue.text for cue in cues]}, ensure_ascii=False))
    if not values or len(values) != len(cues):
        return None, "要翻译或改写配音稿，需要在设置中配置百炼凭据；Agent 不会在这里要求另选文本模型。"
    return values, None


def _speak(text: str, output: Path) -> bool:
    say, ffmpeg = _command("say"), _command("ffmpeg")
    if not say or not ffmpeg:
        return False
    source = output.with_suffix(".txt")
    aiff = output.with_suffix(".aiff")
    source.write_text(text, encoding="utf-8")
    try:
        subprocess.run([say, "-o", str(aiff), "-f", str(source)], check=True, capture_output=True, timeout=90)
        subprocess.run([ffmpeg, "-y", "-i", str(aiff), "-ar", "24000", "-ac", "1", str(output)], check=True, capture_output=True, timeout=90)
        return output.is_file()
    except (OSError, subprocess.SubprocessError):
        return False


def _mix(video: Path, cues: tuple[Cue, ...], lines: list[str]) -> Path | None:
    ffmpeg = _command("ffmpeg")
    if not ffmpeg:
        return None
    directory = video.parent / "dubbed-audio"
    directory.mkdir(exist_ok=True)
    inputs: list[Path] = []
    for index, line in enumerate(lines, 1):
        destination = directory / f"line-{index:03d}.wav"
        if not _speak(line, destination):
            return None
        inputs.append(destination)
    output = video.parent / f"{video.stem}-agent-dubbed.mp4"
    filters = ["[0:a]volume=0.18[bed]"]
    labels = ["[bed]"]
    for index, cue in enumerate(cues, 1):
        label = f"[dub{index}]"
        filters.append(f"[{index}:a]adelay={max(0, round(cue.start * 1000))}:all=1{label}")
        labels.append(label)
    filters.append("".join(labels) + f"amix=inputs={len(labels)}:duration=first:normalize=0[mix]")
    command = [ffmpeg, "-y", "-i", str(video)]
    for item in inputs:
        command.extend(["-i", str(item)])
    command.extend(["-filter_complex", ";".join(filters), "-map", "0:v:0", "-map", "[mix]", "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", str(output)])
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=15 * 60)
        return output if output.is_file() else None
    except (OSError, subprocess.SubprocessError):
        return None


def _clock(seconds: float) -> str:
    whole = max(0, int(seconds))
    return f"{whole // 60:02d}:{whole % 60:02d}"


def dub_video(request: dict):
    instruction: str = request["main"].strip()
    video: tk.VideoValue | None = request["additional"][0]
    if video is None:
        return (None, "", [], "请先说清楚目标语言或配音风格。需要实际生成时，再上传视频素材。")
    if not instruction:
        return (video.path, "", [], "我已收到视频。请告诉我目标语言或希望如何改写配音稿；我会把配音结果直接放到右侧。")
    cues, error = _transcribe(video)
    if error:
        return (video.path, "", [], error)
    lines, error = _rewrite(cues, instruction)
    if error or lines is None:
        return (video.path, "\n".join(cue.text for cue in cues), [[f"{_clock(cue.start)}–{_clock(cue.end)}", cue.text, "等待翻译"] for cue in cues], error or "无法生成配音稿。")
    output = _mix(video.path, cues, lines)
    rows = [[f"{_clock(cue.start)}–{_clock(cue.end)}", cue.text, line] for cue, line in zip(cues, lines)]
    script = "\n".join(f"[{_clock(cue.start)}] {line}" for cue, line in zip(cues, lines))
    if output:
        return (output, script, rows, "配音视频已生成。原声会以较低音量保留在背景中；右侧时间线可以核对每段对白与配音稿。")
    return (video.path, script, rows, "配音稿已生成，但本机缺少可用的系统语音或 FFmpeg，暂不能渲染新视频。")
