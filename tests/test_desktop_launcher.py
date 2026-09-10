import argparse
import json

import pytest

from desktop import launcher
from desktop.runtime import DesktopError, InstanceLock, LocalService, private_json


def arguments(data, **overrides):
    return argparse.Namespace(
        data=data, smoke_test=False, window=False, no_window=True, exit_after=1, **overrides
    )


def test_duplicate_launch_activates_exact_instance_without_reopening_store(tmp_path, monkeypatch):
    lock = InstanceLock(tmp_path)
    service = LocalService(tmp_path)
    try:
        assert lock.acquire()
        service.start()
        private_json(lock.directory / "instance.json", service.descriptor())
        monkeypatch.setattr(
            launcher, "LocalService", lambda *args: pytest.fail("must reuse existing service")
        )
        assert launcher.run(arguments(tmp_path)) == {"ok": True, "state": "existing_window"}
        assert service.activation.wait(1)
        assert (lock.directory / "instance.json").exists()
    finally:
        service.stop()
        lock.close()


def test_window_failure_stops_service_and_removes_private_instance(tmp_path, monkeypatch):
    services = []

    def factory(*args):
        service = LocalService(*args)
        services.append(service)
        return service

    def failed_window(*args, **kwargs):
        raise DesktopError("测试窗口无法打开")

    monkeypatch.setattr(launcher, "LocalService", factory)
    monkeypatch.setattr(launcher, "run_window", failed_window)
    args = arguments(tmp_path)
    args.no_window = False
    with pytest.raises(DesktopError, match="窗口无法打开"):
        launcher.run(args)
    assert len(services) == 1 and not services[0].process.is_alive()
    assert not (tmp_path / ".desktop/instance.json").exists()
    recovered = InstanceLock(tmp_path)
    try:
        assert recovered.acquire()
    finally:
        recovered.close()


def test_smoke_uses_isolated_temporary_data_and_reports_no_credentials(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "real-user"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "real-user"))
    paths = []
    real_service = LocalService

    def factory(path, *args):
        paths.append(path)
        return real_service(path, *args)

    monkeypatch.setattr(launcher, "LocalService", factory)
    report = tmp_path / "check.json"
    assert launcher.main(["--smoke-test", "--result", str(report)]) == 0
    data = json.loads(report.read_text(encoding="utf-8"))
    assert data["ok"] and data["authenticated"] and data["interface"]
    assert paths and not paths[0].exists()
    assert not (tmp_path / "real-user").exists()
    output = capsys.readouterr().out
    assert "ticket" not in output and "control_key" not in output and "http://" not in output


def test_bundled_resources_use_frozen_layout(tmp_path, monkeypatch):
    monkeypatch.setattr(launcher.sys, "_MEIPASS", str(tmp_path), raising=False)
    assert launcher.bundle_root() == tmp_path
    with pytest.raises(DesktopError, match="界面资源不完整"):
        launcher.run(arguments(tmp_path / "data"))
    assert not (tmp_path / "data/wardrobe.sqlite3").exists()


def test_headless_exit_cleans_up_descriptor_but_preserves_user_data(tmp_path):
    assert launcher.run(arguments(tmp_path))["ok"]
    assert (tmp_path / "wardrobe.sqlite3").is_file()
    assert not (tmp_path / ".desktop/instance.json").exists()
    config = json.loads((tmp_path / ".desktop/config.json").read_text())
    assert type(config["port"]) is int
    assert list(tmp_path.rglob("*.tmp")) == []
