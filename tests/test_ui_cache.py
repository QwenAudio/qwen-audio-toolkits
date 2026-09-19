import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from toolkits.server import cache_project_ui, open_project_ui

class CacheTests(unittest.TestCase):
    def test_install_open_invoke_and_invalidation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = root / 'calls.txt'
            entry = root / 'agent_ui.py'
            entry.write_text(f"import toolkits as tk\nfrom pathlib import Path\ndef create_ui():\n    p=Path({str(calls)!r})\n    p.write_text(p.read_text()+'x' if p.exists() else 'x')\n    return tk.Interface(lambda x: x, [tk.Text('input')], tk.Text('output'), title='Sample')\n")
            cache=root/'ui.json'
            cache_project_ui(root, cache, prepare=True)
            self.assertEqual(calls.read_text(), 'x')
            ui=open_project_ui(root, cache)
            self.assertEqual(ui.schema()['title'],'Sample')
            self.assertEqual(calls.read_text(), 'x')
            self.assertEqual(ui.invoke(['hello'], root), ['hello'])
            ui.invoke(['again'], root)
            self.assertEqual(calls.read_text(), 'xx')
            entry.write_text(entry.read_text().replace("title='Sample'", "title='Changed'"))
            self.assertEqual(open_project_ui(root, cache).schema()['title'], 'Changed')
            with patch.dict(os.environ, {'DASHSCOPE_API_KEY':'test-key'}):
                open_project_ui(root, cache)
            self.assertNotIn('test-key', cache.read_text())
            self.assertEqual(calls.read_text(), 'xxxx')

    def test_refresh_updates_saved_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'agent_ui.py').write_text("import toolkits as tk\ndef create_ui():\n    return tk.Interface(lambda x:x, [{'main':tk.Text(), 'additional':[tk.Select('Voice', choices=['old'], refresh=lambda: ['new'])]}], tk.Text())\n")
            cache = root/'ui.json'
            ui = open_project_ui(root, cache)
            self.assertEqual(ui.refresh_input(1)['choices'], ['new'])
            self.assertEqual(open_project_ui(root, cache).schema()['inputs'][0]['additional'][0]['choices'], ['new'])
