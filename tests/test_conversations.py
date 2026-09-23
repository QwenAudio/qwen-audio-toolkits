import hashlib
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import toolkits as tk
from toolkits.server import make_server


def turn(text):
    return {"inputs": [text], "messages": [{"role": "user", "content": [{"kind": "text", "value": text}]}]}


class ConversationHistoryTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        patcher = mock.patch("pathlib.Path.home", return_value=Path(self.home.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def serve(self):
        server, url = make_server(tk.Interface(lambda text: text, tk.Text(), tk.Text()))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(self.stop, server, worker)
        return url

    @staticmethod
    def stop(server, worker):
        server.shutdown()
        server.server_close()
        worker.join()

    @staticmethod
    def read(url, path):
        with urllib.request.urlopen(url + path, timeout=3) as response:
            return json.load(response)

    @staticmethod
    def write(url, path, body):
        request = urllib.request.Request(
            url + path, json.dumps(body).encode(),
            {"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.load(response)

    def history_dir(self):
        identity = str(Path.cwd().resolve())
        key = hashlib.sha256(identity.encode()).hexdigest()
        return Path(self.home.name) / ".qwenaudio-toolkits" / "history" / key

    def test_history_is_scoped_by_conversation(self):
        url = self.serve()
        self.write(url, "history?c=alpha", {"turns": [turn("保留开头十秒")]})
        self.write(url, "history?c=beta", {"turns": [turn("生成中文字幕")]})
        self.assertEqual(self.read(url, "history?c=alpha")["turns"][0]["inputs"], ["保留开头十秒"])
        self.assertEqual(self.read(url, "history?c=beta")["turns"][0]["inputs"], ["生成中文字幕"])
        self.assertEqual(self.read(url, "history"), {"turns": []})

    def test_conversations_are_listed_with_titles_by_recency(self):
        url = self.serve()
        self.write(url, "history?c=alpha", {"turns": [turn("保留开头十秒")]})
        self.write(url, "history?c=beta", {"turns": [turn("生成中文字幕，顺便压缩到三十秒以内的版本")]})
        listing = self.read(url, "conversations")["conversations"]
        self.assertEqual([item["id"] for item in listing], ["beta", "alpha"])
        self.assertEqual(listing[0]["title"], "生成中文字幕，顺便压缩到三十秒以内的版本")
        self.assertTrue(all(item["updated"] > 0 for item in listing))

    def test_conversation_id_rejects_unsafe_values(self):
        url = self.serve()
        for method in (self.read, self.write):
            args = (url, "history?c=..%2F..%2Fevil") if method is self.read else (url, "history?c=..%2F..%2Fevil", {"turns": [turn("越界写入")]})
            with self.assertRaises(urllib.error.HTTPError) as raised:
                method(*args)
            self.assertEqual(raised.exception.code, 400)
            raised.exception.close()
        self.assertFalse((self.history_dir().parent / "evil.json").exists())
        self.assertEqual(self.read(url, "history"), {"turns": []})

    def test_legacy_single_history_migrates_to_default_conversation(self):
        legacy = self.history_dir().with_suffix(".json")
        legacy.parent.mkdir(parents=True)
        legacy.write_text(json.dumps({"turns": [turn("旧对话")]}), encoding="utf-8")
        url = self.serve()
        self.assertEqual(self.read(url, "history")["turns"][0]["inputs"], ["旧对话"])
        self.assertEqual(self.read(url, "history?c=default")["turns"][0]["inputs"], ["旧对话"])
        self.assertFalse(legacy.exists())
        listing = self.read(url, "conversations")["conversations"]
        self.assertEqual([item["id"] for item in listing], ["default"])


if __name__ == "__main__":
    unittest.main()
