"""Frozen external tools receive system DLL search paths without changing the app's state."""

import asyncio
import os
from unittest.mock import AsyncMock, Mock

import pytest

from server import process_environment as environment


class Kernel:
    def __init__(self, original):
        self.current = original
        self.changes = []

    def GetDllDirectoryW(self, size, buffer):
        if not size:
            return len(self.current) + 1 if self.current else 0
        buffer.value = self.current or ""
        return len(buffer.value)

    def SetDllDirectoryW(self, value):
        self.changes.append(value)
        self.current = value
        return 1


@pytest.fixture
def frozen(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle/_internal"
    bundle.mkdir(parents=True)
    monkeypatch.setattr(environment.sys, "frozen", True, raising=False)
    monkeypatch.setattr(environment.sys, "platform", "win32")
    monkeypatch.setattr(environment.sys, "_MEIPASS", str(bundle), raising=False)
    monkeypatch.setattr(environment.ctypes, "set_last_error", lambda error: None, raising=False)
    monkeypatch.setattr(environment.ctypes, "get_last_error", lambda: 0, raising=False)
    kernel = Kernel(str(bundle))
    monkeypatch.setattr(environment, "_dll_api", lambda: kernel)
    return bundle, kernel


@pytest.mark.asyncio
@pytest.mark.parametrize("platform,frozen", [("win32", False), ("linux", True)])
async def test_source_or_non_windows_spawn_passes_options_unchanged(monkeypatch, platform, frozen):
    monkeypatch.setattr(environment.sys, "platform", platform)
    monkeypatch.setattr(environment.sys, "frozen", frozen, raising=False)
    monkeypatch.setattr(environment, "_dll_api", lambda: pytest.fail("Windows DLL state accessed"))
    process = object()
    spawn = AsyncMock(return_value=process)
    monkeypatch.setattr(environment.asyncio, "create_subprocess_exec", spawn)
    assert await environment.create_external_process("codex", "exec", cwd="fixture") is process
    spawn.assert_awaited_once_with("codex", "exec", cwd="fixture")


@pytest.mark.asyncio
async def test_frozen_spawn_cleans_child_path_and_restores_original(frozen, monkeypatch, tmp_path):
    bundle, kernel = frozen
    outside = tmp_path / "system tools"
    original_path = os.pathsep.join([str(outside), str(bundle), str(bundle / "onnxruntime"), ""])
    source = {"PATH": original_path, "PRESERVE_THIS": "unchanged"}
    process = object()

    async def spawn(*command, **options):
        assert command == ("codex", "exec")
        assert kernel.current is None
        assert options["env"] == {"PATH": str(outside) + os.pathsep, "PRESERVE_THIS": "unchanged"}
        return process

    monkeypatch.setattr(environment.asyncio, "create_subprocess_exec", spawn)
    assert await environment.create_external_process("codex", "exec", env=source) is process
    assert source["PATH"] == original_path
    assert kernel.current == str(bundle)
    assert kernel.changes == [None, str(bundle)]


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [OSError("fixture spawn failed"), asyncio.CancelledError()])
async def test_failed_or_cancelled_launch_restores_dll_directory(frozen, monkeypatch, error):
    bundle, kernel = frozen
    monkeypatch.setattr(environment.asyncio, "create_subprocess_exec", AsyncMock(side_effect=error))
    with pytest.raises(type(error)):
        await environment.create_external_process("codex")
    assert kernel.current == str(bundle)
    assert kernel.changes == [None, str(bundle)]


@pytest.mark.asyncio
async def test_concurrent_launches_do_not_restore_each_others_directory(frozen, monkeypatch):
    bundle, kernel = frozen
    running = 0

    async def spawn(*_command, **_options):
        nonlocal running
        running += 1
        assert running == 1
        assert kernel.current is None
        await asyncio.sleep(0)
        assert kernel.current is None
        running -= 1
        return object()

    monkeypatch.setattr(environment.asyncio, "create_subprocess_exec", spawn)
    await asyncio.gather(*(environment.create_external_process("codex") for _ in range(3)))
    assert kernel.changes == [None, str(bundle)] * 3
    assert kernel.current == str(bundle)


@pytest.mark.asyncio
async def test_explicit_empty_child_environment_is_preserved(frozen, monkeypatch):
    spawn = AsyncMock(return_value=object())
    monkeypatch.setattr(environment.asyncio, "create_subprocess_exec", spawn)
    await environment.create_external_process("codex", env={})
    assert spawn.call_args.kwargs["env"] == {}


@pytest.mark.asyncio
async def test_dll_clear_failure_does_not_launch(frozen, monkeypatch):
    bundle, kernel = frozen
    monkeypatch.setattr(kernel, "SetDllDirectoryW", lambda value: 0)
    spawn = AsyncMock()
    monkeypatch.setattr(environment.asyncio, "create_subprocess_exec", spawn)
    with pytest.raises(OSError, match="无法准备"):
        await environment.create_external_process("codex")
    assert kernel.current == str(bundle)
    spawn.assert_not_called()


@pytest.mark.asyncio
async def test_capture_failure_does_not_change_dll_state(frozen, monkeypatch):
    _, kernel = frozen

    def failed_capture(_kernel):
        raise OSError("fixture capture failed")

    monkeypatch.setattr(environment, "_current_directory", failed_capture)
    spawn = AsyncMock()
    monkeypatch.setattr(environment.asyncio, "create_subprocess_exec", spawn)
    with pytest.raises(OSError, match="fixture capture"):
        await environment.create_external_process("codex")
    assert kernel.changes == []
    spawn.assert_not_called()


@pytest.mark.asyncio
async def test_restore_failure_stops_spawned_process(frozen, monkeypatch):
    _, kernel = frozen
    original_set = kernel.SetDllDirectoryW
    monkeypatch.setattr(kernel, "SetDllDirectoryW", lambda value: original_set(value) if value is None else 0)
    process = Mock(returncode=None)
    process.wait = AsyncMock()
    monkeypatch.setattr(environment.asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    with pytest.raises(OSError, match="无法恢复"):
        await environment.create_external_process("codex")
    process.kill.assert_called_once_with()
    process.wait.assert_awaited_once_with()
