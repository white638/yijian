import contextlib
import hashlib
import os
from pathlib import Path
import queue
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient

from scripts import start
from server.main import create_app

ROOT = Path(__file__).resolve().parents[1]
WRAPPER = """
import _thread, os, sys, threading, time
from pathlib import Path
from scripts import start
start.ROOT = Path(os.environ['LAUNCH_TEST_ROOT'])
original = start.subprocess.Popen
def tracked(arguments, **options):
    process = original(arguments, **options)
    if 'uvicorn' in arguments:
        Path(os.environ['LAUNCH_TEST_PID']).write_text(str(process.pid))
    return process
start.subprocess.Popen = tracked
def stop():
    while not Path(os.environ['LAUNCH_TEST_STOP']).exists():
        time.sleep(0.05)
    _thread.interrupt_main()
threading.Thread(target=stop, daemon=True).start()
start.main()
"""


@pytest.fixture
def launcher(tmp_path):
    project = tmp_path / "project"
    (project / "web/dist").mkdir(parents=True)
    (project / "web/dist/index.html").write_text("<!doctype html><title>Test</title>")
    return SimpleNamespace(
        project=project,
        data=tmp_path / "data",
        pid=tmp_path / "server.pid",
        stop=tmp_path / "stop",
        environment={
            **os.environ,
            "PYTHONPATH": str(ROOT) + os.pathsep + os.environ.get("PYTHONPATH", ""),
            "PYTHONUTF8": "1",
            "LAUNCH_TEST_ROOT": str(project),
            "LAUNCH_TEST_PID": str(tmp_path / "server.pid"),
            "LAUNCH_TEST_STOP": str(tmp_path / "stop"),
        },
    )


def command(launcher, port):
    return [
        sys.executable,
        "-c",
        WRAPPER,
        "--no-setup",
        "--skip-image-setup",
        "--no-browser",
        "--port",
        str(port),
        "--data",
        str(launcher.data),
    ]


class OtherService(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok":true,"version":"0.2.0"}')

    def log_message(self, *arguments):
        pass


def test_another_service_cannot_receive_a_bootstrap_launch_link(launcher):
    server = ThreadingHTTPServer(("127.0.0.1", 0), OtherService)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        result = subprocess.run(
            command(launcher, server.server_port),
            cwd=launcher.project,
            env=launcher.environment,
            input="",
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        assert result.returncode != 0
        assert "#open=" not in result.stdout
        assert "#open=" not in result.stderr
        assert server.socket.fileno() >= 0
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_free_port_starts_the_correct_workspace_and_stops_cleanly(launcher):
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    process = subprocess.Popen(
        command(launcher, port),
        cwd=launcher.project,
        env=launcher.environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    lines = queue.Queue()
    reader = threading.Thread(target=lambda: [lines.put(line) for line in process.stdout], daemon=True)
    errors = []
    error_reader = threading.Thread(target=lambda: errors.extend(process.stderr), daemon=True)
    reader.start()
    error_reader.start()
    try:
        launch_code = None
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and process.poll() is None:
            try:
                line = lines.get(timeout=0.2)
            except queue.Empty:
                continue
            if "#open=" in line:
                launch_code = line.split("#open=", 1)[1].strip()
                break
        if launch_code is None:
            diagnostic = "".join(errors)[-3000:]
            key_file = launcher.data / ".browser-key"
            if key_file.is_file():
                diagnostic = diagnostic.replace(key_file.read_text(), "[redacted]")
            diagnostic = re.sub(r"#open=\S+", "#open=[redacted]", diagnostic)
            pytest.fail(
                "The launcher did not report a verified service. stderr: " + (diagnostic or "<empty>")
            )
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False) as client:
            health = client.get("/api/health")
            assert health.status_code == 200
            assert len(health.headers["X-Yijian-Instance"]) == 64
            assert launch_code not in health.text
            assert launch_code not in str(health.headers)
            assert client.post("/api/session", json={"code": launch_code}).status_code == 200
            assert client.get("/api/state").json()["items"] == []
        launcher.stop.write_text("stop")
        assert process.wait(timeout=20) == 0
        with socket.socket() as probe:
            assert probe.connect_ex(("127.0.0.1", port)) != 0
    finally:
        if process.poll() is None:
            if launcher.pid.exists():
                with contextlib.suppress(OSError):
                    os.kill(int(launcher.pid.read_text()), signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        reader.join(timeout=5)
        error_reader.join(timeout=5)
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe is not None:
                pipe.close()


def test_health_identifies_the_launch_without_disclosing_secrets(tmp_path, monkeypatch):
    nonce = "test-launch-nonce-distinct-from-login-secret"
    monkeypatch.setenv("YIJIAN_LAUNCH_NONCE", nonce)
    with TestClient(create_app(tmp_path)) as client:
        health = client.get("/api/health")
        fingerprint = hashlib.sha256(nonce.encode()).hexdigest()
        assert health.headers["X-Yijian-Instance"] == fingerprint
        assert nonce not in str(health.headers) + health.text
        assert client.app.state.bootstrap_code not in str(health.headers) + health.text
        assert client.post("/api/session", json={"code": fingerprint}).status_code == 401


def test_unexpected_server_exit_is_reported_as_failure(launcher, monkeypatch):
    monkeypatch.setattr(start, "ROOT", launcher.project)
    monkeypatch.setattr(
        sys,
        "argv",
        ["start", "--no-setup", "--skip-image-setup", "--no-browser", "--data", str(launcher.data)],
    )
    monkeypatch.setattr(start.secrets, "token_urlsafe", lambda _: "test-instance")
    instance = hashlib.sha256(b"test-instance").hexdigest()
    health = SimpleNamespace(status=200, headers={"X-Yijian-Instance": instance})
    opener = SimpleNamespace(open=lambda *args, **kwargs: contextlib.nullcontext(health))
    monkeypatch.setattr(start, "build_opener", lambda *args: opener)
    process = Mock()
    process.poll.side_effect = [None, None, 7, 7]
    process.wait.return_value = 7
    monkeypatch.setattr(start.subprocess, "Popen", lambda *args, **kwargs: process)
    monkeypatch.setattr(start.subprocess, "check_output", lambda *args, **kwargs: "test-bootstrap")
    with pytest.raises(SystemExit) as raised:
        start.main()
    assert raised.value.code != 0
