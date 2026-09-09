from __future__ import annotations

import asyncio
import base64
import io
import json
import socket
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import BackgroundTasks, FastAPI
from PIL import Image

from server import ai, ai_network
from server.auth import digest
from server.images import ImagePipeline
from server.store import Store

pytestmark = pytest.mark.anyio
SECRET = "test-private-key-should-not-appear"
MODEL = {
    "provider": "compatible",
    "base_url": "https://models.example/v1",
    "text_model": "text-one",
    "vision_model": "vision-one",
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def suite(tmp_path):
    store = Store(tmp_path)
    store.update(
        lambda state: state["browser_sessions"].append(
            {"token_hash": digest("browser"), "expires_at": time.time() + 300}
        )
    )
    app = FastAPI()
    app.state.store = store
    app.state.images = ImagePipeline(tmp_path / "images")
    app.include_router(ai.router)
    return SimpleNamespace(app=app, store=store, images=app.state.images)


@pytest.fixture
async def client(suite):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=suite.app),
        base_url="http://testserver",
        cookies={"wardrobe_session": "browser"},
    ) as value:
        yield value


async def configure(client, **changes):
    response = await client.put("/api/ai/settings", json={**MODEL, **changes})
    assert response.status_code == 200, response.text
    return response.json()


def item(item_id, category="top", **changes):
    return {
        "id": item_id,
        "name": "我的衣物",
        "category": category,
        "colors": ["白色"],
        "seasons": [],
        "occasions": [],
        "tags": [],
        "status": "available",
        "confirmed": True,
        "favorite": False,
        "brand": "",
        "closet": "日常衣橱",
        "notes": "",
        "price": "90.00",
        "created_at": "2026-01-01",
        "updated_at": "2026-01-01",
        "image_url": None,
        "ai_status": "idle",
        "ai_error": None,
        **changes,
    }


def add_items(suite, *values):
    suite.store.update(lambda state: state["items"].extend(values))


def add_photo(suite):
    buffer = io.BytesIO()
    Image.new("RGB", (120, 90), "red").save(buffer, "PNG")
    picture = suite.images.prepare(buffer.getvalue(), False)
    add_items(suite, item("photo", **picture))


def model_reply(ids=None):
    return json.dumps(
        {
            "outfits": [
                {"name": "日常穿搭", "reason": "适合通勤。", "item_ids": ids or ["top", "bottom", "shoes"]}
            ]
        }
    )


async def test_empty_and_host_settings_never_call_a_model(client, suite, monkeypatch):
    inference = AsyncMock()
    monkeypatch.setattr(ai, "completion", inference)
    empty = (await client.get("/api/ai/settings")).json()
    assert empty["provider"] == "none" and not empty["configured"]
    assert empty["capabilities"] == {"text": False, "vision": False}
    host = await configure(client, provider="codex", api_key=SECRET)
    assert host["configured"] and not host["has_key"]
    assert host["base_url"] == host["vision_model"] == host["text_model"] == ""
    assert host["capabilities"] == empty["capabilities"]
    assert (await client.post("/api/ai/test")).json()["connected"] is False
    assert (await client.post("/api/ai/chat", json={"message": "今天穿什么？"})).status_code == 400
    inference.assert_not_awaited()
    assert SECRET not in json.dumps(suite.store.read())


async def test_keys_are_encrypted_sanitized_and_bound_to_the_endpoint(client, suite):
    public = await configure(client, api_key=SECRET)
    private = suite.store.read()["ai"]["configuration"]
    assert public["has_key"] and "sealed_key" not in public
    assert SECRET not in json.dumps(private)
    assert ai._runtime(suite.store)["api_key"] == SECRET
    assert (suite.store.root / ".ai-key").stat().st_size == 32
    await configure(client, text_model="another-text")
    assert ai._runtime(suite.store)["api_key"] == SECRET
    await configure(client, base_url="https://other.example/v1")
    assert not (await client.get("/api/ai/settings")).json()["has_key"]
    assert ai._runtime(suite.store)["api_key"] == ""
    await configure(client, api_key=SECRET)
    await configure(client, clear_key=True)
    assert not ai.public_settings(suite.store)["has_key"]


