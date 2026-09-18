import base64
import json
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch
import toolkits as tk
from toolkits.server import make_server


class StreamingTests(unittest.TestCase):
    def test_schema_and_contract(self):
        component = tk.StreamingAudio()
        self.assertEqual(component.schema()["kind"], "audio")
        self.assertTrue(component.schema()["streaming"])
        with self.assertRaises(ValueError):
            tk.StreamingAudio(sources=["upload"])
        with self.assertRaises(ValueError):
            tk.Interface(lambda *args: "", [component, tk.Text()], tk.Text())
        with self.assertRaises(ValueError):
            tk.Interface(lambda x: x, tk.Text(), component)

    def test_live_output_before_finish_and_ordering(self):
        def recognize(stream):
            count = 0
            for chunk in stream:
                count += len(chunk)
                stream.emit(str(count))
            return "final:" + str(count)
        ui = tk.Interface(recognize, tk.StreamingAudio(), tk.Text())
        with tempfile.TemporaryDirectory() as root, patch.object(Path, 'home', return_value=Path(root)):
            server, url = make_server(ui)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            def post(action, data):
                request = urllib.request.Request(url + "stream/" + action,
                    data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
                return json.load(urllib.request.urlopen(request, timeout=3))
            try:
                key = post("start", {})["id"]
                post("chunk", {"id": key, "sequence": 0, "data": base64.b64encode(b"\0\0" * 1600).decode()})
                for _ in range(50):
                    interim = post("poll", {"id": key})
                    if interim["outputs"]: break
                    time.sleep(.02)
                self.assertEqual(interim["outputs"], ["3200"])
                self.assertEqual(interim["state"], "recording")
                with self.assertRaises(urllib.error.HTTPError):
                    post("chunk", {"id": key, "sequence": 0, "data": "AAAAAA=="})
                post("finish", {"id": key})
                for _ in range(50):
                    result = post("poll", {"id": key})
                    if result["state"] == "completed": break
                    time.sleep(.02)
                self.assertEqual(result["outputs"], ["final:3200"])
                self.assertEqual(result["state"], "completed")
                next_key = post("start", {})["id"]
                post("cancel", {"id": next_key})
            finally:
                server.shutdown()
                server.server_close()

    def test_callback_failure_surfaces(self):
        def fail(stream):
            raise ValueError("test error")
        from toolkits.streaming import StreamManager
        manager = StreamManager(tk.Interface(fail, tk.StreamingAudio(), tk.Text()))
        try:
            key = manager.handle("start", {})["id"]
            for _ in range(50):
                result = manager.handle("poll", {"id": key})
                if result["state"] == "failed": break
                time.sleep(.01)
            self.assertEqual(result["error"], "test error")
        finally:
            manager.close()
