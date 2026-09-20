import base64
import importlib.util
import tempfile
import unittest
import sys
from unittest.mock import patch
from pathlib import Path

import toolkits as tk


AGENT_ROOT = Path(__file__).parents[1] / "agents" / "video-editor"


def load_agent_module():
    spec = importlib.util.spec_from_file_location("video_editor_agent", AGENT_ROOT / "video_editor.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class VideoComponentTests(unittest.TestCase):
    def test_optional_video_can_start_a_conversation(self):
        ui = tk.Interface(lambda request: "waiting" if request["main"] is None else "ready",
                          [{"main": tk.Video(required=False)}], tk.Text())
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(ui.invoke([{"main": None, "additional": []}], directory), ["waiting"])

    def test_video_value_is_passed_to_agent(self):
        ui = tk.Interface(lambda request: request["main"].name,
                          [{"main": tk.Video()}], tk.Text())
        with tempfile.TemporaryDirectory() as directory:
            value = {"name": "sample.mp4", "mimeType": "video/mp4", "data": base64.b64encode(b"video").decode()}
            self.assertEqual(ui.invoke([{"main": value, "additional": []}], directory), ["sample.mp4"])


class VideoEditorPlanTests(unittest.TestCase):
    def test_extracts_explicit_keep_range(self):
        module = load_agent_module()
        self.assertEqual(module.extract_keep_range("保留 00:10–00:45", 60), (10.0, 45.0))
        self.assertIsNone(module.extract_keep_range("保留 00:45–01:10", 60))

    def test_missing_video_returns_a_conversation_prompt(self):
        module = load_agent_module()
        result = module.edit_video({"main": "做一个短视频", "additional": [None]})
        self.assertIsNone(result[0])
        self.assertIn("上传视频", result[1])
        self.assertEqual(result[2][0][2], "缺少素材")


class VideoEditorCaptionTests(unittest.TestCase):
    def test_parses_srt_and_detects_requested_language(self):
        module = load_agent_module()
        with tempfile.TemporaryDirectory() as directory:
            srt = Path(directory) / "captions.srt"
            srt.write_text(
                "1\n00:00:00,250 --> 00:00:01,500\n第一句\n\n"
                "2\n00:00:01,700 --> 00:00:02,800\nSecond line\n",
                encoding="utf-8",
            )
            cues = module._parse_srt(srt)
        self.assertEqual([(cue.start, cue.end, cue.text) for cue in cues], [
            (0.25, 1.5, "第一句"),
            (1.7, 2.8, "Second line"),
        ])
        self.assertTrue(module._caption_requested("给视频加中文字幕"))
        self.assertFalse(module._caption_requested("不要字幕"))
        self.assertEqual(module._subtitle_language("生成英文字幕"), "en")

    def test_caption_request_returns_burned_video_and_transcript(self):
        module = load_agent_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            subtitle = root / "source.srt"
            subtitle.write_text("1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n", encoding="utf-8")
            def burn(_, __, output, ___):
                output.write_bytes(b"captioned")
                return True

            with patch.object(module, "_probe", return_value=module.VideoMetadata(2, 320, 180, True)), \
                 patch.object(module, "_transcribe_srt", return_value=(subtitle, None)), \
                 patch.object(module, "_burn_subtitles", side_effect=burn):
                result = module.edit_video({
                    "main": "给视频加中文字幕",
                    "additional": [tk.VideoValue(source, "source.mp4", "video/mp4")],
                })

            self.assertEqual(result[0], root / "source-agent-captioned.mp4")
            self.assertTrue(result[0].is_file())
            self.assertIn("字幕已烧录", result[1])
            self.assertEqual(result[2][0][2], "已生成 1 条")
            self.assertIn("测试字幕", result[3])
            self.assertEqual(result[4]["字幕"], "已烧录 1 条")
