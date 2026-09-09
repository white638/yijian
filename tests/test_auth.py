import json
import os
import stat
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from server.auth import COOKIE, bootstrap_key
from server.main import create_app
from server.store import Store


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("YIJIAN_MODEL_CACHE", str(tmp_path / "models"))
    return create_app(tmp_path / "wardrobe")


@pytest.fixture
def client(app):
    with TestClient(app) as value:
        yield value


def login(client, app):
    response = client.post("/api/session", json={"code": app.state.bootstrap_code})
    assert response.status_code == 200, response.text
    return response


def test_bootstrap_key_is_private_persistent_and_atomic(tmp_path):
    store = Store(tmp_path / "first")
    with ThreadPoolExecutor(max_workers=8) as executor:
        keys = list(executor.map(lambda _: bootstrap_key(store), range(24)))
    assert len(set(keys)) == 1 and len(keys[0]) == 43
    assert bootstrap_key(Store(store.root)) == keys[0]
    assert bootstrap_key(Store(tmp_path / "second")) != keys[0]
    assert list(store.root.glob(".browser-key-*.tmp")) == []
    assert keys[0] not in json.dumps(store.read())
    if os.name != "nt":
        assert stat.S_IMODE((store.root / ".browser-key").stat().st_mode) == 0o600


def test_corrupt_bootstrap_file_fails_closed_without_overwriting_it(tmp_path):
    store = Store(tmp_path)
    secret_file = store.root / ".browser-key"
    secret_file.write_text("damaged-private-value", encoding="ascii")
    with pytest.raises(RuntimeError) as raised:
        bootstrap_key(store)
    assert "damaged-private-value" not in str(raised.value)
    assert secret_file.read_text(encoding="ascii") == "damaged-private-value"


def test_anonymous_session_needs_the_bootstrap_code(client, app):
    assert client.get("/api/state").status_code == 401
    assert client.post("/api/session").status_code == 401
    assert client.post("/api/session", json={}).status_code == 401
    assert client.post("/api/session", json={"code": "incorrect"}).status_code == 401
    assert client.post("/api/session", json={"code": "错误的启动码"}).status_code == 401
    assert (
        client.post(
            "/api/session", content='{"code":"\\ud800"}', headers={"Content-Type": "application/json"}
        ).status_code
        == 422
    )
    assert client.post("/api/session", params={"code": app.state.bootstrap_code}).status_code == 401
    assert app.state.store.read()["browser_sessions"] == []


def test_bootstrap_logs_in_without_exposing_the_secret(client, app):
    response = login(client, app)
    assert response.json() == {"ok": True}
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie
    assert app.state.bootstrap_code not in response.text
    assert app.state.bootstrap_code not in json.dumps(app.state.store.read())
    state = client.get("/api/state")
    assert state.status_code == 200
    assert app.state.bootstrap_code not in state.text
    assert not {"bootstrap_code", "browser_sessions", "assistant_sessions", "pairings"} & state.json().keys()


def test_authenticated_browser_can_renew_without_the_launch_code(client, app):
    login(client, app)
    original = client.cookies.get(COOKIE)
    assert client.post("/api/session").status_code == 200
    assert client.cookies.get(COOKIE) != original
    assert client.patch("/api/settings", json={"name": "我的衣柜"}).status_code == 200


@pytest.mark.parametrize("expired", [False, True])
def test_revoked_or_expired_browser_cannot_renew(client, app, expired):
    login(client, app)

    def invalidate(state):
        if expired:
            state["browser_sessions"][0]["expires_at"] = time.time() - 1
        else:
            state["browser_sessions"] = []

    app.state.store.update(invalidate)
    assert client.post("/api/session").status_code == 401
    assert client.get("/api/state").status_code == 401
    assert login(client, app).status_code == 200


def test_assistant_cannot_exchange_its_token_for_browser_privileges(client, app):
    login(client, app)
    assert client.put("/api/ai/settings", json={"provider": "codex"}).status_code == 200
    code = client.post("/api/ai/connection-code").json()["code"]
    token = client.post("/api/ai/connect", json={"code": code}).json()["access_token"]
    client.cookies.clear()
    headers = {"Authorization": "Bearer " + token}
    assert client.get("/api/state", headers=headers).status_code == 200
    assert client.post("/api/session", headers=headers).status_code == 401
    assert client.post("/api/session", headers=headers, json={"code": code}).status_code == 401
    assert client.post("/api/session", headers=headers, json={"code": token}).status_code == 401
    client.cookies.set(COOKIE, token)
    assert client.post("/api/session", headers=headers).status_code == 401
    assert client.put("/api/ai/settings", headers=headers, json={"provider": "none"}).status_code == 403
    assert client.post("/api/ai/connection-code", headers=headers).status_code == 403
    assert client.get("/api/state").status_code == 401


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "https://attacker.example"},
        {"Origin": "http://["},
        {"Sec-Fetch-Site": "same-site"},
        {"Sec-Fetch-Site": "cross-site"},
    ],
)
def test_bootstrap_preserves_origin_protection(client, app, headers):
    response = client.post("/api/session", json={"code": app.state.bootstrap_code}, headers=headers)
    assert response.status_code == 403
    assert "set-cookie" not in response.headers
    assert app.state.store.read()["browser_sessions"] == []


def test_validation_does_not_echo_bootstrap_secrets(client, app):
    secret = app.state.bootstrap_code * 100
    response = client.post("/api/session", json={"code": secret})
    assert response.status_code == 422
    assert app.state.bootstrap_code not in response.text
