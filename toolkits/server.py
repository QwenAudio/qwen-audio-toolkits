import time
import hashlib
import os
import asyncio
import inspect
import importlib.util
import json
import secrets
import sys
import tempfile
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from . import Interface, report_progress


def load_project(directory, prepare=False):
    root = Path(directory).resolve()
    entry = root / "agent_ui.py"
    if not entry.is_file():
        raise ValueError("项目根目录缺少 agent_ui.py")
    sys.path.insert(0, str(root))
    spec = importlib.util.spec_from_file_location("_toolkits_agent_ui", entry)
    module = importlib.util.module_from_spec(spec)
    report_progress("导入 Agent 代码与 Python 模块")
    spec.loader.exec_module(module)
    factory = getattr(module, "create_ui", None)
    if not callable(factory):
        raise ValueError("agent_ui.py 必须提供 create_ui()")
    if prepare:
        hook = getattr(module, "prepare", None)
        if hook is not None:
            if not callable(hook):
                raise TypeError("prepare 必须是函数")
            result = hook()
            if inspect.isawaitable(result):
                asyncio.run(result)
    report_progress("构建界面，加载 Agent 配置")
    ui = factory()
    if not isinstance(ui, Interface):
        raise TypeError("create_ui() 必须返回 toolkits.Interface")
    report_progress("界面定义已就绪，启动本地服务")
    return ui


def project_fingerprint(directory):
    root = Path(directory).resolve()
    digest = hashlib.sha256(Path(__file__).with_name("__init__.py").read_bytes())
    for folder, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in ('__pycache__', 'venv', 'models', 'node_modules', 'assets'))
        for name in sorted(files):
            if name.endswith('.py') or name in ('requirements.txt', 'pyproject.toml', 'uv.lock'):
                path = Path(folder) / name
                digest.update(str(path.relative_to(root)).encode())
                digest.update(path.read_bytes())
    # Invalidate account-dependent choices without persisting credentials.
    account = {key: value for key, value in os.environ.items() if key.startswith(('DASHSCOPE_', 'COSYVOICE_', 'QWEN_AUDIO_BAILIAN_'))}
    digest.update(json.dumps(account, sort_keys=True).encode())
    return digest.hexdigest()


def cache_project_ui(directory, cache, prepare=False):
    ui = load_project(directory, prepare=prepare)
    path = Path(cache)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps({'fingerprint': project_fingerprint(directory), 'schema': ui.schema(), 'created_at': time.time()}, ensure_ascii=False))
    temporary.replace(path)
    return ui


class CachedProjectUi:
    def __init__(self, directory, schema, cache):
        self.cache = Path(cache)
        self.directory = directory
        self.definition = schema
        self.title = schema['title']
        self.runtime = None

    def schema(self):
        return self.definition

    def refresh_input(self, index):
        if self.runtime is None:
            self.runtime = load_project(self.directory)
        result = self.runtime.refresh_input(index)
        self.definition = self.runtime.schema()
        temporary = self.cache.with_suffix('.tmp')
        temporary.write_text(json.dumps({'fingerprint': project_fingerprint(self.directory), 'schema': self.definition}))
        temporary.replace(self.cache)
        return result

    def invoke(self, inputs, directory):
        if self.runtime is None:
            # Python callbacks are executable objects, never serialized into the UI cache.
            self.runtime = load_project(self.directory)
        return self.runtime.invoke(inputs, directory)


def open_project_ui(directory, cache):
    root = Path(directory).resolve()
    try:
        saved = json.loads(Path(cache).read_text())
        schema = saved['schema']
        if saved['fingerprint'] == project_fingerprint(root) and isinstance(schema, dict) and 'title' in schema:
            report_progress("读取安装时生成的界面，跳过 create_ui()")
            return CachedProjectUi(root, saved['schema'], cache)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    report_progress("项目或账号配置已变化，更新界面缓存")
    runtime = cache_project_ui(root, cache)
    cached = CachedProjectUi(root, runtime.schema(), cache)
    cached.runtime = runtime
    return cached