async def test_openai_needs_own_key_and_missing_local_secret_fails_closed(client, suite):
    configured = await configure(client, provider="openai", base_url="")
    assert configured["base_url"] == "https://api.openai.com/v1"
    assert not configured["configured"]
    await configure(client, provider="openai", api_key=SECRET)
    assert ai.capabilities(suite.store)["text"]
    (suite.store.root / ".ai-key").unlink()
    assert not ai.capabilities(suite.store)["text"]
    assert (await client.post("/api/ai/test")).json()["connected"] is False


async def test_invalid_settings_do_not_echo_keys(client):
    for changes in (
        {"api_key": SECRET * 200},
        {"api_key": SECRET + "\nprivate"},
        {"base_url": "https://secret:password@models.example/v1", "api_key": SECRET},
    ):
        response = await client.put("/api/ai/settings", json={**MODEL, **changes})
        assert response.status_code in {400, 422}
        assert SECRET not in response.text and "password" not in response.text


async def test_test_calls_two_saved_models_with_only_a_synthetic_image(client, suite, monkeypatch):
    monkeypatch.setattr(ai.secrets, "choice", lambda values: values[0])
    await configure(client, api_key=SECRET)
    add_photo(suite)
    inference = AsyncMock(return_value="蓝色")
    monkeypatch.setattr(ai, "completion", inference)
    response = (await client.post("/api/ai/test")).json()
    assert response["connected"] and response["text"] and response["vision"]
    assert [call.kwargs["model"] for call in inference.await_args_list] == ["text-one", "vision-one"]
    encoded = inference.await_args_list[1].args[1][0]["content"][1]["image_url"]["url"]
    with Image.open(io.BytesIO(base64.b64decode(encoded.split(",", 1)[1]))) as picture:
        assert picture.size == (32, 32)
        assert picture.getpixel((0, 0))[2] > picture.getpixel((0, 0))[0]
    assert "我的衣物" not in str(inference.await_args_list)
    assert SECRET not in json.dumps(response)


async def test_test_reports_capabilities_separately_and_is_limited(client, monkeypatch):
    await configure(client)
    inference = AsyncMock(side_effect=["已连接", ai_network.ModelConnectionError("视觉模型不可用。")])
    monkeypatch.setattr(ai, "completion", inference)
    result = (await client.post("/api/ai/test")).json()
    assert result == {"connected": True, "text": True, "vision": False, "message": "视觉模型不可用。"}
    inference.side_effect = None
    inference.return_value = "已连接"
    for _ in range(4):
        assert (await client.post("/api/ai/test")).status_code == 200
    assert (await client.post("/api/ai/test")).status_code == 429


async def test_pairing_is_private_single_use_and_immediately_revocable(client, suite):
    await configure(client, provider="codex")
    issued = (await client.post("/api/ai/connection-code")).json()
    assert issued["expires_in"] == 300 and len(issued["code"]) == 32
    assert issued["code"] not in json.dumps(suite.store.read())
    await configure(client, provider="codex")
    responses = await asyncio.gather(
        *(client.post("/api/ai/connect", json={"code": issued["code"]}) for _ in range(2))
    )
    assert sorted(response.status_code for response in responses) == [200, 401]
    connected = next(response.json() for response in responses if response.status_code == 200)
    token = connected["access_token"]
    assert connected["expires_in"] == 3600
    assert token not in json.dumps(suite.store.read())
    headers = {"Authorization": "Bearer " + token}
    assert (await client.get("/api/ai/settings", headers=headers)).json()["assistant_connected"]
    for method, url, payload in (
        ("post", "connection-code", None),
        ("post", "test", None),
        ("put", "settings", MODEL),
    ):
        response = await client.request(method, "/api/ai/" + url, headers=headers, json=payload)
        assert response.status_code == 403
    assert (await client.post("/api/ai/disconnect")).status_code == 200
    assert (await client.get("/api/ai/settings", headers=headers)).status_code == 401
    assert not ai.public_settings(suite.store)["assistant_connected"]


