import tempfile
import unittest
from pathlib import Path
from toolkits.server import load_project

class PrepareTests(unittest.TestCase):
    def test_preparation_is_explicit_and_awaited(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / 'ready'
            (root / 'agent_ui.py').write_text(f"import toolkits as tk\nfrom pathlib import Path\nasync def prepare():\n    Path({str(marker)!r}).write_text('ready')\ndef create_ui():\n    return tk.Interface(fn=lambda x: x, inputs=[tk.Text('Text')], outputs=tk.Text('Result'))\n")
            load_project(root)
            self.assertFalse(marker.exists())
            load_project(root, prepare=True)
            self.assertEqual(marker.read_text(), 'ready')