def make_server(ui, port=0, desktop=False):
    ancestors = "tauri://localhost http://tauri.localhost https://tauri.localhost http://localhost:1420 http://127.0.0.1:1420" if desktop else "'none'"
    token = secrets.token_urlsafe(32)
    lock = threading.Lock()
    from .streaming import StreamManager
    streams = StreamManager(ui)
    history_lock = threading.Lock()
    identity = str(Path(getattr(ui, "directory", Path.cwd())).resolve())
    history_path = (Path.home() / ".qwenaudio-toolkits" / "history" /
                    (hashlib.sha256(identity.encode()).hexdigest() + ".json"))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, body, content_type="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src blob: data:; connect-src 'self'; frame-ancestors " + ancestors)
            self.end_headers()
            self.wfile.write(data)

        def allowed(self):
            host = f"127.0.0.1:{self.server.server_port}"
            return (self.headers.get("Host") == host
                    and self.headers.get("Origin", f"http://{host}") == f"http://{host}")

        def do_GET(self):
            if not self.allowed():
                return self.reply(403, {"error": "Invalid origin"})
            if self.path == f"/{token}/":
                return self.reply(200, Path(__file__).with_name("ui.html").read_bytes(), "text/html; charset=utf-8")
            assets = {"ui-streaming.js": "text/javascript; charset=utf-8", "ui-content.js": "text/javascript; charset=utf-8", "ui.css": "text/css; charset=utf-8", "ui.js": "text/javascript; charset=utf-8"}
            for name, mime in assets.items():
                if self.path == f"/{token}/{name}":
                    return self.reply(200, Path(__file__).with_name(name).read_bytes(), mime)
            if self.path == f"/{token}/history":
                with history_lock:
                    try:
                        saved = json.loads(history_path.read_text())
                    except FileNotFoundError:
                        saved = {"turns": []}
                return self.reply(200, saved)
            if self.path == f"/{token}/schema":
                return self.reply(200, ui.schema())
            self.reply(404, {"error": "Not found"})

        def do_POST(self):
            if not self.allowed() or self.path not in (f"/{token}/run", f"/{token}/refresh", f"/{token}/history", *(f"/{token}/stream/{action}" for action in ("start", "chunk", "poll", "finish", "cancel"))):
                return self.reply(403, {"error": "Invalid request"})
            if self.headers.get("Content-Type") != "application/json":
                return self.reply(415, {"error": "Expected JSON"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if self.path.startswith(f"/{token}/stream/"):
                    if not 0 < size <= 65536:
                        return self.reply(413, {"error": "Audio chunk too large"})
                    self.connection.settimeout(15)
                    body = json.loads(self.rfile.read(size))
                    return self.reply(200, streams.handle(self.path.rsplit("/", 1)[-1], body))
                if self.path == f"/{token}/history":
                    if not 0 < size <= 256 * 1024 * 1024:
                        return self.reply(413, {"error": "History exceeds 256 MiB"})
                    self.connection.settimeout(30)
                    body = json.loads(self.rfile.read(size))
                    if not isinstance(body.get("turns"), list):
                        raise ValueError("Invalid history")
                    with history_lock:
                        history_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                        with tempfile.NamedTemporaryFile(mode="w", dir=history_path.parent, delete=False) as file:
                            temporary = Path(file.name)
                            try:
                                json.dump(body, file, ensure_ascii=False)
                                file.flush()
                                os.fsync(file.fileno())
                            except Exception:
                                temporary.unlink(missing_ok=True)
                                raise
                        temporary.replace(history_path)
                    return self.reply(200, {"ok": True})
                if not 0 < size <= 48 * 1024 * 1024:
                    return self.reply(413, {"error": "Request exceeds 48 MiB or is empty"})
                if not lock.acquire(blocking=False):
                    return self.reply(409, {"error": "Agent is busy"})
                try:
                    self.connection.settimeout(30)
                    body = json.loads(self.rfile.read(size))
                    if self.path == f"/{token}/refresh":
                        return self.reply(200, ui.refresh_input(body['index']))
                    with tempfile.TemporaryDirectory(prefix="toolkits-audio-") as directory:
                        output = ui.invoke(body["inputs"], directory)
                        self.reply(200, {"outputs": output})
                finally:
                    lock.release()
            except Exception as error:
                traceback.print_exc()
                self.reply(400, {"error": str(error)})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    original_close = server.server_close
    def close():
        streams.close()
        original_close()
    server.server_close = close
    return server, f"http://127.0.0.1:{server.server_port}/{token}/"


def serve(ui, port=0, open_browser=True, ready_file=None, desktop=False):
    server, url = make_server(ui, port, desktop=desktop)
    if ready_file:
        destination = Path(ready_file)
        temporary = destination.with_suffix(".tmp")
        temporary.write_text(json.dumps({"url": url, "title": ui.title}))
        temporary.replace(destination)
    print(f"Agent UI: {url}", flush=True)
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    finally:
        server.server_close()
