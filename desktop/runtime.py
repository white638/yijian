from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
from logging.handlers import RotatingFileHandler
import multiprocessing
import os
from pathlib import Path
import re
import secrets
import socket
import time
from typing import Callable
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

VERSION = "0.3.0"
CONTROL_PREFIX = "/_desktop/"
_HEX = re.compile(r"[0-9a-f]{64}\Z")


class DesktopError(Exception):
    pass


def default_data_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    return base / "Yijian/data"


def private_json(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + "." + secrets.token_hex(8) + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def read_json(path: Path) -> dict:
    if path.is_symlink() or path.stat().st_size > 4096:
        raise DesktopError("启动信息无效，请完全退出衣间后重新打开。")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise DesktopError("启动信息无效，请完全退出衣间后重新打开。")
    return value


def configure_service_log(data_dir: Path) -> None:
    directory = data_dir / ".desktop"
    directory.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        directory / "service.log", maxBytes=512 * 1024, backupCount=1, encoding="utf-8"
    )
    handler.setLevel(logging.WARNING)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logging.getLogger().addHandler(handler)
    logging.getLogger().setLevel(logging.WARNING)


class InstanceLock:
    def __init__(self, data_dir: Path):
        self.directory = data_dir / ".desktop"
        if self.directory.is_symlink():
            raise DesktopError("桌面配置目录不能是目录链接，请选择独立的数据目录。")
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.directory / "instance.lock"
        if path.is_symlink():
            raise DesktopError("启动锁文件无效，请选择独立的数据目录。")
        self.file = path.open("a+b")
        self.held = False

    def acquire(self) -> bool:
        if self.held:
            return True
        try:
            if os.name == "nt":
                import msvcrt

                self.file.seek(0, os.SEEK_END)
                if self.file.tell() == 0:
                    self.file.write(b"\0")
                    self.file.flush()
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.held = True
            return True
        except OSError:
            return False

    def close(self) -> None:
        if self.file.closed:
            return
        if self.held:
            if os.name == "nt":
                import msvcrt

                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
        self.file.close()
        self.held = False


def reserve_socket(preferred: int = 0) -> socket.socket:
    for port in dict.fromkeys((preferred, 0)):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if os.name == "nt":
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            listener.bind(("127.0.0.1", port))
            listener.listen(128)
            listener.setblocking(False)
            return listener
        except OSError:
            listener.close()
            if port == 0:
                raise DesktopError("无法启动本机服务，请检查系统网络权限。") from None
    raise DesktopError("无法启动本机服务。")


def signature(key: str, action: str, challenge: str) -> str:
    return hmac.new(
        bytes.fromhex(key), f"yijian-desktop-v1:{action}:{challenge}".encode(), "sha256"
    ).hexdigest()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def control_request(descriptor: dict, action: str) -> bool:
    port, key = descriptor.get("port"), descriptor.get("control_key")
    if (
        type(port) is not int
        or not 1024 <= port <= 65535
        or not isinstance(key, str)
        or not _HEX.fullmatch(key)
    ):
        return False
    challenge = secrets.token_hex(32)
    method = "GET" if action == "ping" else "POST"
    headers = {
        "X-Yijian-Challenge": challenge,
        "X-Yijian-Proof": signature(key, action, challenge),
    }
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        request = Request(f"http://127.0.0.1:{port}{CONTROL_PREFIX}{action}", headers=headers, method=method)
        with opener.open(request, timeout=1) as response:
            proof = response.headers.get("X-Yijian-Proof", "")
            return response.status == 200 and hmac.compare_digest(
                proof, signature(key, "response:" + action, challenge)
            )
    except (OSError, HTTPError, ValueError):
        return False


def activate_existing(directory: Path, timeout: float = 8) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            descriptor = read_json(directory / "instance.json")
            if control_request(descriptor, "ping"):
                return control_request(descriptor, "activate")
        except (OSError, ValueError, DesktopError):
            pass
        time.sleep(0.15)
    return False


class DesktopASGI:
    def __init__(self, app, port: int, control_key: str, ticket: str, activate: Callable[[], None]):
        self.app, self.port, self.control_key = app, port, control_key
        self.ticket = ticket
        self.ticket_expires = time.monotonic() + 120
        self.activate = activate

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith(CONTROL_PREFIX):
            return await self.app(scope, receive, send)
        from starlette.requests import Request as StarletteRequest
        from starlette.responses import JSONResponse, RedirectResponse
        from server.auth import COOKIE, create_browser_session

        scope["app"] = self.app
        request = StarletteRequest(scope, receive)
        origin = f"http://127.0.0.1:{self.port}"
        if (
            request.headers.get("host") != f"127.0.0.1:{self.port}"
            or request.headers.get("origin", origin) != origin
        ):
            response = JSONResponse({"detail": "请从衣间窗口发起操作。"}, status_code=403)
        elif scope["path"] == CONTROL_PREFIX + "open" and scope["method"] == "GET":
            ticket = request.query_params.get("ticket", "")
            if (
                not ticket.isascii()
                or not self.ticket
                or time.monotonic() > self.ticket_expires
                or not hmac.compare_digest(ticket, self.ticket)
            ):
                response = JSONResponse({"detail": "启动链接已失效，请重新打开衣间。"}, status_code=401)
            else:
                self.ticket = ""
                token = await asyncio.to_thread(
                    create_browser_session, request, self.app.state.bootstrap_code
                )
                response = RedirectResponse("/", status_code=303)
                response.set_cookie(COOKIE, token, httponly=True, samesite="strict", path="/")
        else:
            action = scope["path"].removeprefix(CONTROL_PREFIX)
            challenge = request.headers.get("X-Yijian-Challenge", "")
            proof = request.headers.get("X-Yijian-Proof", "")
            expected_method = "GET" if action == "ping" else "POST"
            if (
                action not in {"ping", "activate"}
                or scope["method"] != expected_method
                or not _HEX.fullmatch(challenge)
            ):
                response = JSONResponse({"detail": "接口不存在。"}, status_code=404)
            elif not proof.isascii() or not hmac.compare_digest(
                proof, signature(self.control_key, action, challenge)
            ):
                response = JSONResponse({"detail": "启动请求无效。"}, status_code=403)
            else:
                if action == "activate":
                    self.activate()
                response = JSONResponse(
                    {"ok": True},
                    headers={"X-Yijian-Proof": signature(self.control_key, "response:" + action, challenge)},
                )
        response.headers.update(
            {
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
            }
        )
        await response(scope, receive, send)