async def test_pairing_replacement_expiry_and_failed_attempts_are_counted(client, suite):
    assert (await client.post("/api/ai/connection-code")).status_code == 409
    await configure(client, provider="claude-code")
    old = (await client.post("/api/ai/connection-code")).json()["code"]
    fresh = (await client.post("/api/ai/connection-code")).json()["code"]
    assert (await client.post("/api/ai/connect", json={"code": old})).status_code == 401
    suite.store.update(lambda state: state["pairings"][0].update(expires_at=time.time() - 1))
    assert (await client.post("/api/ai/connect", json={"code": fresh})).status_code == 401
    for _ in range(18):
        assert (await client.post("/api/ai/connect", json={"code": "0" * 32})).status_code == 401
    assert (await client.post("/api/ai/connect", json={"code": "0" * 32})).status_code == 429


async def test_settings_provider_change_revokes_assistant(client, suite):
    await configure(client, provider="codex")
    code = (await client.post("/api/ai/connection-code")).json()["code"]
    token = (await client.post("/api/ai/connect", json={"code": code})).json()["access_token"]
    await configure(client, provider="claude-code")
    assert (
        await client.get("/api/ai/settings", headers={"Authorization": "Bearer " + token})
    ).status_code == 401
    assert suite.store.read()["pairings"] == []


async def test_analysis_creates_reviewable_suggestions_without_replacing_photo(client, suite, monkeypatch):
    await configure(client)
    add_photo(suite)
    original = suite.store.read()["items"][0]["image_url"]
    inference = AsyncMock(
        return_value=json.dumps(
            {
                "name": "红色短袖",
                "category": "top",
                "colors": ["红色"],
                "tags": ["轻便", "轻便"],
                "price": "999",
            }
        )
    )
    monkeypatch.setattr(ai, "completion", inference)
    result = await client.post("/api/ai/analyze/photo")
    assert result.status_code == 200
    value = suite.store.read()["items"][0]
    assert value["name"] == "红色短袖" and not value["confirmed"]
    assert value["ai_status"] == "review" and value["tags"] == ["轻便"]
    assert value["image_url"] == original and value["price"] == "90.00"
    assert suite.store.read()["ai"]["jobs"] == {}


@pytest.mark.parametrize("change", ["edit", "image", "delete", "settings"])
async def test_analysis_does_not_overwrite_changed_state(client, suite, monkeypatch, change):
    await configure(client)
    add_photo(suite)
    started, finish = asyncio.Event(), asyncio.Event()

    async def infer(*args, **kwargs):
        started.set()
        await finish.wait()
        return '{"name":"模型结果","category":"top"}'

    monkeypatch.setattr(ai, "completion", infer)
    task = asyncio.create_task(ai.analyze_item(suite.store, suite.images, "photo"))
    await started.wait()
    if change == "delete":
        suite.store.update(lambda state: state.update(items=[]))
    elif change == "settings":
        await configure(client, provider="none")
    else:
        suite.store.update(
            lambda state: state["items"][0].update(
                name="用户填写",
                updated_at="later",
                **({"image_url": "/api/images/changed.jpg"} if change == "image" else {}),
            )
        )
    finish.set()
    await task
    values = suite.store.read()["items"]
    assert not values or values[0]["name"] != "模型结果"
    assert not values or values[0]["ai_status"] == "idle"
    assert not ai._tasks


async def test_cancel_before_queued_work_starts_sends_no_photo(client, suite, monkeypatch):
    await configure(client)
    add_photo(suite)
    background = BackgroundTasks()
    ai.queue_analysis(suite.store, suite.images, "photo", background)
    assert suite.store.read()["items"][0]["ai_status"] == "processing"
    inference = AsyncMock()
    monkeypatch.setattr(ai, "completion", inference)
    assert (await client.post("/api/ai/analyze/photo/cancel")).status_code == 200
    await background()
    inference.assert_not_awaited()
    assert suite.store.read()["items"][0]["ai_status"] == "idle"


