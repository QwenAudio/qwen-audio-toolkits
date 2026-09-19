import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import toolkits as tk
from toolkits.server import make_server


class DesktopIntegrationTests(unittest.TestCase):
    def test_embedding_is_explicit_and_origin_restricted(self):
        for desktop in (False, True):
            server, url = make_server(tk.Interface(lambda text: text, tk.Text(), tk.Text()), desktop=desktop)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                with urllib.request.urlopen(url) as response:
                    csp = response.headers['Content-Security-Policy']
                self.assertEqual('tauri://localhost' in csp, desktop)
                self.assertEqual("frame-ancestors 'none'" in csp, not desktop)
                self.assertNotIn('8787', csp)
            finally:
                server.shutdown()
                server.server_close()
                worker.join()

    def test_cli_resolves_ready_path_before_entering_project(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'project').mkdir()
            (root / 'project/agent_ui.py').write_text('import toolkits as tk\ndef create_ui(): return tk.Interface(lambda x: x, tk.Text(), tk.Text())')
            env = dict(os.environ, PYTHONPATH=str(Path(tk.__file__).resolve().parent.parent))
            child = subprocess.Popen([sys.executable, '-m', 'toolkits', 'project', '--ready-file', 'ready.json', '--no-browser', '--desktop'], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 10
                while not (root / 'ready.json').exists() and child.poll() is None and time.monotonic() < deadline:
                    time.sleep(.05)
                self.assertTrue((root / 'ready.json').exists())
                url = json.loads((root / 'ready.json').read_text())['url']
                with urllib.request.urlopen(url + 'schema') as response:
                    self.assertEqual(json.load(response)['inputs'][0]['main']['kind'], 'text')
            finally:
                child.terminate()
                child.communicate(timeout=5)
