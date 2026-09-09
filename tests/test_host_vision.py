"""Exercise the local CLI boundary without invoking a model or reading credentials."""

import asyncio
import copy
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from server import host_vision
from server.ai_network import ModelConnectionError


async def test_authorization_callback_runs_after_lock_before_creating_files_or_process(cli_boundary):
    lock = asyncio.Lock()
    await lock.acquire()
    host_vision._locks[asyncio.get_running_loop()] = lock
    checked = []

    def before_start():
        checked.append(True)
        assert not cli_boundary.roots and not cli_boundary.calls
        raise ModelConnectionError("连接已失效")

    task = asyncio.create_task(
        host_vision.describe(cli_boundary.image, {}, "识别衣物", before_start=before_start)
    )
    try:
        await asyncio.sleep(0)
        assert not checked and not cli_boundary.roots and not cli_boundary.calls
        lock.release()
        with pytest.raises(ModelConnectionError, match="连接已失效"):
            await task
        assert checked == [True]
        assert not cli_boundary.roots and not cli_boundary.calls
    finally:
        if lock.locked():
            lock.release()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_authorized_callback_allows_one_cli_request(cli_boundary):
    checked = []

    def before_start():
        assert not cli_boundary.roots and not cli_boundary.calls
        checked.append(True)

    result = await host_vision.describe(cli_boundary.image, {}, "识别衣物", before_start=before_start)
    assert checked == [True]
    assert result["name"] == "blue shirt" and len(cli_boundary.calls) == 1


@pytest.mark.parametrize("suffix", [".exe", ""])
def test_executable_resolves_native_path(tmp_path, monkeypatch, suffix):
    binary = tmp_path / ("codex" + suffix)
    binary.write_bytes(b"native fixture")
    monkeypatch.setattr(host_vision.shutil, "which", lambda name: str(binary))
    assert host_vision.executable() == [str(binary.resolve())]
    assert host_vision.available() is True


@pytest.mark.parametrize("suffix", [".cmd", ".bat", ".ps1"])
def test_windows_npm_shim_uses_node_and_entry_without_shell(tmp_path, monkeypatch, suffix):
    shim = tmp_path / ("codex" + suffix)
    shim.write_text("synthetic shim", encoding="utf-8")
    entry = tmp_path / "node_modules/@openai/codex/bin/codex.js"
    entry.parent.mkdir(parents=True)
    entry.write_text("// synthetic fixture", encoding="utf-8")
    node = tmp_path / "node.exe"
    node.write_bytes(b"synthetic node")
    monkeypatch.setattr(host_vision, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(host_vision.shutil, "which", lambda name: str(shim if name == "codex" else node))
    assert host_vision.executable() == [str(node), str(entry.resolve())]


@pytest.mark.parametrize("missing", ["codex", "file", "node", "entry"])
def test_unavailable_cli_does_not_fall_back_to_a_shell(tmp_path, monkeypatch, missing):
    binary = tmp_path / ("codex.cmd" if missing in {"node", "entry"} else "codex.exe")
    if missing != "file":
        binary.write_bytes(b"fixture")
    entry = tmp_path / "node_modules/@openai/codex/bin/codex.js"
    if missing != "entry":
        entry.parent.mkdir(parents=True)
        entry.write_text("// fixture", encoding="utf-8")
    monkeypatch.setattr(host_vision, "os", SimpleNamespace(name="nt"))

    def which(name):
        if name == missing:
            return None
        return str(binary) if name == "codex" else str(tmp_path / "node.exe")

    monkeypatch.setattr(host_vision.shutil, "which", which)
    assert host_vision.executable() is None
    assert host_vision.available() is False


def test_strict_schema_requires_nested_fields_and_preserves_input():
    original = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "default": ""},
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"color": {"type": "string", "default": "unknown"}},
                },
            },
            "detail": {"anyOf": [{"$ref": "#/$defs/detail"}, {"type": "null"}]},
        },
        "required": ["name"],
        "$defs": {
            "detail": {
                "type": "object",
                "properties": {"material": {"type": "string", "default": ""}},
                "additionalProperties": True,
            }
        },
    }
    snapshot = copy.deepcopy(original)
    result = host_vision.strict_schema(original)
    assert original == snapshot
    assert result is not original
    assert result["required"] == ["name", "items", "detail"]
    assert result["additionalProperties"] is False
    assert "default" not in result["properties"]["name"]
    nested = result["properties"]["items"]["items"]
    assert nested["required"] == ["color"]
    assert nested["additionalProperties"] is False
    definition = result["$defs"]["detail"]
    assert definition["required"] == ["material"]
    assert definition["additionalProperties"] is False
    assert "default" not in definition["properties"]["material"]


