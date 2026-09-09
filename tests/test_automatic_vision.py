from __future__ import annotations

import asyncio
import io
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from PIL import Image

from server import ai, host_vision
from server.main import create_app

pytestmark = pytest.mark.anyio
DESCRIPTION = {
    "name": "蓝色条纹短袖衬衫",
    "category": "top",
    "colors": ["蓝色", "白色"],
    "seasons": ["spring", "summer"],
    "occasions": ["casual", "work"],
    "tags": ["短袖", "条纹", "宽松"],
    "brand": "",
}
API_PROVIDERS = ["openai", "compatible", "ollama"]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def suite(tmp_path, monkeypatch):
    monkeypatch.setenv("YIJIAN_MODEL_CACHE", str(tmp_path / "models"))
    monkeypatch.setattr(host_vision, "available", lambda: True)
    real_describe = host_vision.describe
    describe = AsyncMock(return_value=DESCRIPTION.copy())
    monkeypatch.setattr(host_vision, "describe", describe)
    app = create_app(tmp_path / "workspace")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        assert (await client.post("/api/session", json={"code": app.state.bootstrap_code})).status_code == 200
        yield SimpleNamespace(
            app=app, store=app.state.store, client=client, describe=describe, real_describe=real_describe
        )


async def configure_host(suite, enabled=True):
    client = suite.client
    assert (await client.put("/api/ai/settings", json={"provider": "codex"})).status_code == 200
    code = (await client.post("/api/ai/connection-code")).json()["code"]
    token = (await client.post("/api/ai/connect", json={"code": code})).json()["access_token"]
    headers = {"Authorization": "Bearer " + token}
    assert (await client.post("/api/ai/connection/verify", headers=headers)).status_code == 200
    if enabled:
        assert (await client.put("/api/ai/automatic-vision", json={"enabled": True})).status_code == 200
    return headers


def photo():
    buffer = io.BytesIO()
    Image.new("RGB", (80, 120), "blue").save(buffer, "JPEG")
    return buffer.getvalue()


async def upload(suite, **kwargs):
    return await suite.client.post(
        "/api/items/upload",
        files={"files": ("IMG_001.jpg", photo(), "image/jpeg")},
        data={"remove_background": "false", **kwargs.pop("data", {})},
        **kwargs,
    )


async def configure_api(suite, provider, vision_model="vision-model"):
    response = await suite.client.put(
        "/api/ai/settings",
        json={
            "provider": provider,
            "base_url": "http://127.0.0.1:11434/v1" if provider == "ollama" else "https://model.example/v1",
            "text_model": "text-model",
            "vision_model": vision_model,
            **({"api_key": "not-a-real-api-key"} if provider == "openai" else {}),
        },
    )
    assert response.status_code == 200
    return response.json()


async def test_automatic_vision_requires_explicit_browser_opt_in_and_verified_codex(suite, monkeypatch):
    client = suite.client
    initial = (await client.get("/api/ai/settings")).json()
    assert initial["automatic_vision"]["supported"] is False
    assert (await client.put("/api/ai/automatic-vision", json={"enabled": True})).status_code == 409
    host = (await client.put("/api/ai/settings", json={"provider": "codex"})).json()
    assert host["automatic_vision"]["supported"] and not host["automatic_vision"]["enabled"]
    assert (await client.put("/api/ai/automatic-vision", json={"enabled": True})).status_code == 409
    code = (await client.post("/api/ai/connection-code")).json()["code"]
    token = (await client.post("/api/ai/connect", json={"code": code})).json()["access_token"]
    headers = {"Authorization": "Bearer " + token}
    assert (await client.put("/api/ai/automatic-vision", json={"enabled": True})).status_code == 409
    assert (await client.post("/api/ai/connection/verify", headers=headers)).status_code == 200
    assert (
        await client.put("/api/ai/automatic-vision", json={"enabled": True}, headers=headers)
    ).status_code == 403
    monkeypatch.setattr(host_vision, "available", lambda: False)
    assert (await client.put("/api/ai/automatic-vision", json={"enabled": True})).status_code == 409
    monkeypatch.setattr(host_vision, "available", lambda: True)
    enabled = (await client.put("/api/ai/automatic-vision", json={"enabled": True})).json()
    assert enabled["automatic_vision"] == {"supported": True, "enabled": True, "ready": True, "reason": ""}
    assert enabled["capabilities"] == {"vision": True, "text": False}
    assert (
        await client.put("/api/ai/settings", json={"provider": "codex", "automatic_vision": True})
    ).status_code == 422
    suite.describe.assert_not_awaited()


