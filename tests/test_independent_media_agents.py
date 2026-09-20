import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

import toolkits as tk
from toolkits.server import load_project


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class IndependentMediaAgentTests(unittest.TestCase):
    def test_file_component_roundtrip(self):
        self.assertEqual(tk.File('资料', accept='.txt').schema(), {
            'kind': 'file', 'label': '资料', 'accept': '.txt', 'required': True,
        })

    def test_meeting_srt_summary(self):
        module = load_module('meeting_notes_test', ROOT / 'agents/meeting-notes/meeting_notes.py')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'meeting.srt'
            path.write_text('1\n00:00:01,000 --> 00:00:03,000\n确认周五前完成方案。\n\n2\n00:00:03,000 --> 00:00:05,000\n负责人下周跟进。\n')
            cues = module.parse_srt(path)
        self.assertEqual(len(cues), 2)
        self.assertIn('待办与跟进', module._summary(cues, '列待办'))

    def test_podcast_fallback_is_two_person_dialogue(self):
        module = load_module('podcast_test', ROOT / 'agents/ai-podcast/podcast.py')
        script = module._fallback_script('解释方案', '第一条事实。第二条事实。')
        speakers = {turn['speaker'] for turn in script['turns']}
        self.assertEqual(speakers, {'主持人', '嘉宾'})

    def test_dubbing_same_language_needs_no_cloud_model(self):
        module = load_module('dubbing_test', ROOT / 'agents/video-dubbing/dubbing.py')
        cues = (module.Cue(0, 1, 'hello'),)
        lines, error = module._rewrite(cues, '保留原语言')
        self.assertEqual(lines, ['hello'])
        self.assertIsNone(error)

    def test_all_projects_load_with_shared_sdk(self):
        expected = {
            'meeting-notes': ['text', 'table', 'text', 'audio-info'],
            'ai-podcast': ['audio', 'text', 'table', 'text'],
            'video-dubbing': ['video', 'text', 'table', 'text'],
        }
        for identifier, output_kinds in expected.items():
            with self.subTest(identifier=identifier):
                schema = load_project(ROOT / 'agents' / identifier).schema()
                self.assertEqual([output['kind'] for output in schema['outputs']], output_kinds)
                self.assertEqual(schema['input_mode'], 'grouped')