def test_arguments_attach_only_input_and_keep_restrictive_execution(tmp_path):
    args = host_vision.arguments(["native-codex.exe"], tmp_path)
    assert args[:2] == ["native-codex.exe", "exec"]
    assert args[args.index("--sandbox") + 1] == "read-only"
    assert args[args.index("--image") + 1] == str(tmp_path / "garment.jpg")
    assert args[args.index("--output-schema") + 1] == str(tmp_path / "schema.json")
    assert args[args.index("--output-last-message") + 1] == str(tmp_path / "result.json")
    assert "--ephemeral" in args
    assert "web_search=disabled" in args
    assert args[-1] == "-"
    assert not any("bypass" in arg for arg in args)
    assert "--ignore-rules" not in args
    assert "--approve-for-me" not in args
    assert "approval_policy=never" not in args


class InputPipe:
    def __init__(self, block=False):
        self.data = b""
        self.closed = False
        self.block = block

    def write(self, value):
        self.data += value

    async def drain(self):
        if self.block:
            await asyncio.Event().wait()

    def close(self):
        self.closed = True


class ControlledProcess:
    def __init__(self, *, returncode=0, running=False, stderr_open=False, stdin_block=False, stderr=b""):
        self.pid = 987654321
        self.returncode = None
        self.final_code = returncode
        self.stdin = InputPipe(stdin_block)
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_data(stderr)
        self.stderr_open = stderr_open
        if not stderr_open:
            self.stderr.feed_eof()
        self.release = asyncio.Event()
        self.waiting = asyncio.Event()
        self.killed = False
        if not running:
            self.release.set()

    async def wait(self):
        self.waiting.set()
        await self.release.wait()
        if self.returncode is None:
            self.returncode = self.final_code
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9
        self.release.set()
        if self.stderr_open and not self.stderr.at_eof():
            self.stderr.feed_eof()


@pytest.fixture
def cli_boundary(tmp_path, monkeypatch):
    original_temporary_directory = host_vision.tempfile.TemporaryDirectory
    roots = []
    calls = []
    processes = []
    image = tmp_path / "source.jpg"
    image.write_bytes(b"synthetic image bytes")
    options = {
        "output": b'{"name":"blue shirt","category":"top"}',
        "process": {},
    }

    def temporary_directory(*args, **kwargs):
        value = original_temporary_directory(*args, dir=tmp_path, **kwargs)
        roots.append(Path(value.name))
        return value

    async def spawn(*args, **kwargs):
        root = Path(kwargs["cwd"])
        calls.append(
            {"args": args, "kwargs": kwargs, "schema": json.loads((root / "schema.json").read_text())}
        )
        assert (root / "garment.jpg").read_bytes() == image.read_bytes()
        if options["output"] is not None:
            (root / "result.json").write_bytes(options["output"])
        process = ControlledProcess(**options["process"])
        processes.append(process)
        return process

    def kill_group(pid, sig):
        assert pid == processes[-1].pid
        processes[-1].kill()

    monkeypatch.setattr(host_vision, "executable", lambda: ["synthetic-codex"])
    monkeypatch.setattr(host_vision.tempfile, "TemporaryDirectory", temporary_directory)
    monkeypatch.setattr(host_vision.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(host_vision, "os", SimpleNamespace(name="posix", killpg=kill_group))
    monkeypatch.setattr(host_vision, "signal", SimpleNamespace(SIGKILL=9))
    monkeypatch.setattr(host_vision, "TIMEOUT_SECONDS", 10)
    state = SimpleNamespace(image=image, options=options, roots=roots, calls=calls, processes=processes)
    yield state
    assert all(not root.exists() for root in roots)


SCHEMA = {"type": "object", "properties": {"name": {"type": "string", "default": ""}}}


async def test_describe_returns_json_and_removes_private_temporary_files(cli_boundary):
    state = cli_boundary
    result = await host_vision.describe(state.image, SCHEMA, "Describe only the garment.")
    assert result == {"name": "blue shirt", "category": "top"}
    assert state.processes[0].stdin.closed is True
    assert b"Describe only the garment." in state.processes[0].stdin.data
    assert state.calls[0]["schema"] == {
        "type": "object",
        "properties": {"name": {"type": "string"}},
        "additionalProperties": False,
        "required": ["name"],
    }
    assert all(not root.exists() for root in state.roots)
    assert state.image.read_bytes() == b"synthetic image bytes"


@pytest.mark.parametrize("output", [b"not json", b"[]", b"null", b"\xff\xfe", b"{", b""])
async def test_describe_rejects_malformed_or_nonobject_output(cli_boundary, output):
    cli_boundary.options["output"] = output
    with pytest.raises(ModelConnectionError, match="格式不正确"):
        await host_vision.describe(cli_boundary.image, SCHEMA, "describe")


@pytest.mark.parametrize("output", [None, b" " * 33])
async def test_describe_rejects_missing_and_oversized_result(cli_boundary, monkeypatch, output):
    monkeypatch.setattr(host_vision, "MAX_RESULT_BYTES", 32)
    cli_boundary.options["output"] = output
    with pytest.raises(ModelConnectionError, match="没有返回可用"):
        await host_vision.describe(cli_boundary.image, SCHEMA, "describe")


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        ("authentication failed", "尚未登录"),
        ("HTTP 429 quota exceeded", "额度不足"),
        ("unexpected argument --ephemeral", "版本不支持"),
        ("a provider internal error", "未完成识别"),
    ],
)
async def test_describe_reports_safe_error_without_stderr(cli_boundary, error, expected):
    secret = "synthetic-only-do-not-display"
    cli_boundary.options["process"] = {"returncode": 1, "stderr": f"{error}: {secret}".encode()}
    with pytest.raises(ModelConnectionError, match=expected) as caught:
        await host_vision.describe(cli_boundary.image, SCHEMA, "describe")
    assert secret not in str(caught.value)
    assert error not in str(caught.value)