async def test_automatic_vision_preserves_same_provider_settings_and_closes_on_switch(suite):
    await configure_host(suite)
    saved = (await suite.client.put("/api/ai/settings", json={"provider": "codex"})).json()
    assert saved["automatic_vision"]["enabled"] and saved["automatic_vision"]["ready"]
    disabled = (await suite.client.put("/api/ai/automatic-vision", json={"enabled": False})).json()
    assert disabled["assistant_connected"] and not disabled["automatic_vision"]["enabled"]
    assert disabled["capabilities"] == {"vision": False, "text": False}
    await suite.client.put("/api/ai/automatic-vision", json={"enabled": True})
    changed = (await suite.client.put("/api/ai/settings", json={"provider": "claude-code"})).json()
    assert not changed["automatic_vision"]["enabled"] and not changed["automatic_vision"]["supported"]
    assert not suite.store.read()["ai"]["configuration"]["automatic_vision"]
    assert (await suite.client.put("/api/ai/automatic-vision", json={"enabled": True})).status_code == 409


async def test_browser_upload_automatically_uses_host_photo_and_saves_reviewable_information(
    suite, monkeypatch
):
    await configure_host(suite)
    model_api = AsyncMock()
    monkeypatch.setattr(ai, "completion", model_api)
    response = await upload(suite)
    assert response.status_code == 200
    saved = suite.store.read()["items"][0]
    assert saved["name"] == DESCRIPTION["name"] and saved["category"] == "top"
    assert saved["tags"] == DESCRIPTION["tags"] and saved["occasions"] == DESCRIPTION["occasions"]
    assert saved["ai_status"] == "review" and saved["confirmed"] is False
    assert saved["price"] is None and saved["ai_error"] is None
    assert saved["updated_at"] != saved["created_at"]
    path, schema, prompt = suite.describe.await_args.args
    assert path.is_file() and path.name in saved["image_url"]
    assert set(schema["properties"]) == set(DESCRIPTION)
    assert "袖长" in prompt and "图案" in prompt and "版型" in prompt and "不要猜价格" in prompt
    model_api.assert_not_awaited()
    assert suite.store.read()["ai"]["jobs"] == {}


@pytest.mark.parametrize("mode", ["upload_opt_out", "disabled", "unverified", "assistant"])
async def test_upload_does_not_invoke_codex_without_browser_and_image_permission(suite, mode):
    headers = await configure_host(suite, enabled=mode != "disabled")
    if mode == "unverified":
        suite.store.update(lambda state: state["assistant_sessions"][0].update(verified_at=None))
    response = await upload(
        suite,
        data={"auto_analyze": "false"} if mode == "upload_opt_out" else {},
        headers=headers if mode == "assistant" else {},
    )
    assert response.status_code == 200
    suite.describe.assert_not_awaited()
    saved = suite.store.read()["items"][0]
    assert saved["name"] == "IMG_001" and saved["ai_status"] == "idle" and saved["confirmed"] is False
    if mode == "assistant":
        response = await suite.client.post(f"/api/ai/analyze/{saved['id']}", headers=headers)
        assert response.status_code == 403


@pytest.mark.parametrize("provider", API_PROVIDERS)
async def test_api_and_local_models_share_upload_opt_out_and_complete_review_fields(
    suite, monkeypatch, provider
):
    await configure_api(suite, provider)
    recognized = {
        **DESCRIPTION,
        "brand": "图片中可见的品牌",
        "tags": ["条纹", "短袖", "条纹"],
        "price": "888",
    }
    api_model = AsyncMock(return_value=json.dumps(recognized, ensure_ascii=False))
    monkeypatch.setattr(ai, "completion", api_model)
    assert (await upload(suite, data={"auto_analyze": "false"})).status_code == 200
    api_model.assert_not_awaited()
    assert (await upload(suite)).status_code == 200
    api_model.assert_awaited_once()
    item = suite.store.read()["items"][1]
    for field in ("name", "category", "colors", "seasons", "occasions", "brand"):
        assert item[field] == recognized[field]
    assert item["tags"] == ["条纹", "短袖"]
    assert item["confirmed"] is False and item["ai_status"] == "review"
    assert item["price"] is None and item["image_url"] == item["original_url"]
    assert item["updated_at"] != item["created_at"]
    configuration, messages = api_model.await_args.args
    assert configuration["provider"] == provider
    assert api_model.await_args.kwargs["model"] == "vision-model"
    assert "袖长" in messages[0]["content"] and "不要猜价格" in messages[0]["content"]
    assert messages[1]["content"][0]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    suite.describe.assert_not_awaited()