async def test_cancel_active_analysis_stops_request_and_second_start_is_rejected(client, suite, monkeypatch):
    await configure(client)
    add_photo(suite)
    started = asyncio.Event()

    async def infer(*args, **kwargs):
        started.set()
        await asyncio.Future()

    monkeypatch.setattr(ai, "completion", infer)
    task = asyncio.create_task(ai.analyze_item(suite.store, suite.images, "photo"))
    await started.wait()
    assert (await client.post("/api/ai/analyze/photo")).status_code == 409
    assert (await client.post("/api/ai/analyze/photo/cancel")).status_code == 200
    await asyncio.wait_for(task, 2)
    assert suite.store.read()["items"][0]["ai_status"] == "idle"
    assert not ai._tasks


async def test_analysis_error_and_startup_recovery_keep_user_data(client, suite, monkeypatch):
    await configure(client)
    add_photo(suite)
    monkeypatch.setattr(ai, "completion", AsyncMock(return_value="not json"))
    await ai.analyze_item(suite.store, suite.images, "photo")
    saved = suite.store.read()["items"][0]
    assert saved["ai_status"] == "error" and saved["name"] == "我的衣物"
    ai.claim_analysis(suite.store, "photo")
    ai.recover_interrupted_jobs(suite.store)
    assert suite.store.read()["items"][0]["ai_status"] == "error"
    assert suite.store.read()["ai"]["jobs"] == {}


@pytest.mark.parametrize(
    "description",
    [
        {"name": "衣物", "category": "top", "colors": ["x" * 81]},
        {"name": "衣物", "category": "top", "seasons": ["unknown"]},
        {"name": "衣物", "category": None},
        {"name": "x" * 121, "category": "top"},
    ],
    ids=["oversized-tag", "invalid-season", "null-category", "oversized-name"],
)
async def test_invalid_vision_fields_do_not_overwrite_the_item(client, suite, monkeypatch, description):
    await configure(client)
    add_photo(suite)
    monkeypatch.setattr(ai, "completion", AsyncMock(return_value=json.dumps(description)))
    await ai.analyze_item(suite.store, suite.images, "photo")
    saved = suite.store.read()["items"][0]
    assert saved["ai_status"] == "error"
    assert saved["name"] == "我的衣物" and saved["colors"] == ["白色"]


async def test_recommendation_returns_real_complete_drafts_only(client, suite, monkeypatch):
    await configure(client)
    add_items(suite, item("top"), item("bottom", "bottom"), item("shoes", "shoes"))
    monkeypatch.setattr(ai, "completion", AsyncMock(return_value=model_reply()))
    response = await client.post("/api/ai/recommend", json={"locked_ids": ["top"]})
    assert response.status_code == 200, response.text
    assert response.json()["outfits"][0]["source"] == "ai"
    assert suite.store.read()["outfits"] == suite.store.read()["wear_events"] == []


@pytest.mark.parametrize(
    "ids,options,mutation",
    [
        (["top", "bottom", "foreign"], {}, None),
        (["top", "bottom"], {}, None),
        (["top", "bottom", "shoes", "shoes"], {}, None),
        (["top", "bottom", "shoes"], {"excluded_ids": ["top"]}, None),
        (["top", "bottom", "shoes"], {"locked_ids": ["second"]}, None),
        (["top", "bottom", "shoes"], {}, "laundry"),
        (["top", "bottom", "shoes"], {}, "blocked"),
        (["top", "bottom", "shoes"], {}, "unconfirmed"),
    ],
)
async def test_recommendations_validate_inventory_coverage_and_constraints(
    client, suite, monkeypatch, ids, options, mutation
):
    await configure(client)
    add_items(suite, item("top"), item("second"), item("bottom", "bottom"), item("shoes", "shoes"))
    if mutation == "laundry":
        suite.store.update(lambda state: state["items"][0].update(status="laundry"))
    elif mutation == "unconfirmed":
        suite.store.update(lambda state: state["items"][0].update(confirmed=False))
    elif mutation == "blocked":
        suite.store.update(
            lambda state: state["settings"]["preferences"].update(blocked_pairs=[["top", "bottom"]])
        )
    monkeypatch.setattr(ai, "completion", AsyncMock(return_value=model_reply(ids)))
    response = await client.post("/api/ai/recommend", json=options)
    assert response.status_code in {409, 422}, response.text
    assert not suite.store.read()["outfits"]