async def test_missing_cli_reports_installation_without_creating_files(cli_boundary, monkeypatch):
    monkeypatch.setattr(host_vision, "executable", lambda: None)
    with pytest.raises(ModelConnectionError, match="没有找到本机 Codex"):
        await host_vision.describe(cli_boundary.image, SCHEMA, "describe")
    assert cli_boundary.calls == []
    assert cli_boundary.roots == []


async def test_spawn_failure_does_not_reveal_os_message(cli_boundary, monkeypatch):
    async def denied(*args, **kwargs):
        raise PermissionError("private synthetic path and credential")

    monkeypatch.setattr(host_vision.asyncio, "create_subprocess_exec", denied)
    with pytest.raises(ModelConnectionError, match="无法启动本机 Codex") as caught:
        await host_vision.describe(cli_boundary.image, SCHEMA, "describe")
    assert "private" not in str(caught.value)


async def test_timeout_stops_process_and_cleans_temporary_files(cli_boundary, monkeypatch):
    monkeypatch.setattr(host_vision, "TIMEOUT_SECONDS", 0.1)
    cli_boundary.options["process"] = {"running": True}
    with pytest.raises(ModelConnectionError, match="超时"):
        await host_vision.describe(cli_boundary.image, SCHEMA, "describe")
    assert cli_boundary.processes[0].killed is True
    assert all(not root.exists() for root in cli_boundary.roots)


async def test_cancellation_stops_process_and_cleans_temporary_files(cli_boundary, monkeypatch):
    monkeypatch.setattr(host_vision, "TIMEOUT_SECONDS", 10)
    cli_boundary.options["process"] = {"running": True, "stderr_open": True}
    task = asyncio.create_task(host_vision.describe(cli_boundary.image, SCHEMA, "describe"))
    while not cli_boundary.processes:
        await asyncio.sleep(0)
    await cli_boundary.processes[0].waiting.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)
    assert cli_boundary.processes[0].killed is True
    assert all(not root.exists() for root in cli_boundary.roots)


async def test_cancel_while_waiting_for_stderr_removes_reader_and_temporary_files(cli_boundary, monkeypatch):
    monkeypatch.setattr(host_vision, "TIMEOUT_SECONDS", 10)
    cli_boundary.options["process"] = {"stderr_open": True}
    task = asyncio.create_task(host_vision.describe(cli_boundary.image, SCHEMA, "describe"))
    while not cli_boundary.processes or cli_boundary.processes[0].returncode is None:
        await asyncio.sleep(0)
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)
    assert all(not root.exists() for root in cli_boundary.roots)
    assert not any(
        not running.done() and running.get_coro().__qualname__ == "stderr_tail"
        for running in asyncio.all_tasks()
    )