@pytest.mark.parametrize("provider", API_PROVIDERS)
@pytest.mark.parametrize("mode", ["missing_vision", "unsupported_images"])
async def test_models_without_image_capability_keep_metadata_and_report_a_clear_failure(
    suite, monkeypatch, provider, mode
):
    configured = await configure_api(suite, provider, "" if mode == "missing_vision" else "vision-model")
    failure = "请检查模型名称、接口地址及模型支持的输入类型。"
    api_model = AsyncMock(side_effect=ai.ModelConnectionError(failure))
    monkeypatch.setattr(ai, "completion", api_model)
    assert (await upload(suite)).status_code == 200
    item = suite.store.read()["items"][0]
    assert item["name"] == "IMG_001" and item["category"] == "other"
    if mode == "missing_vision":
        assert configured["capabilities"] == {"text": True, "vision": False}
        api_model.assert_not_awaited()
        response = await suite.client.post(f"/api/ai/analyze/{item['id']}")
        assert response.status_code == 400 and "模型名称" in response.json()["detail"]
    else:
        assert item["ai_status"] == "error" and item["ai_error"] == failure
        api_model.assert_awaited_once()
    suite.describe.assert_not_awaited()


@pytest.mark.parametrize("provider", API_PROVIDERS)
async def test_api_and_local_model_provider_changes_cancel_old_results(suite, monkeypatch, provider):
    await configure_api(suite, provider)
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def waiting(*args, **kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            return json.dumps(DESCRIPTION)

    monkeypatch.setattr(ai, "completion", waiting)
    uploading = asyncio.create_task(upload(suite))
    try:
        await asyncio.wait_for(started.wait(), 2)
        assert (await suite.client.put("/api/ai/settings", json={"provider": "none"})).status_code == 200
        await asyncio.wait_for(cancelled.wait(), 2)
        assert (await asyncio.wait_for(uploading, 2)).status_code == 200
        item = suite.store.read()["items"][0]
        assert item["name"] == "IMG_001" and item["ai_status"] == "idle"
        assert suite.store.read()["ai"]["jobs"] == {}
        suite.describe.assert_not_awaited()
    finally:
        if not uploading.done():
            uploading.cancel()
            await asyncio.gather(uploading, return_exceptions=True)


@pytest.mark.parametrize("action", ["disable", "disconnect", "provider"])
async def test_disabling_or_disconnecting_cancels_active_codex_and_prevents_late_write(
    suite, monkeypatch, action
):
    await configure_host(suite)
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def waiting(*args, **kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(host_vision, "describe", waiting)
    uploading = asyncio.create_task(upload(suite))
    try:
        await asyncio.wait_for(started.wait(), 2)
        if action == "disable":
            response = await suite.client.put("/api/ai/automatic-vision", json={"enabled": False})
        elif action == "disconnect":
            response = await suite.client.post("/api/ai/disconnect")
        else:
            response = await suite.client.put("/api/ai/settings", json={"provider": "none"})
        assert response.status_code == 200
        await asyncio.wait_for(cancelled.wait(), 2)
        assert (await asyncio.wait_for(uploading, 2)).status_code == 200
        saved = suite.store.read()["items"][0]
        assert saved["name"] == "IMG_001" and saved["ai_status"] == "idle"
        assert suite.store.read()["ai"]["jobs"] == {}
        assert not ai._tasks
    finally:
        if not uploading.done():
            uploading.cancel()
            await asyncio.gather(uploading, return_exceptions=True)


@pytest.mark.parametrize("change", ["expired", "revoked", "edited", "image", "deleted"])
async def test_host_results_cannot_overwrite_changed_authority_or_items(suite, monkeypatch, change):
    token = await configure_host(suite)
    started, finish = asyncio.Event(), asyncio.Event()

    async def waiting(*args, **kwargs):
        started.set()
        await finish.wait()
        return DESCRIPTION.copy()

    monkeypatch.setattr(host_vision, "describe", waiting)
    uploading = asyncio.create_task(upload(suite))
    try:
        await asyncio.wait_for(started.wait(), 2)
        saved = suite.store.read()["items"][0]
        if change == "expired":
            suite.store.update(
                lambda state: state["assistant_sessions"][0].update(expires_at=time.time() - 1)
            )
        elif change == "revoked":
            assert (await suite.client.delete("/api/ai/connection", headers=token)).status_code == 200
        elif change == "edited":
            assert (
                await suite.client.patch(
                    f"/api/items/{saved['id']}", json={"name": "手动填写的衣物", "confirmed": True}
                )
            ).status_code == 200
        elif change == "image":
            suite.store.update(lambda state: state["items"][0].update(image_url="/api/images/changed.jpg"))
        else:
            assert (await suite.client.delete(f"/api/items/{saved['id']}")).status_code == 200
        finish.set()
        assert (await asyncio.wait_for(uploading, 2)).status_code == 200
        current = suite.store.read()
        assert current["ai"]["jobs"] == {}
        if change == "deleted":
            assert current["items"] == []
        else:
            item = current["items"][0]
            assert item["name"] != DESCRIPTION["name"]
            if change in {"expired", "revoked"}:
                assert item["ai_status"] == "error" and "连接已失效" in item["ai_error"]
                assert not ai.capabilities(suite.store)["vision"]
            if change == "edited":
                assert item["name"] == "手动填写的衣物" and item["confirmed"]
    finally:
        finish.set()
        if not uploading.done():
            uploading.cancel()
            await asyncio.gather(uploading, return_exceptions=True)


@pytest.mark.parametrize(
    "result",
    [
        {**DESCRIPTION, "name": ""},
        {**DESCRIPTION, "seasons": ["unknown"]},
        {**DESCRIPTION, "tags": ["x" * 81]},
        {**DESCRIPTION, "colors": None},
    ],
)
async def test_invalid_host_labels_fail_without_overwriting_original_metadata(suite, result):
    await configure_host(suite)
    suite.describe.return_value = result
    assert (await upload(suite)).status_code == 200
    item = suite.store.read()["items"][0]
    assert item["name"] == "IMG_001" and item["category"] == "other"
    assert item["ai_status"] == "error" and item["ai_error"]


async def test_failed_host_execution_keeps_the_photo_and_readable_error(suite):
    await configure_host(suite)
    suite.describe.side_effect = ai.ModelConnectionError("Codex 当前额度不足，请稍后重试。")
    assert (await upload(suite)).status_code == 200
    item = suite.store.read()["items"][0]
    assert item["image_url"] and item["original_url"]
    assert item["ai_status"] == "error" and "额度不足" in item["ai_error"]


async def test_automatic_vision_endpoint_keeps_origin_and_input_boundaries(suite):
    await configure_host(suite, enabled=False)
    client = suite.client
    assert (
        await client.put(
            "/api/ai/automatic-vision", json={"enabled": True}, headers={"Origin": "https://other.example"}
        )
    ).status_code == 403
    for body in ({"enabled": "true"}, {"enabled": True, "provider": "codex"}):
        assert (await client.put("/api/ai/automatic-vision", json=body)).status_code == 422
    client.cookies.clear()
    assert (await client.put("/api/ai/automatic-vision", json={"enabled": True})).status_code == 401


async def change_queued_item(suite, item_id, change):
    if change == "edited":
        response = await suite.client.patch(
            f"/api/items/{item_id}", json={"name": "手动填写的衣物", "confirmed": True}
        )
        assert response.status_code == 200
    elif change == "archived":
        assert (
            await suite.client.patch(f"/api/items/{item_id}", json={"status": "archived"})
        ).status_code == 200
    elif change == "deleted":
        assert (await suite.client.delete(f"/api/items/{item_id}")).status_code == 200
    elif change == "image":
        suite.store.update(lambda state: state["items"][0].update(image_url="/api/images/replaced.jpg"))
    else:
        suite.store.update(lambda state: state["items"][0].update(ai_status="idle"))
        ai.claim_analysis(suite.store, item_id)


@pytest.mark.parametrize("provider", ["codex", "compatible"])
@pytest.mark.parametrize("change", ["edited", "archived", "deleted", "image", "replacement"])
async def test_stale_queued_jobs_never_read_or_send_photos(suite, monkeypatch, provider, change):
    if provider == "codex":
        await configure_host(suite)
    else:
        await configure_api(suite, provider)
    assert (await upload(suite, data={"auto_analyze": "false"})).status_code == 200
    item_id = suite.store.read()["items"][0]["id"]
    claimed = ai.claim_analysis(suite.store, item_id)
    await change_queued_item(suite, item_id, change)
    expected_items = suite.store.read()["items"]
    image_data, model = Mock(), AsyncMock()
    monkeypatch.setattr(ai, "_image_data", image_data)
    monkeypatch.setattr(ai, "completion", model)
    await ai.analyze_item(suite.store, suite.app.state.images, item_id, claimed)
    image_data.assert_not_called()
    model.assert_not_awaited()
    suite.describe.assert_not_awaited()
    current = suite.store.read()
    if change == "replacement":
        assert current["ai"]["jobs"][item_id]["token"] != claimed[1]["token"]
        assert current["items"] == expected_items
    else:
        assert current["ai"]["jobs"] == {}
        if change != "image":
            assert current["items"] == expected_items
    assert not ai._tasks


@pytest.mark.parametrize("provider", API_PROVIDERS)
@pytest.mark.parametrize("change", ["edited", "configuration"])
async def test_api_rechecks_job_after_image_conversion_before_sending(suite, monkeypatch, provider, change):
    await configure_api(suite, provider)
    assert (await upload(suite, data={"auto_analyze": "false"})).status_code == 200
    item_id = suite.store.read()["items"][0]["id"]
    claimed = ai.claim_analysis(suite.store, item_id)

    def convert(path):
        assert path.is_file()
        if change == "edited":
            suite.store.update(
                lambda state: state["items"][0].update(
                    name="手动填写的衣物", confirmed=True, ai_status="idle", updated_at="edited"
                )
            )
        else:
            suite.store.update(lambda state: state["ai"]["configuration"].update(vision_model="new-model"))
        return "data:image/jpeg;base64,c3ludGhldGlj"

    model = AsyncMock()
    monkeypatch.setattr(ai, "_image_data", convert)
    monkeypatch.setattr(ai, "completion", model)
    await ai.analyze_item(suite.store, suite.app.state.images, item_id, claimed)
    model.assert_not_awaited()
    current = suite.store.read()
    assert current["ai"]["jobs"] == {}
    assert current["items"][0]["ai_status"] == "idle"
    if change == "edited":
        assert current["items"][0]["name"] == "手动填写的衣物"
        assert current["items"][0]["confirmed"] is True


@pytest.mark.parametrize("change", ["expired", "revoked", "edited", "archived", "deleted", "replacement"])
async def test_codex_rechecks_waiting_job_before_copying_photo_or_starting_cli(suite, monkeypatch, change):
    token = await configure_host(suite)
    assert (await upload(suite, data={"auto_analyze": "false"})).status_code == 200
    item_id = suite.store.read()["items"][0]["id"]
    claimed = ai.claim_analysis(suite.store, item_id)
    lock = asyncio.Lock()
    await lock.acquire()
    monkeypatch.setitem(host_vision._locks, asyncio.get_running_loop(), lock)
    monkeypatch.setattr(host_vision, "executable", lambda: ["synthetic-codex"])
    copy, spawn = Mock(), AsyncMock()
    monkeypatch.setattr(host_vision.shutil, "copyfile", copy)
    monkeypatch.setattr(host_vision.asyncio, "create_subprocess_exec", spawn)
    waiting = asyncio.Event()

    async def describe(*args, **kwargs):
        waiting.set()
        return await suite.real_describe(*args, **kwargs)

    monkeypatch.setattr(host_vision, "describe", describe)
    task = asyncio.create_task(ai.analyze_item(suite.store, suite.app.state.images, item_id, claimed))
    try:
        await asyncio.wait_for(waiting.wait(), 2)
        if change == "expired":
            suite.store.update(
                lambda state: state["assistant_sessions"][0].update(expires_at=time.time() - 1)
            )
        elif change == "revoked":
            assert (await suite.client.delete("/api/ai/connection", headers=token)).status_code == 200
        else:
            await change_queued_item(suite, item_id, change)
        expected_items = suite.store.read()["items"]
        lock.release()
        await asyncio.wait_for(task, 2)
        copy.assert_not_called()
        spawn.assert_not_awaited()
        current = suite.store.read()
        if change == "replacement":
            assert current["ai"]["jobs"][item_id]["token"] != claimed[1]["token"]
            assert current["items"] == expected_items
        else:
            assert current["ai"]["jobs"] == {}
            if change in {"expired", "revoked"}:
                assert "连接已失效" in current["items"][0]["ai_error"]
            else:
                assert current["items"] == expected_items
        assert not ai._tasks
    finally:
        if lock.locked():
            lock.release()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
