"""Source-to-podcast helpers; cloud text is optional and system speech is local."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
import wave
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import toolkits as tk


def _command(name: str) -> str | None:
    return shutil.which(name)


def _read_document(file: tk.FileValue | None) -> tuple[str, str | None]:
    if file is None:
        return "", None
    suffix = file.path.suffix.lower()
    if suffix in {".txt", ".md", ".markdown"}:
        return file.path.read_text(encoding="utf-8", errors="replace"), None
    if suffix == ".docx":
        try:
            with zipfile.ZipFile(file.path) as archive:
                root = ET.fromstring(archive.read("word/document.xml"))
            text = "\n".join(item.text or "" for item in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"))
            return text, None
        except (OSError, KeyError, zipfile.BadZipFile, ET.ParseError):
            return "", "DOCX 无法解析，请改用 TXT、Markdown 或可复制的正文。"
    if suffix == ".pdf":
        pdftotext = _command("pdftotext")
        if not pdftotext:
            return "", "本机没有 PDF 文本提取能力。请安装 poppler，或把正文粘贴到播客要求中。"
        output = file.path.with_suffix(".txt")
        try:
            subprocess.run([pdftotext, str(file.path), str(output)], check=True, capture_output=True, timeout=60)
            return output.read_text(encoding="utf-8", errors="replace"), None
        except (OSError, subprocess.SubprocessError):
            return "", "PDF 文本提取失败，请确认文件不是扫描件或已加密。"
    return "", "暂只支持 TXT、Markdown、DOCX 和 PDF。"


def _chat(messages: list[dict[str, str]]) -> str | None:
    key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    base = os.environ.get("DASHSCOPE_HTTP_BASE_URL", "").strip().rstrip("/")
    if not key or not base:
        return None
    payload = json.dumps({"model": os.environ.get("DASHSCOPE_MODEL", "qwen-plus"), "messages": messages, "temperature": 0.5, "max_tokens": 2200}).encode()
    request = urllib.request.Request(base + "/compatible-mode/v1/chat/completions", data=payload, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            raw = json.loads(response.read())
        return str(raw["choices"][0]["message"]["content"]).strip()
    except (KeyError, OSError, ValueError, urllib.error.URLError):
        return None


def _sentences(source: str) -> list[str]:
    return [item.strip() for item in re.split(r"(?<=[。！？!?])\s*|\n+", source) if item.strip()][:8]


def _fallback_script(instruction: str, source: str) -> dict:
    facts = _sentences(source or instruction)
    topic = instruction.strip() or "这份资料的核心内容"
    turns = [{"speaker": "主持人", "text": f"欢迎收听。今天我们聊聊：{topic[:100]}。"}]
    for fact in facts[:5]:
        turns.extend([
            {"speaker": "嘉宾", "text": fact[:180]},
            {"speaker": "主持人", "text": "这说明了什么？我们也要留意它的适用条件和仍待验证的部分。"},
        ])
    turns.append({"speaker": "主持人", "text": "今天的节目就到这里。欢迎根据原始资料继续核对细节。"})
    return {"title": "AI 播客", "turns": turns[:12]}


def _script(instruction: str, source: str) -> tuple[dict, bool]:
    prompt = {
        "role": "user",
        "content": json.dumps({"instruction": instruction or "清楚解释资料要点与局限", "source": source[:18000]}, ensure_ascii=False),
    }
    raw = _chat([
        {"role": "system", "content": "你是双人知识播客编剧。只使用 source 支持的事实。输出 JSON：{\"title\":string,\"turns\":[{\"speaker\":\"主持人或嘉宾\",\"text\":string}]}; 生成 6 到 12 轮自然中文对话，每轮最多 150 字。"},
        prompt,
    ])
    if raw:
        try:
            candidate = raw[raw.find("{"):raw.rfind("}") + 1]
            parsed = json.loads(candidate)
            turns = [item for item in parsed.get("turns", []) if isinstance(item, dict) and str(item.get("text", "")).strip()]
            if len(turns) >= 2:
                return {"title": str(parsed.get("title") or "AI 播客")[:80], "turns": [{"speaker": "主持人" if str(item.get("speaker", "")) in {"A", "主持人", "host"} else "嘉宾", "text": str(item["text"]).strip()[:220]} for item in turns[:16]]}, True
        except (TypeError, ValueError, json.JSONDecodeError):
            pass
    return _fallback_script(instruction, source), False


def _speak(script: dict, directory: Path) -> tuple[Path | None, str | None]:
    say, ffmpeg = _command("say"), _command("ffmpeg")
    if not say or not ffmpeg:
        return None, "本机缺少系统语音或 FFmpeg，暂不能生成播客音频；脚本已在右侧生成。"
    wavs: list[Path] = []
    for index, turn in enumerate(script["turns"], 1):
        text_file = directory / f"turn-{index:02d}.txt"
        aiff = directory / f"turn-{index:02d}.aiff"
        wav = directory / f"turn-{index:02d}.wav"
        text_file.write_text(turn["text"], encoding="utf-8")
        try:
            subprocess.run([say, "-o", str(aiff), "-f", str(text_file)], check=True, capture_output=True, timeout=90)
            subprocess.run([ffmpeg, "-y", "-i", str(aiff), "-ar", "24000", "-ac", "1", str(wav)], check=True, capture_output=True, timeout=90)
        except (OSError, subprocess.SubprocessError):
            return None, "本机系统语音生成失败；脚本已在右侧生成。"
        wavs.append(wav)
    concat = directory / "podcast.ffconcat"
    concat.write_text("ffconcat version 1.0\n" + "".join(f"file '{path.name}'\n" for path in wavs), encoding="utf-8")
    output = directory / "ai-podcast.wav"
    try:
        subprocess.run([ffmpeg, "-y", "-safe", "0", "-f", "concat", "-i", str(concat), "-ar", "24000", "-ac", "1", str(output)], check=True, capture_output=True, timeout=180)
    except (OSError, subprocess.SubprocessError):
        return None, "播客片段已生成，但音频拼接失败。"
    return output, None


def _placeholder_audio(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / "ai-podcast-waiting.wav"
    with wave.open(str(output), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24_000)
        audio.writeframes(b"\0\0" * 2_400)
    return output


def create_podcast(request: dict):
    instruction: str = request["main"].strip()
    document: tk.FileValue | None = request["additional"][0]
    source, error = _read_document(document)
    working_directory = document.path.parent if document else Path(tempfile.gettempdir())
    if error:
        return (_placeholder_audio(working_directory), "", [], f"## 需要补齐素材\n\n{error}")
    if not instruction and not source.strip():
        return (_placeholder_audio(working_directory), "", [], "请先说明想做什么播客，或上传一份资料文档。")
    script, cloud_used = _script(instruction, source)
    output, audio_error = _speak(script, working_directory)
    rows = [[turn["speaker"], turn["text"]] for turn in script["turns"]]
    written = "\n".join(f"**{turn['speaker']}**：{turn['text']}" for turn in script["turns"])
    message = "已通过已配置的百炼文本能力生成播客脚本，并在右侧放入音频和分镜。" if cloud_used else "已根据资料生成可编辑的播客初稿。配置百炼后，Agent 会用文本能力生成更完整的脚本。"
    if audio_error:
        message += f"\n\n{audio_error}"
    return (output or _placeholder_audio(working_directory), written, rows, message)
