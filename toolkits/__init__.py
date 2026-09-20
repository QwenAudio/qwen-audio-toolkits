"""Small UI boundary for otherwise unrestricted Python projects."""
import json
import os
import asyncio
import base64
import inspect
import mimetypes
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypedDict

__version__ = "0.2.0"
__all__ = ["Interface", "Audio", "StreamingAudio", "AudioStream", "Video", "File", "Text", "Number", "Select", "Table", "AudioValue", "VideoValue", "FileValue", "Input", "InputGroup", "InputValue", "AudioInfo", "VideoInfo", "report_progress"]


@dataclass(frozen=True)
class AudioValue:
    """A request-scoped audio file. Copy it if it must outlive the callback."""
    path: Path
    name: str
    mime_type: str
    transcript: str = ""


class Component:
    kind = "text"

    def __init__(self, label=""):
        self.label = label

    def schema(self):
        return {"kind": self.kind, "label": self.label}


class Text(Component):
    def __init__(self, label="", *, placeholder="", value=""):
        super().__init__(label)
        if not isinstance(placeholder, str) or not isinstance(value, str):
            raise TypeError("Text placeholder and value must be strings")
        self.placeholder = placeholder
        self.value = value

    def schema(self):
        return {**super().schema(), "placeholder": self.placeholder, "value": self.value}


class Audio(Component):
    kind = "audio"

    def __init__(self, label="音频", sources=("upload", "microphone", "system"), *, transcript=False):
        super().__init__(label)
        if not sources or set(sources) - {"upload", "microphone", "system"}:
            raise ValueError("Audio sources must be upload, microphone, and/or system")
        self.sources = list(sources)
        self.transcript = bool(transcript)

    def schema(self):
        return {**super().schema(), "sources": self.sources, "transcript": self.transcript}


@dataclass(frozen=True)
class VideoValue:
    """A request-scoped video file. Copy it if it must outlive the callback."""
    path: Path
    name: str
    mime_type: str


class Video(Component):
    """A local video input or previewable video output.

    Use ``required=False`` when the Agent should ask for the video in the
    conversation before it can create a result.
    """
    kind = "video"

    def __init__(self, label="视频", sources=("upload",), *, required=True):
        super().__init__(label)
        if not sources or set(sources) - {"upload"}:
            raise ValueError("Video sources must contain upload")
        self.sources = list(sources)
        self.required = bool(required)

    def schema(self):
        return {**super().schema(), "sources": self.sources, "required": self.required}


@dataclass(frozen=True)
class FileValue:
    """A request-scoped document or data file. Copy it for persistent storage."""
    path: Path
    name: str
    mime_type: str


class File(Component):
    """A generic local file input for Agent-owned document processing."""
    kind = "file"

    def __init__(self, label="文件", *, accept="", required=True):
        super().__init__(label)
        if not isinstance(accept, str):
            raise TypeError("File accept must be a string")
        self.accept = accept
        self.required = bool(required)

    def schema(self):
        return {**super().schema(), "accept": self.accept, "required": self.required}


class StreamingAudio(Audio):
    """Live microphone/system input: mono PCM16 at 16 kHz, maximum five minutes."""
    def __init__(self, label="实时音频", sources=("microphone", "system")):
        if not sources or set(sources) - {"microphone", "system"}:
            raise ValueError("StreamingAudio sources must be microphone and/or system")
        super().__init__(label, sources=sources)

    def schema(self):
        return {**super().schema(), "streaming": True, "sample_rate": 16000}


from .streaming import AudioStream


class Number(Component):
    kind = "number"

    def __init__(self, label="", minimum=None, maximum=None, value=None):
        super().__init__(label)
        self.minimum, self.maximum, self.value = minimum, maximum, value
        for bound in (minimum, maximum):
            if bound is not None and (type(bound) not in (int, float) or not math.isfinite(bound)):
                raise ValueError("Number bounds must be finite")
        if minimum is not None and maximum is not None and minimum > maximum:
            raise ValueError("Invalid Number range")
        if value is not None:
            self.validate(value)

    def validate(self, value):
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError("Expected a finite number")
        if self.minimum is not None and value < self.minimum or self.maximum is not None and value > self.maximum:
            raise ValueError("Number is outside the allowed range")
        return value

    def schema(self):
        return {**super().schema(), "minimum": self.minimum, "maximum": self.maximum, "value": self.value}


class Select(Component):
    kind = "select"

    def __init__(self, label="", choices=(), multiple=False, value=None, placeholder="暂无可选项", refresh=None):
        super().__init__(label)
        self.labels = dict(choices) if isinstance(choices, dict) else {v: v for v in choices}
        if any(not isinstance(v, str) for v in self.labels.values()):
            raise ValueError("Select labels must be strings")
        if refresh is not None and not callable(refresh):
            raise TypeError("Select refresh must be callable")
        self.refresh = refresh
        self.placeholder = placeholder
        self.choices = list(choices)
        if any(not isinstance(v, str) for v in self.choices) or len(set(self.choices)) != len(self.choices):
            raise ValueError("Select requires unique string choices")
        self.multiple = multiple
        self.value = ([] if multiple else (self.choices[0] if self.choices else None)) if value is None else value
        if self.choices or value is not None:
            self.validate(self.value)

    def validate(self, value):
        if not self.choices:
            raise ValueError(self.placeholder)
        values = value if self.multiple else [value]
        if not isinstance(values, list) or any(not isinstance(v, str) or v not in self.choices for v in values) or len(set(values)) != len(values):
            raise ValueError("Invalid selection")
        return value

    def schema(self):
        return {**super().schema(), "choices": self.choices, "labels": self.labels, "placeholder": self.placeholder, "multiple": self.multiple, "value": self.value, "refreshable": self.refresh is not None}