@pytest.mark.parametrize("blocked", ["stdin", "stderr"])
async def test_total_timeout_also_covers_input_and_stderr(cli_boundary, monkeypatch, blocked):
    monkeypatch.setattr(host_vision, "TIMEOUT_SECONDS", 0.1)
    cli_boundary.options["process"] = (
        {"stdin_block": True, "running": True} if blocked == "stdin" else {"stderr_open": True}
    )
    with pytest.raises(ModelConnectionError, match="超时"):
        await asyncio.wait_for(host_vision.describe(cli_boundary.image, SCHEMA, "describe"), 5)
    assert all(not root.exists() for root in cli_boundary.roots)


async def test_concurrent_descriptions_run_one_cli_at_a_time(cli_boundary, monkeypatch):
    monkeypatch.setattr(host_vision, "TIMEOUT_SECONDS", 10)
    cli_boundary.options["process"] = {"running": True}
    first = asyncio.create_task(host_vision.describe(cli_boundary.image, SCHEMA, "first"))
    second = asyncio.create_task(host_vision.describe(cli_boundary.image, SCHEMA, "second"))
    try:
        while not cli_boundary.processes:
            await asyncio.sleep(0)
        await cli_boundary.processes[0].waiting.wait()
        await asyncio.sleep(0)
        assert len(cli_boundary.calls) == 1
        cli_boundary.processes[0].release.set()
        assert (await first)["category"] == "top"
        while len(cli_boundary.processes) < 2:
            await asyncio.sleep(0)
        cli_boundary.processes[1].release.set()
        assert (await second)["category"] == "top"
    finally:
        for task in (first, second):
            if not task.done():
                task.cancel()
        await asyncio.gather(first, second, return_exceptions=True)
    assert cli_boundary.roots[0] != cli_boundary.roots[1]


async def test_stderr_tail_is_bounded_and_accepts_invalid_utf8():
    stream = asyncio.StreamReader()
    stream.feed_data(b"private prefix" + b"x" * 20_000 + b"tail\xff")
    stream.feed_eof()
    result = await host_vision.stderr_tail(stream)
    assert result.endswith("tail\ufffd")
    assert "private prefix" not in result
    assert len(result) <= 16384


async def test_windows_stop_targets_only_owned_process_tree(monkeypatch):
    process = ControlledProcess(running=True, stderr_open=True)
    calls = []
    monkeypatch.setattr(host_vision, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(host_vision.subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)

    def taskkill(args, **kwargs):
        calls.append((args, kwargs))
        assert process.returncode is None

    monkeypatch.setattr(host_vision.subprocess, "run", taskkill)
    await host_vision.stop_process(process)
    assert calls[0][0] == ["taskkill", "/PID", str(process.pid), "/T", "/F"]
    assert calls[0][1]["timeout"] <= 10
    assert calls[0][1]["creationflags"] == 0x08000000
    assert process.killed is True


@pytest.mark.parametrize("outcome", ["timeout", "cancel"])
async def test_real_local_process_is_reaped_and_temporary_files_removed(tmp_path, monkeypatch, outcome):
    image = tmp_path / "input.jpg"
    image.write_bytes(b"synthetic image")
    stub = tmp_path / "local_stub.py"
    stub.write_text(
        "import sys, time\n"
        "from pathlib import Path\n"
        "sys.stdin.buffer.read()\n"
        "Path('started').write_text('ready')\n"
        "sys.stderr.buffer.write(b'x' * 131072)\n"
        "sys.stderr.buffer.flush()\n"
        "time.sleep(30)\n",
        encoding="utf-8",
    )
    original_spawn = asyncio.create_subprocess_exec
    roots = []
    processes = []

    async def spawn(*args, **kwargs):
        roots.append(Path(kwargs["cwd"]))
        process = await original_spawn(*args, **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(host_vision, "executable", lambda: [sys.executable, str(stub)])
    monkeypatch.setattr(host_vision, "arguments", lambda command, root: command)
    monkeypatch.setattr(host_vision.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(host_vision, "TIMEOUT_SECONDS", 0.5 if outcome == "timeout" else 10)
    task = asyncio.create_task(host_vision.describe(image, SCHEMA, "fixture input"))
    try:
        if outcome == "cancel":

            async def ready():
                while not roots or not (roots[0] / "started").exists():
                    await asyncio.sleep(0.01)

            await asyncio.wait_for(ready(), 3)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, 20)
        else:
            with pytest.raises(ModelConnectionError, match="超时"):
                await asyncio.wait_for(task, 20)
        assert len(processes) == 1
        assert processes[0].returncode is not None
        assert not roots[0].exists()
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        for process in processes:
            if process.returncode is None:
                process.kill()
            await process.wait()
