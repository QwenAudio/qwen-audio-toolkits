"""Bounded PCM streams shared by SDK callbacks and the local HTTP transport."""
import base64
import queue
import secrets
import threading
import time


class AudioStream:
    """Iterable mono PCM16 chunks; emit complete output snapshots during capture."""
    sample_rate = 16000
    channels = 1
    sample_width = 2

    def __init__(self, emit):
        self._queue = queue.Queue(maxsize=64)
        self._emit = emit
        self.cancelled = threading.Event()
        self.ended = threading.Event()

    def emit(self, result):
        if not self.cancelled.is_set():
            self._emit(result)

    def __iter__(self):
        while not self.cancelled.is_set():
            try:
                yield self._queue.get(timeout=0.2)
            except queue.Empty:
                if self.ended.is_set():
                    return


class StreamSession:
    def __init__(self, ui):
        self.ui = ui
        self.lock = threading.Lock()
        self.updated = time.monotonic()
        self.created = self.updated
        self.sequence = 0
        self.byte_count = 0
        self.outputs = None
        self.version = 0
        self.state = "connecting"
        self.error = None
        self.audio = AudioStream(self.emit)
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def emit(self, result):
        encoded = self.ui.encode_outputs(result)
        with self.lock:
            self.outputs = encoded
            self.version += 1

    def run(self):
        try:
            with self.lock:
                self.state = "recording"
            arg = {"main": self.audio, "additional": []} if self.ui.grouped else self.audio
            result = self.ui.fn(arg)
            if result is not None:
                self.emit(result)
            with self.lock:
                self.state = "cancelled" if self.audio.cancelled.is_set() else "completed"
        except Exception as error:
            with self.lock:
                self.state = "failed"
                self.error = str(error)

    def push(self, body):
        raw = base64.b64decode(body["data"], validate=True)
        if not raw or len(raw) % 2 or len(raw) > 32768:
            raise ValueError("音频片段必须为单声道 PCM16，且不超过 32 KiB")
        with self.lock:
            if self.audio.ended.is_set() or self.state not in ("connecting", "recording"):
                raise ValueError("录音会话已结束")
            if type(body.get("sequence")) is not int or body["sequence"] != self.sequence:
                raise ValueError("音频片段顺序不正确")
            if self.byte_count + len(raw) > 16000 * 2 * 300:
                raise ValueError("实时录音最长 5 分钟")
            try:
                self.audio._queue.put_nowait(raw)
            except queue.Full:
                raise ValueError("识别服务处理过慢，请停止后重试") from None
            self.byte_count += len(raw)
            self.sequence += 1
            self.updated = time.monotonic()

    def snapshot(self):
        with self.lock:
            self.updated = time.monotonic()
            return dict(state=self.state, outputs=self.outputs, version=self.version, error=self.error)

    def finish(self):
        with self.lock:
            if self.state in ("recording", "connecting"):
                self.state = "finishing"
            self.audio.ended.set()

    def cancel(self):
        self.audio.cancelled.set()
        self.audio.ended.set()


class StreamManager:
    def __init__(self, ui):
        self.ui = ui
        self.sessions = {}
        self.lock = threading.Lock()
        self.closed = threading.Event()
        threading.Thread(target=self.reap, daemon=True).start()

    def reap(self):
        while not self.closed.wait(5):
            with self.lock:
                now = time.monotonic()
                for key, session in list(self.sessions.items()):
                    if now - session.updated > 30 or now - session.created > 360:
                        session.cancel()
                        del self.sessions[key]

    def handle(self, action, body):
        with self.lock:
            if action == "start":
                ui = self.ui
                if hasattr(ui, "runtime"):
                    if ui.runtime is None:
                        from .server import load_project
                        ui.runtime = load_project(ui.directory)
                    ui = ui.runtime
                if not ui.streaming:
                    raise ValueError("此 Agent 不支持实时音频")
                if any(s.state not in ("completed", "failed", "cancelled") for s in self.sessions.values()):
                    raise ValueError("已有录音正在进行")
                key = secrets.token_urlsafe(24)
                self.sessions[key] = StreamSession(ui)
                return {"id": key}
            session = self.sessions.get(body.get("id"))
            if session is None:
                raise ValueError("录音会话不存在或已过期")
        if action == "chunk":
            session.push(body)
            return {"ok": True}
        if action == "finish":
            session.finish()
        elif action == "cancel":
            session.cancel()
        elif action != "poll":
            raise ValueError("未知流式操作")
        return session.snapshot()

    def close(self):
        self.closed.set()
        with self.lock:
            for session in self.sessions.values():
                session.cancel()