class Table(Component):
    kind = "table"

    def __init__(self, label="", columns=()):
        super().__init__(label)
        self.columns = list(columns)
        if not self.columns or any(not isinstance(v, str) for v in self.columns):
            raise ValueError("Table requires column names")

    def validate(self, value):
        if not isinstance(value, list) or len(value) > 10000:
            raise ValueError("Table requires at most 10000 rows")
        for row in value:
            if not isinstance(row, (list, tuple)) or len(row) != len(self.columns):
                raise ValueError("Table row does not match columns")
            for cell in row:
                if cell is not None and type(cell) not in (str, int, float, bool):
                    raise ValueError("Table cells must be scalar values")
                if isinstance(cell, float) and not math.isfinite(cell):
                    raise ValueError("Table numbers must be finite")
        return value

    def schema(self):
        return {**super().schema(), "columns": self.columns}


class AudioInfo(Component):
    """Display a JSON-serializable dictionary of audio measurements."""
    kind = "audio-info"


class VideoInfo(Component):
    """Display a JSON-serializable dictionary of video measurements."""
    kind = "video-info"


class _MainInput(TypedDict):
    main: Component


class InputGroup(_MainInput, total=False):
    """Declare one main component with optional additional components."""
    additional: list[Component]


class InputValue(TypedDict):
    """One callback argument; additional is always present, even when empty."""
    main: Any
    additional: list[Any]


@dataclass(frozen=True)
class Input:
    """One main input and its optional additional controls."""
    main: Component
    additional: tuple[Component, ...] = ()


