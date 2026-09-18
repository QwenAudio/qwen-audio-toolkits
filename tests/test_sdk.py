import base64
import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path
import toolkits as tk
from toolkits.server import load_project, make_server


class AgentUITests(unittest.TestCase):
    def test_audio_round_trip_and_temporary_path(self):
        source = io.BytesIO()
        with wave.open(source, "wb") as file:
            file.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            file.writeframes(b"\0\0" * 1600)
        captured = []

        def callback(audio):
            captured.append(audio.path)
            self.assertTrue(audio.path.is_file())
            return audio, {"bytes": audio.path.stat().st_size}

        ui = tk.Interface(callback, tk.Audio(), [tk.Audio(), tk.AudioInfo()])
        with tempfile.TemporaryDirectory() as directory:
            results = ui.invoke([{"name": "../../outside.wav", "data": base64.b64encode(source.getvalue()).decode()}], directory)
            self.assertEqual(captured[0].parent, Path(directory))
            self.assertEqual(base64.b64decode(results[0]["dataUrl"].split(",")[1]), source.getvalue())
            self.assertEqual(results[1]["bytes"], len(source.getvalue()))
        self.assertFalse(captured[0].exists())

    def test_async_and_contract_failures(self):
        async def callback(text):
            return text.upper()
        ui = tk.Interface(callback, tk.Text(), tk.Text())
        self.assertEqual(ui.invoke(["hello"], "."), ["HELLO"])
        with self.assertRaises(ValueError):
            ui.invoke([], ".")
        invalid = tk.Interface(lambda text: [text], tk.Text(), [tk.Text(), tk.Text()])
        with self.assertRaises(ValueError):
            invalid.invoke(["hello"], ".")

    def test_root_entry_without_manifest_and_separate_business_module(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "agent_ui.py"):
                load_project(root)
            (root / "agent_ui.py").write_text("value = 1")
            with self.assertRaisesRegex(ValueError, "create_ui"):
                load_project(root)
            (root / "agent_ui.py").write_text("def create_ui(): return 'wrong'")
            with self.assertRaises(TypeError):
                load_project(root)
            (root / "arbitrary_business.py").write_text("def process(text): return text.upper()")
            (root / "agent_ui.py").write_text("import toolkits as tk\nfrom arbitrary_business import process\ndef create_ui(): return tk.Interface(process, tk.Text(), tk.Text(), title='Independent')")
            ui = load_project(root)
            self.assertEqual(ui.invoke(["hello"], directory), ["HELLO"])
            self.assertFalse((root / "agent.json").exists())

    def test_http_execution_error_and_origin_boundary(self):
        def process(value):
            if value == "fail":
                raise ValueError("expected failure")
            return value.upper()
        server, url = make_server(tk.Interface(process, tk.Text(), tk.Text()))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        def request(value, origin=None):
            headers = {"Content-Type": "application/json"}
            if origin:
                headers["Origin"] = origin
            return urllib.request.urlopen(urllib.request.Request(url + "run", json.dumps({"inputs": [value]}).encode(), headers), timeout=3)
        try:
            with urllib.request.urlopen(url + "ui.js") as response:
                self.assertIn(b"createScriptProcessor", response.read())
            with request("hello") as response:
                self.assertEqual(json.load(response), {"outputs": ["HELLO"]})
            for value, origin, status in [("fail", None, 400), ("test", "https://example.com", 403)]:
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    request(value, origin)
                self.assertEqual(raised.exception.code, status)
                raised.exception.close()
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(url.replace(url.split("/")[-2], "wrong") + "schema")
            self.assertEqual(raised.exception.code, 404)
            raised.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