async def test_recommendation_rechecks_inventory_after_model_response(client, suite, monkeypatch):
    await configure(client)
    add_items(suite, item("top"), item("bottom", "bottom"), item("shoes", "shoes"))

    async def infer(*args, **kwargs):
        suite.store.update(lambda state: state["items"][0].update(status="laundry"))
        return model_reply()

    monkeypatch.setattr(ai, "completion", infer)
    assert (await client.post("/api/ai/recommend", json={})).status_code == 409


async def test_chat_validates_references_and_cannot_mutate_wardrobe(client, suite, monkeypatch):
    await configure(client)
    add_items(suite, item("top", status="laundry"))
    inference = AsyncMock(return_value='{"message":"这件衣物在待洗中。","item_ids":["top"]}')
    monkeypatch.setattr(ai, "completion", inference)
    response = await client.post("/api/ai/chat", json={"message": "这件能穿吗？"})
    assert response.status_code == 200
    assert suite.store.read()["items"][0]["status"] == "laundry"
    inference.return_value = '{"message":"看这件。","item_ids":["invented"]}'
    assert (await client.post("/api/ai/chat", json={"message": "推荐"})).status_code == 422
    assert not suite.store.read()["wear_events"]


@pytest.mark.parametrize(
    "url",
    [
        "http://models.example/v1",
        "https://169.254.169.254/v1",
        "https://100.100.100.200/v1",
        "https://168.63.129.16/v1",
        "https://192.168.1.1/v1",
        "https://[fd00:ec2::254]/v1",
        "https://[::ffff:169.254.169.254]/v1",
        "https://metadata.google.internal/v1",
        "https://models.example/v1?key=secret",
        "https://models.example/v1#secret",
        "https://user:secret@models.example/v1",
        "https://models.example\\@127.0.0.1/v1",
        "https://224.0.0.1/v1",
    ],
)
async def test_network_rejects_unsafe_endpoints(url):
    with pytest.raises(ai_network.ModelConnectionError):
        ai_network.endpoint_url(url)


async def test_network_normalizes_idna_and_allows_only_explicit_http_loopback():
    assert ai_network.endpoint_url("https://BÜCHER.example.:443/v1/") == "https://xn--bcher-kva.example/v1"
    assert ai_network.endpoint_url("http://127.0.0.1:11434/v1") == "http://127.0.0.1:11434/v1"
    assert ai_network.endpoint_url("http://[::1]:11434/v1") == "http://[::1]:11434/v1"


def dns_result(address):
    return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, 443))]


async def test_network_checks_every_resolved_address(monkeypatch):
    monkeypatch.setattr(
        asyncio.get_running_loop(),
        "getaddrinfo",
        AsyncMock(return_value=dns_result("8.8.8.8") + dns_result("169.254.169.254")),
    )
    with pytest.raises(ai_network.ModelConnectionError):
        await ai_network._destination("https://models.example/v1")


@pytest.mark.parametrize("resolved", ["127.0.0.1", "::ffff:127.0.0.1"])
async def test_public_hostname_cannot_redirect_dns_to_loopback(monkeypatch, resolved):
    monkeypatch.setattr(
        asyncio.get_running_loop(), "getaddrinfo", AsyncMock(return_value=dns_result(resolved))
    )
    with pytest.raises(ai_network.ModelConnectionError):
        await ai_network._destination("https://models.example/v1")
    destination, _, _ = await ai_network._destination("http://localhost:11434/v1")
    assert destination.host == resolved


async def test_vision_probe_requires_correct_image_content(client, monkeypatch):
    await configure(client, text_model="")
    monkeypatch.setattr(ai.secrets, "choice", lambda values: values[0])
    monkeypatch.setattr(ai, "completion", AsyncMock(return_value="已连接"))
    response = (await client.post("/api/ai/test")).json()
    assert not response["connected"] and not response["vision"]
    assert "测试图片" in response["message"]