class Interface:
    def __init__(self, fn, inputs, outputs, title="Agent", description="", *, submit="auto"):
        self.fn = fn
        declared = list(inputs) if isinstance(inputs, (list, tuple)) else [inputs]
        declared = [{"main": group.main, "additional": group.additional} if isinstance(group, Input) else group for group in declared]
        self.grouped = any(isinstance(group, dict) for group in declared)
        self.inputs = []
        if self.grouped:
            for group in declared:
                if not isinstance(group, dict) or "main" not in group or set(group) - {"main", "additional"}:
                    raise ValueError("Each input group requires main and optional additional")
                additional = group.get("additional", [])
                if not isinstance(additional, (list, tuple)):
                    raise TypeError("additional must be a list of components")
                self.inputs.append({"main": group["main"], "additional": list(additional)})
        else:
            # Keep existing callers working; new projects use explicit input groups.
            self.inputs = [{"main": component, "additional": []} for component in declared]
        self._components = [component for group in self.inputs
                            for component in [group["main"], *group["additional"]]]
        self.outputs = outputs if isinstance(outputs, (list, tuple)) else [outputs]
        self.title, self.description = title, description
        if not callable(fn) or not self.outputs:
            raise ValueError("Interface requires a callable and at least one output")
        if any(not isinstance(c, Component) for c in [*self._components, *self.outputs]):
            raise TypeError("Inputs and outputs must be SDK components")
        if any(isinstance(c, (AudioInfo, VideoInfo)) for c in self._components):
            raise ValueError("AudioInfo and VideoInfo are output components")

        self.streaming = any(isinstance(c, StreamingAudio) for c in self._components)
        if self.streaming and (len(self._components) != 1 or not isinstance(self.inputs[0]["main"], StreamingAudio)):
            raise ValueError("StreamingAudio currently requires one main input without additional inputs")
        if any(isinstance(c, StreamingAudio) for c in self.outputs):
            raise ValueError("StreamingAudio is an input component")
        if submit not in ("auto", "manual", "audio"):
            raise ValueError("submit must be auto, manual, or audio")
        audio_ready = (len(self.inputs) == 1 and isinstance(self.inputs[0]['main'], Audio)
                       and not self.inputs[0]['main'].transcript
                       and not any(isinstance(c, Audio) for c in self.inputs[0]['additional']))
        if submit == 'audio' and not audio_ready:
            raise ValueError("Audio submission requires one main audio without additional audio or transcript")
        self.submit = 'audio' if submit == 'audio' or submit == 'auto' and audio_ready else 'manual'

    def schema(self):
        return {"streaming": self.streaming, "submit": self.submit, "sdk_version": __version__, "title": self.title, "description": self.description,
                "input_mode": "grouped" if self.grouped else "legacy",
                "inputs": [{"main": group["main"].schema(),
                            "additional": [c.schema() for c in group["additional"]]}
                           for group in self.inputs],
                "outputs": [c.schema() for c in self.outputs]}

    def refresh_input(self, index):
        if type(index) is not int or not 0 <= index < len(self._components):
            raise ValueError("Invalid input")
        component = self._components[index]
        if not isinstance(component, Select) or component.refresh is None:
            raise ValueError("Input cannot be refreshed")
        choices = component.refresh()
        if inspect.isawaitable(choices):
            choices = asyncio.run(choices)
        updated = Select(component.label, choices, component.multiple, placeholder=component.placeholder, refresh=component.refresh)
        component.__dict__.update(updated.__dict__)
        return component.schema()

    def invoke(self, values, directory):
        if self.streaming:
            raise ValueError("StreamingAudio requires a live session")
        if not isinstance(values, list) or len(values) != len(self.inputs):
            raise ValueError("Input count does not match the UI")
        if self.grouped:
            flattened = []
            for group, value in zip(self.inputs, values):
                if not isinstance(value, dict) or "main" not in value or set(value) - {"main", "additional"}:
                    raise ValueError("Each input value requires main and optional additional")
                additional = value.get("additional", [])
                if not isinstance(additional, list) or len(additional) != len(group["additional"]):
                    raise ValueError("Additional input count does not match the UI")
                flattened.extend([value["main"], *additional])
            values = flattened
        args = []
        for i, (component, value) in enumerate(zip(self._components, values)):
            if isinstance(component, (Audio, Video, File)):
                media_name = "audio" if isinstance(component, Audio) else "video" if isinstance(component, Video) else "file"
                if value is None and isinstance(component, (Video, File)) and not component.required:
                    args.append(None)
                    continue
                if not isinstance(value, dict):
                    raise ValueError(f"Choose {media_name} first")
                name = Path(str(value.get("name", f"{media_name}.bin"))).name
                try:
                    raw = base64.b64decode(value["data"], validate=True)
                except (KeyError, ValueError) as error:
                    raise ValueError(f"Invalid {media_name} data") from error
                if not raw:
                    raise ValueError(f"{media_name.capitalize()} is empty")
                if len(raw) > 32 * 1024 * 1024:
                    raise ValueError(f"{media_name.capitalize()} input exceeds 32 MiB")
                file = Path(directory) / f"{i}{Path(name).suffix}"
                file.write_bytes(raw)
                mime_type = str(value.get("mimeType", "application/octet-stream"))
                if isinstance(component, Audio):
                    transcript = value.get("transcript", "") if component.transcript else ""
                    if not isinstance(transcript, str):
                        raise ValueError("Audio transcript must be text")
                    args.append(AudioValue(file, name, mime_type, transcript))
                elif isinstance(component, Video):
                    args.append(VideoValue(file, name, mime_type))
                else:
                    args.append(FileValue(file, name, mime_type))
            elif isinstance(component, (Number, Select, Table)):
                args.append(component.validate(value))
            else:
                if not isinstance(value, str):
                    raise ValueError("Text input must be a string")
                args.append(value)
        if self.grouped:
            grouped_args = []
            offset = 0
            for group in self.inputs:
                count = len(group["additional"])
                grouped_args.append({"main": args[offset], "additional": args[offset + 1:offset + 1 + count]})
                offset += 1 + count
            args = grouped_args
        result = self.fn(*args)
        if inspect.isawaitable(result):
            result = asyncio.run(result)
        return self.encode_outputs(result)

    def encode_outputs(self, result):
        results = [result] if len(self.outputs) == 1 else result
        if not isinstance(results, (list, tuple)) or len(results) != len(self.outputs):
            raise ValueError("Callback output count does not match the UI")
        encoded = []
        for component, value in zip(self.outputs, results):
            if isinstance(component, (Audio, Video)):
                if value is None and isinstance(component, Video):
                    encoded.append(None)
                    continue
                file = value.path if isinstance(value, (AudioValue, VideoValue)) else Path(value)
                media_name = "Audio" if isinstance(component, Audio) else "Video"
                if file.stat().st_size > 32 * 1024 * 1024:
                    raise ValueError(f"{media_name} output exceeds 32 MiB")
                default_mime = "audio/wav" if isinstance(component, Audio) else "video/mp4"
                mime = mimetypes.guess_type(str(file))[0] or default_mime
                encoded.append({"dataUrl": f"data:{mime};base64," + base64.b64encode(file.read_bytes()).decode(), "name": file.name})
            elif isinstance(component, (Number, Select, Table)):
                encoded.append(component.validate(value))
            elif isinstance(component, (AudioInfo, VideoInfo)):
                if not isinstance(value, dict):
                    raise ValueError(f"{component.__class__.__name__} requires a dictionary")
                encoded.append(value)
            else:
                encoded.append(str(value))
        return encoded

    def run(self, port=0, open_browser=True):
        from .server import serve
        serve(self, port=port, open_browser=open_browser)


def report_progress(message: str):
    """Show a short startup stage in Toolkits. Never include credentials here."""
    path = os.environ.get("TOOLKITS_STARTUP_PROGRESS")
    if path:
        with open(path, "a", encoding="utf-8") as output:
            output.write(json.dumps(str(message)[:240], ensure_ascii=False) + "\n")
