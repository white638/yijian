"""Backup recovery preserves images and history under conflicting operations."""

from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
import threading
from unittest.mock import patch
from uuid import uuid4
import zipfile

from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from server.backup import FORMAT, make_archive, restore_archive
from server import backup as backup_module
from server.images import ImagePipeline
from server.main import create_app
from server.models import ItemInput
from server.store import Store, initial_state


@pytest.fixture
def backup_case(tmp_path):
    source = Store(tmp_path / "source")
    pictures = ImagePipeline(source.root / "images")
    content = BytesIO()
    Image.new("RGB", (48, 64), "navy").save(content, format="PNG")
    image = pictures.prepare(content.getvalue(), remove_background=False)
    item = {
        **ItemInput(name="蓝色上衣", category="top", confirmed=True).model_dump(),
        "id": str(uuid4()),
        "created_at": "2026-09-09T10:00:00+00:00",
        "updated_at": "2026-09-09T10:00:00+00:00",
        "ai_status": "idle",
        "ai_error": None,
        "image_url": image["image_url"],
        "original_url": image["original_url"],
        "background_status": "skipped",
    }
    source.update(lambda state: state["items"].append(item))
    archive = make_archive(source, pictures)
    target = Store(tmp_path / "target")
    target_images = ImagePipeline(target.root / "images")
    return archive, target, target_images, item


def test_concurrent_restore_does_not_remove_successfully_restored_photo(backup_case):
    archive, store, images, item = backup_case
    ready, resume = threading.Event(), threading.Event()
    update = store.update
    outcomes = []

    def paused_update(callback):
        if threading.current_thread().name == "restore-owner":
            ready.set()
            if not resume.wait(10):
                raise RuntimeError("restore test synchronization timed out")
        return update(callback)

    def first_restore():
        try:
            outcomes.append(restore_archive(store, images, archive))
        except BaseException as error:
            outcomes.append(error)

    with patch.object(store, "update", side_effect=paused_update):
        thread = threading.Thread(target=first_restore, name="restore-owner", daemon=True)
        thread.start()
        try:
            assert ready.wait(5), "first restore did not reach transaction"
            with pytest.raises(HTTPException) as conflict:
                restore_archive(store, images, archive)
            assert conflict.value.status_code == 409
        finally:
            resume.set()
            thread.join(timeout=10)
            assert not thread.is_alive()
    assert len(outcomes) == 1 and isinstance(outcomes[0], dict) and outcomes[0]["ok"]
    assert store.read()["items"][0]["id"] == item["id"]
    assert images.resolve(item["image_url"].rsplit("/", 1)[1]).is_file()


def test_partial_image_write_failure_leaves_no_file_and_can_retry(backup_case):
    archive, store, images, item = backup_case
    original_open = Path.open

    class PartialWrite:
        def __init__(self, handle):
            self.handle = handle

        def __enter__(self):
            return self

        def write(self, content):
            self.handle.write(content[:10])
            self.handle.flush()
            raise OSError("simulated disk full")

        def __exit__(self, *args):
            self.handle.close()

    def failing_open(path, *args, **kwargs):
        handle = original_open(path, *args, **kwargs)
        mode = args[0] if args else kwargs.get("mode", "r")
        return PartialWrite(handle) if path.parent == images.root and mode == "xb" else handle

    with patch.object(Path, "open", new=failing_open), pytest.raises(OSError):
        restore_archive(store, images, archive)
    assert not store.read()["items"]
    assert not list(images.root.iterdir())
    result = restore_archive(store, images, archive)
    assert result["ok"]
    photo = images.resolve(item["image_url"].rsplit("/", 1)[1])
    with Image.open(photo) as picture:
        picture.verify()