async def test_anonymous_cannot_read_or_change_settings(suite):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=suite.app), base_url="http://testserver"
    ) as client:
        assert (await client.get("/api/ai/settings")).status_code == 401
        assert (await client.put("/api/ai/settings", json=MODEL)).status_code == 401
        assert (await client.post("/api/ai/connection-code")).status_code == 401


async def test_network_uses_real_loopback_http_transport():
    received = []

    async def serve(reader, writer):
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            length = int(
                next(
                    line.split(b":", 1)[1]
                    for line in headers.split(b"\r\n")
                    if line.lower().startswith(b"content-length:")
                )
            )
            received.append((headers, await reader.readexactly(length)))
            payload = json.dumps({"choices": [{"message": {"content": "已连接"}}]}).encode()
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                + str(len(payload)).encode()
                + b"\r\n\r\n"
                + payload
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    async with server:
        port = server.sockets[0].getsockname()[1]
        response = await ai_network.completion(
            {**MODEL, "provider": "ollama", "base_url": f"http://127.0.0.1:{port}/v1", "api_key": ""},
            [],
            model="local",
        )
    assert response == "已连接"
    assert b"POST /v1/chat/completions HTTP/1.1" in received[0][0]
    assert b"authorization:" not in received[0][0].lower()
    assert json.loads(received[0][1])["model"] == "local"


async def test_network_pins_dns_and_scopes_auth_tls_and_limits(monkeypatch):
    monkeypatch.setattr(
        asyncio.get_running_loop(), "getaddrinfo", AsyncMock(return_value=dns_result("8.8.8.8"))
    )
    captured = []

    def respond(request):
        captured.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "已连接"}}]})

    original_client = httpx.AsyncClient
    options = []

    def create(**kwargs):
        options.append(kwargs)
        return original_client(**kwargs, transport=httpx.MockTransport(respond))

    monkeypatch.setattr(ai_network.httpx, "AsyncClient", create)
    configuration = {**MODEL, "api_key": SECRET}
    assert (
        await ai_network.completion(configuration, [{"role": "user", "content": "你好"}], model="text-one")
        == "已连接"
    )
    await ai_network.completion(
        {**configuration, "api_key": "", "base_url": "https://second.example/v1"}, [], model="text-one"
    )
    assert captured[0].url.host == "8.8.8.8" and captured[0].url.path == "/v1/chat/completions"
    assert captured[0].headers["Host"] == "models.example"
    assert captured[0].headers["Authorization"] == "Bearer " + SECRET
    assert captured[0].extensions["sni_hostname"] == "models.example"
    assert "Authorization" not in captured[1].headers
    assert all(not value["follow_redirects"] and not value["trust_env"] for value in options)
    assert json.loads(captured[0].content)["max_tokens"] == 1800


@pytest.mark.parametrize(
    "status,payload",
    [(302, SECRET), (401, SECRET), (429, SECRET), (500, SECRET), (200, SECRET), (200, "x" * 1_000_001)],
    ids=["redirect", "bad-key", "limit", "unavailable", "malformed", "oversized"],
)
async def test_network_provider_errors_never_echo_response_or_follow_redirect(monkeypatch, status, payload):
    monkeypatch.setattr(
        ai_network,
        "_destination",
        AsyncMock(
            return_value=(
                httpx.URL("https://8.8.8.8/v1/chat/completions"),
                "models.example",
                "models.example",
            )
        ),
    )
    original_client = httpx.AsyncClient
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(status, text=payload, headers={"Location": "http://169.254.169.254/latest"})

    monkeypatch.setattr(
        ai_network.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(**kwargs, transport=httpx.MockTransport(respond)),
    )
    with pytest.raises(ai_network.ModelConnectionError) as raised:
        await ai_network.completion({**MODEL, "api_key": SECRET}, [], model="text-one")
    assert SECRET not in str(raised.value)
    assert len(requests) == 1
