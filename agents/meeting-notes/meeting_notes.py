"""Local-first transcription and meeting-note helpers."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
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


def _timestamp(value: str) -> float:
    hours, minutes, seconds = value.replace(",", ".").split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def parse_srt(path: Path) -> tuple[Cue, ...]:
    body = path.read_text(encoding="utf-8-sig", errors="replace").replace("\r\n", "\n")
    cues: list[Cue] = []
    for block in re.split(r"\n\s*\n", body):
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if lines and "-->" not in lines[0]:
            lines = lines[1:]
        if not lines or "-->" not in lines[0]:
            continue
        try:
            start_text, end_text = (value.strip() for value in lines[0].split("-->", 1))
            start, end = _timestamp(start_text), _timestamp(end_text.split()[0])
        except (ValueError, IndexError):
            continue
        text = " ".join(lines[1:]).strip()
        if text and end > start:
            cues.append(Cue(start, end, text))
    return tuple(cues[:2000])


def _transcribe(audio: tk.AudioValue) -> tuple[tuple[Cue, ...], str | None]:
    whisper = _command("whisper")
    if not whisper:
        return (), "本机没有 Whisper 语音识别能力。请安装 openai-whisper 后重新提交录音。"
    output_dir = audio.path.parent / "meeting-transcript"
    output_dir.mkdir(exist_ok=True)
    try:
        result = subprocess.run(
            [whisper, str(audio.path), "--model", "base", "--task", "transcribe", "--output_dir", str(output_dir), "--output_format", "srt", "--verbose", "False"],
            capture_output=True,
            text=True,
            timeout=20 * 60,
        )
    except subprocess.TimeoutExpired:
        return (), "会议转写超时，请拆分录音后重试。"
    except OSError as error:
        return (), f"无法启动 Whisper：{error}"
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()[-1:] or ["未知错误"]
        return (), f"会议转写失败：{detail[0][:240]}"
    srt = output_dir / f"{audio.path.stem}.srt"
    if not srt.is_file():
        return (), "Whisper 没有生成会议逐字稿。"
    cues = parse_srt(srt)
    return cues, None if cues else "没有识别到可用于会议纪要的语音内容。"


def _clock(seconds: float) -> str:
    whole = max(0, int(seconds))
    return f"{whole // 60:02d}:{whole % 60:02d}"


def _summary(cues: tuple[Cue, ...], instruction: str) -> str:
    transcript = " ".join(cue.text for cue in cues)
    sentences = [item.strip() for item in re.split(r"(?<=[。！？!?])\s*", transcript) if item.strip()]
    key_sentences = sentences[: min(6, len(sentences))]
    action_words = ("待办", "行动", "负责", "跟进", "确认", "deadline", "todo", "follow up")
    actions = [sentence for sentence in sentences if any(word in sentence.lower() for word in action_words)][:6]
    requested = instruction.strip()
    parts = ["## 会议摘要", *(f"- {sentence}" for sentence in key_sentences)]
    if actions:
        parts.extend(["", "## 待办与跟进", *(f"- {sentence}" for sentence in actions)])
    else:
        parts.extend(["", "## 待办与跟进", "- 逐字稿中未检测到明确待办；请在对话中补充负责人或截止时间，我会据此重新整理。"])
    if requested:
        parts.extend(["", "## 按本次要求", f"- {requested}"])
    return "\n".join(parts)


def _audio_info(path: Path, cues: tuple[Cue, ...]) -> dict[str, str]:
    duration = cues[-1].end if cues else 0
    ffprobe = _command("ffprobe")
    if ffprobe:
        try:
            raw = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)], capture_output=True, text=True, timeout=20, check=True)
            duration = float(json.loads(raw.stdout)["format"]["duration"])
        except (OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.SubprocessError):
            pass
    return {"文件": path.name, "时长": f"{duration:.2f} 秒" if duration else "暂未读取", "识别片段": str(len(cues))}


def create_meeting_notes(request: dict):
    audio: tk.AudioValue = request["main"]
    instruction: str = request["additional"][0].strip()
    cues, error = _transcribe(audio)
    if error:
        return (f"## 需要补齐能力\n\n{error}", [], "", _audio_info(audio.path, ()))
    timeline = [[f"{_clock(cue.start)}–{_clock(cue.end)}", cue.text] for cue in cues]
    transcript = "\n".join(f"[{_clock(cue.start)}] {cue.text}" for cue in cues)
    return (_summary(cues, instruction), timeline, transcript, _audio_info(audio.path, cues))
