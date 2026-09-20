import base64
import importlib.util
import tempfile
import unittest
import sys
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