def _serve(listener, data_dir: str, key: str, ticket: str, stop, activation, gate, ready) -> None:
    os.environ["YIJIAN_MODEL_CACHE"] = str(Path(data_dir) / "models")
    try:
        # The Windows host assigns the entire service subtree to its lifetime job before work starts.
        if not gate.wait(timeout=30) or stop.is_set():
            return
        configure_service_log(Path(data_dir))
        import uvicorn
        from server.main import create_app

        app = create_app(Path(data_dir))
        wrapped = DesktopASGI(app, listener.getsockname()[1], key, ticket, activation.set)
        config = uvicorn.Config(
            wrapped,
            log_config=None,
            log_level="critical",
            access_log=False,
            lifespan="on",
            timeout_graceful_shutdown=4,
        )
        server = uvicorn.Server(config)

        async def run():
            async def monitor():
                while not server.started and not server.should_exit:
                    await asyncio.sleep(0.025)
                if server.started:
                    ready.send({"ready": True})
                    while not stop.is_set():
                        await asyncio.sleep(0.1)
                server.should_exit = True

            monitor_task = asyncio.create_task(monitor())
            try:
                await server.serve(sockets=[listener])
            finally:
                monitor_task.cancel()
                await asyncio.gather(monitor_task, return_exceptions=True)

        asyncio.run(run())
    except Exception:
        logging.getLogger(__name__).exception("本机服务异常退出")
        try:
            ready.send({"ready": False})
        except OSError:
            pass
    finally:
        ready.close()
        listener.close()


class LocalService:
    def __init__(self, data_dir: Path, preferred_port: int = 0):
        self.data_dir = data_dir
        self.key = secrets.token_hex(32)
        self.ticket = secrets.token_urlsafe(32)
        self.listener = reserve_socket(preferred_port)
        self.port = self.listener.getsockname()[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.context = multiprocessing.get_context("spawn")
        self.stop_event, self.activation = self.context.Event(), self.context.Event()
        self.gate = self.context.Event()
        self.job = None
        self.process = None

    @property
    def launch_url(self):
        return self.origin + CONTROL_PREFIX + "open?ticket=" + self.ticket

    def descriptor(self) -> dict:
        return {"version": 1, "pid": os.getpid(), "port": self.port, "control_key": self.key}

    def start(self, timeout: float = 30):
        parent, child = self.context.Pipe(duplex=False)
        self.process = self.context.Process(
            target=_serve,
            args=(
                self.listener,
                str(self.data_dir),
                self.key,
                self.ticket,
                self.stop_event,
                self.activation,
                self.gate,
                child,
            ),
            name="YijianLocalService",
            daemon=True,
        )
        try:
            if os.name == "nt":
                from desktop.windows_job import WindowsJob

                self.job = WindowsJob()
            self.process.start()
            if self.job is not None:
                self.job.attach(self.process.pid)
            self.gate.set()
            child.close()
            self.listener.close()
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if parent.poll(0.1):
                    if parent.recv().get("ready") and control_request(self.descriptor(), "ping"):
                        return self
                    break
                if not self.process.is_alive():
                    break
            raise DesktopError("衣间服务未能启动，请检查数据目录权限后重试。")
        except (EOFError, OSError):
            raise DesktopError("衣间服务未能启动，请重新打开应用。") from None
        finally:
            parent.close()
            child.close()

    def stop(self) -> bool:
        self.listener.close()
        try:
            if self.process is None or self.process.pid is None:
                return True
            self.stop_event.set()
            self.gate.set()
            self.process.join(timeout=7)
            if self.process.is_alive():
                self.process.terminate()
                self.process.join(timeout=3)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=2)
            return not self.process.is_alive()
        finally:
            if self.job is not None:
                self.job.close()


def prepare_bundled_model(bundle_root: Path, data_dir: Path) -> bool:
    from server.images import MODEL_SHA256

    model = bundle_root / "models/u2netp.onnx"
    target = data_dir / "models/u2netp.onnx"

    def verified(path):
        if not path.is_file() or path.is_symlink():
            return False
        with path.open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest() == MODEL_SHA256

    if verified(target):
        return True
    if not model.exists():
        return False
    if not verified(model):
        raise DesktopError("图片处理组件校验失败，请重新安装衣间。")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(".u2netp-" + secrets.token_hex(8) + ".tmp")
    try:
        with model.open("rb") as source, temporary.open("xb") as destination:
            import shutil

            shutil.copyfileobj(source, destination)
        if not verified(temporary):
            raise DesktopError("图片处理组件复制失败，请检查可用磁盘空间。")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return True