def test_restore_lock_is_shared_with_a_separate_process(backup_case):
    archive, store, images, _ = backup_case
    code = "from pathlib import Path\nimport sys\nfrom server.backup import exclusive_restore\nfrom server.store import Store\nwith exclusive_restore(Store(Path(sys.argv[1]))):\n print('locked', flush=True)\n sys.stdin.readline()\n"
    process = subprocess.Popen(
        [sys.executable, "-c", code, str(store.root)],
        cwd=Path(__file__).resolve().parents[1],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout.readline().strip() == "locked"
        with pytest.raises(HTTPException) as conflict:
            restore_archive(store, images, archive)
        assert conflict.value.status_code == 409
        assert not list(images.root.iterdir())
    finally:
        try:
            process.communicate(input="\n", timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.communicate(timeout=10)
        assert process.returncode == 0
    assert restore_archive(store, images, archive)["ok"]


def test_only_care_history_is_not_treated_as_empty_workspace(backup_case):
    archive, store, images, _ = backup_case
    care = {
        "id": str(uuid4()),
        "item_id": str(uuid4()),
        "item_name": "已删除衣物",
        "date": "2026-09-09",
        "action": "wash",
    }
    store.update(lambda state: state["care_events"].append(care))
    with pytest.raises(HTTPException) as conflict:
        restore_archive(store, images, archive)
    assert conflict.value.status_code == 409
    assert store.read()["care_events"] == [care]
    assert not list(images.root.iterdir())


@pytest.mark.parametrize(
    "manifest",
    [
        [],
        None,
        {"format": FORMAT, "version": 1, "data": None},
        {"format": FORMAT, "version": 1, "data": {**initial_state(), "items": [False]}},
    ],
)
def test_malformed_manifest_returns_validation_error_without_writes(tmp_path, manifest):
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
    app = create_app(tmp_path / "workspace")
    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.post("/api/session", json={"code": app.state.bootstrap_code}).status_code == 200
        response = client.post(
            "/api/restore", files={"file": ("backup.zip", buffer.getvalue(), "application/zip")}
        )
        assert response.status_code == 422
        assert not app.state.store.read()["items"]
        assert not list(app.state.images.root.iterdir())


@pytest.fixture
def export_case(backup_case, monkeypatch):
    content, store, images, item = backup_case
    restore_archive(store, images, content)
    monkeypatch.setattr(backup_module, "timestamp", lambda: "2026-09-09T10:00:00+00:00")
    baseline = make_archive(store, images)
    with zipfile.ZipFile(BytesIO(baseline)) as archive:
        entries = archive.infolist()
        manifest = archive.read("manifest.json")
        sizes = {
            "archive": len(baseline),
            "body": archive.start_dir,
            "expanded": sum(entry.file_size for entry in entries),
            "manifest": len(manifest),
            "manifest_characters": len(manifest.decode("utf-8")),
            "image": archive.getinfo("images/" + item["image_url"].rsplit("/", 1)[1]).file_size,
            "largest": max(entry.file_size for entry in entries),
            "entries": len(entries),
        }
    app = create_app(store.root)
    with TestClient(app) as client:
        assert client.post("/api/session", json={"code": app.state.bootstrap_code}).status_code == 200
        yield client, store, images, item, sizes


@pytest.mark.parametrize(
    "limit, measured, message",
    [
        ("MAX_ARCHIVE", "body", "压缩包"),
        ("MAX_EXPANDED", "expanded", "展开"),
        ("MAX_MANIFEST", "manifest_characters", "清单"),
        ("MAX_FILE", "image", "单个文件"),
        ("MAX_ENTRIES", "entries", "文件数量"),
    ],
)
def test_export_capacity_limits_return_explicit_413(export_case, monkeypatch, limit, measured, message):
    client, store, images, item, sizes = export_case
    maximum = sizes[measured]
    if measured not in {"body", "manifest_characters"}:
        maximum -= 1
    assert sizes["body"] < sizes["archive"]
    assert sizes["manifest_characters"] < sizes["manifest"]
    monkeypatch.setattr(backup_module, limit, maximum)
    response = client.get("/api/backup")
    assert response.status_code == 413
    assert message in response.json()["detail"]
    assert "恢复" in response.json()["detail"]
    assert store.read()["items"][0]["id"] == item["id"]
    assert images.resolve(item["image_url"].rsplit("/", 1)[1]).is_file()


def test_export_counts_manifest_toward_per_file_limit(export_case, monkeypatch):
    client, _, _, _, sizes = export_case
    assert sizes["image"] < sizes["manifest"]
    monkeypatch.setattr(backup_module, "MAX_FILE", sizes["manifest"] - 1)
    response = client.get("/api/backup")
    assert response.status_code == 413
    assert "单个文件" in response.json()["detail"]


def test_export_exact_limits_and_duplicate_photo_references_roundtrip(export_case, monkeypatch, tmp_path):
    client, _, images, item, sizes = export_case
    assert item["image_url"] == item["original_url"]
    assert sizes["entries"] == 2
    for name, measured in [
        ("MAX_ARCHIVE", "archive"),
        ("MAX_EXPANDED", "expanded"),
        ("MAX_MANIFEST", "manifest"),
        ("MAX_FILE", "largest"),
        ("MAX_ENTRIES", "entries"),
    ]:
        monkeypatch.setattr(backup_module, name, sizes[measured])
    response = client.get("/api/backup")
    assert response.status_code == 200
    restored = Store(tmp_path / "roundtrip")
    restored_images = ImagePipeline(restored.root / "images")
    assert restore_archive(restored, restored_images, response.content)["ok"]
    assert restored.read()["items"][0]["id"] == item["id"]
    name = item["original_url"].rsplit("/", 1)[1]
    assert restored_images.resolve(name).read_bytes() == images.resolve(name).read_bytes()


def test_export_missing_photo_keeps_original_409_response(export_case):
    client, store, images, item, _ = export_case
    images.resolve(item["image_url"].rsplit("/", 1)[1]).unlink()
    response = client.get("/api/backup")
    assert response.status_code == 409
    assert "照片无法读取" in response.json()["detail"]
    assert store.read()["items"][0]["id"] == item["id"]


@pytest.mark.parametrize("applied", [False, True])
def test_beautified_preview_and_original_survive_backup_without_secrets(backup_case, tmp_path, applied):
    content, store, images, item = backup_case
    restore_archive(store, images, content)
    photo = BytesIO()
    Image.new("RGB", (64, 64), "white").save(photo, format="PNG")
    url = images.beautify(photo.getvalue())["beautified_url"]

    def set_preview(state):
        state["items"][0]["beautified_url"] = url
        if applied:
            state["items"][0]["image_url"] = url
        state["ai"]["beautify_configuration"] = {"encrypted_key": "private-beautify-key"}
        state["ai"]["beautify_jobs"] = {"private-job": {"owner": "private-claim-token"}}

    store.update(set_preview)
    exported = make_archive(store, images)
    with zipfile.ZipFile(BytesIO(exported)) as archive:
        manifest = archive.read("manifest.json")
        assert b"private-beautify-key" not in manifest
        assert b"private-claim-token" not in manifest
    target = Store(tmp_path / "beautified-roundtrip")
    target_images = ImagePipeline(target.root / "images")
    assert restore_archive(target, target_images, exported)["ok"]
    restored = target.read()["items"][0]
    assert restored["beautified_url"] == url
    assert restored["image_url"] == (url if applied else item["original_url"])
    for ref in (url, item["original_url"]):
        name = ref.rsplit("/", 1)[1]
        assert target_images.resolve(name).read_bytes() == images.resolve(name).read_bytes()
    assert target.read()["ai"] == {}


@pytest.mark.parametrize("invalid", ["https://example.com/image.jpg", "/api/images/../../secret", "wrong"])
def test_backup_rejects_invalid_beautified_url(backup_case, invalid):
    content, _, _, _ = backup_case
    data, _ = backup_module.read_archive(content)
    data["items"][0]["beautified_url"] = invalid
    with pytest.raises(ValueError):
        backup_module.validate_data(data)
