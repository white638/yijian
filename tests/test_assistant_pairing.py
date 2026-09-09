import json
import re
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from server.main import create_app


@pytest.fixture
def clients(tmp_path, monkeypatch):
    monkeypatch.setenv("YIJIAN_MODEL_CACHE", str(tmp_path / "models"))
    app = create_app(tmp_path / "workspace")
    with TestClient(app) as browser, TestClient(app) as assistant:
        assert browser.post("/api/session", json={"code": app.state.bootstrap_code}).status_code == 200
        assert browser.put("/api/ai/settings", json={"provider": "codex"}).status_code == 200
        yield app, browser, assistant


def settings(browser):
    response = browser.get("/api/ai/settings")
    assert response.status_code == 200
    return response.json()


def legacy_token(browser, assistant):
    issued = browser.post("/api/ai/connection-code")
    assert issued.status_code == 200
    redeemed = assistant.post("/api/ai/connect", json={"code": issued.json()["code"]})
    assert redeemed.status_code == 200
    return {"Authorization": "Bearer " + redeemed.json()["access_token"]}


def start(browser, assistant, client="codex"):
    response = assistant.post("/api/ai/device/start", json={"client": client})
    assert response.status_code == 200
    data = response.json()
    requests = browser.get("/api/ai/device/requests").json()["requests"]
    request = next(entry for entry in requests if entry["user_code"] == data["user_code"])
    return data, request


def permit_poll(app):
    app.state.store.update(lambda state: [entry.update(last_poll_at=0) for entry in state["device_pairings"]])


def test_token_is_unverified_until_its_own_client_confirms_access(clients):
    app, browser, assistant = clients
    first = legacy_token(browser, assistant)
    second = legacy_token(browser, assistant)
    assert settings(browser)["assistant_connected"] is False
    assert settings(browser)["assistant_connection"]["status"] == "pending"
    assert assistant.get("/api/state", headers=first).status_code == 200
    assert browser.post("/api/ai/connection/verify").status_code == 403
    assert browser.delete("/api/ai/connection").status_code == 403
    verified = assistant.post("/api/ai/connection/verify", headers=first).json()
    assert verified["connected"] and verified["client_name"] == "Codex"
    assert verified["verified_at"] < verified["expires_at"]
    assert settings(browser)["assistant_connection"] == {
        "status": "connected",
        **{key: verified[key] for key in ("client_name", "verified_at", "expires_at")},
    }
    sessions = app.state.store.read()["assistant_sessions"]
    assert sessions[0]["verified_at"] == verified["verified_at"]
    assert sessions[1]["verified_at"] is None
    assert assistant.post("/api/ai/connection/verify", headers=first).json() == verified
    assert assistant.post("/api/ai/disconnect", headers=first).status_code == 403
    assert assistant.delete("/api/ai/connection", headers=first).json() == {"ok": True}
    assert assistant.get("/api/state", headers=first).status_code == 401
    assert assistant.get("/api/state", headers=second).status_code == 200
    assert not settings(browser)["assistant_connected"]


@pytest.mark.parametrize("client,client_name", [("codex", "Codex"), ("claude-code", "Claude Code")])
def test_device_approval_redeems_once_and_waits_for_client_verification(clients, client, client_name):
    app, browser, assistant = clients
    assert browser.put("/api/ai/settings", json={"provider": client}).status_code == 200
    data, request = start(browser, assistant, client)
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", data["device_code"])
    assert re.fullmatch(r"[A-Z2-9]{4}-[A-Z2-9]{4}", data["user_code"])
    assert data["expires_in"] == 300 and data["interval"] == 2
    assert data["verification_uri"] == "http://testserver/#settings"
    assert request["client_name"] == client_name and request["status"] == "pending"
    assert data["device_code"] not in json.dumps(app.state.store.read())
    assert data["device_code"] not in browser.get("/api/ai/device/requests").text
    payload = {"device_code": data["device_code"]}
    assert assistant.post("/api/ai/device/poll", json=payload).json() == {"status": "pending"}
    assert app.state.store.read()["assistant_sessions"] == []
    approved = browser.post(f"/api/ai/device/{request['id']}/approve")
    assert approved.json() == {"approved": True}
    assert app.state.store.read()["assistant_sessions"] == []
    assert browser.get("/api/ai/device/requests").json()["requests"][0]["status"] == "approved"
    permit_poll(app)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: assistant.post("/api/ai/device/poll", json=payload), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 401]
    credentials = next(response.json() for response in responses if response.status_code == 200)
    assert credentials["status"] == "approved" and credentials["expires_in"] == 3600
    assert credentials["access_token"] not in json.dumps(app.state.store.read())
    assert browser.get("/api/ai/device/requests").json() == {"requests": []}
    assert not settings(browser)["assistant_connected"]
    token = {"Authorization": "Bearer " + credentials["access_token"]}
    assert assistant.get("/api/state", headers=token).status_code == 200
    assert assistant.post("/api/ai/connection/verify", headers=token).json()["client_name"] == client_name
    assert settings(browser)["assistant_connected"]
    assert settings(browser)["assistant_connection"]["request_id"] == request["id"]
    public = browser.get("/api/state")
    assert "device_pairings" not in public.json()
    assert credentials["access_token"] not in public.text and data["device_code"] not in public.text


def test_a_new_pairing_is_not_reported_as_the_existing_verified_connection(clients):
    _, browser, assistant = clients
    old_token = legacy_token(browser, assistant)
    old_connection = assistant.post("/api/ai/connection/verify", headers=old_token).json()
    data, request = start(browser, assistant)
    assert browser.post(f"/api/ai/device/{request['id']}/approve").status_code == 200
    credentials = assistant.post("/api/ai/device/poll", json={"device_code": data["device_code"]}).json()
    waiting = settings(browser)["assistant_connection"]
    assert waiting["status"] == "connected"
    assert waiting["verified_at"] == old_connection["verified_at"]
    assert waiting.get("request_id") != request["id"]
    new_token = {"Authorization": "Bearer " + credentials["access_token"]}
    verified = assistant.post("/api/ai/connection/verify", headers=new_token).json()
    assert verified["request_id"] == request["id"]
    assert settings(browser)["assistant_connection"]["request_id"] == request["id"]
    assert assistant.delete("/api/ai/connection", headers=new_token).status_code == 200
    remaining = settings(browser)["assistant_connection"]
    assert remaining["status"] == "connected" and remaining.get("request_id") != request["id"]
    assert remaining["verified_at"] == old_connection["verified_at"]


@pytest.mark.parametrize("terminal", ["expired", "denied", "revoked_approval"])
def test_expired_and_refused_devices_cannot_receive_credentials(clients, terminal):
    app, browser, assistant = clients
    data, request = start(browser, assistant)
    if terminal == "expired":
        app.state.store.update(lambda state: state["device_pairings"][0].update(expires_at=time.time() - 1))
    else:
        if terminal == "revoked_approval":
            assert browser.post(f"/api/ai/device/{request['id']}/approve").status_code == 200
        assert browser.delete(f"/api/ai/device/{request['id']}").status_code == 200
    response = assistant.post("/api/ai/device/poll", json={"device_code": data["device_code"]})
    assert response.status_code == 401 and "access_token" not in response.json()
    assert browser.post(f"/api/ai/device/{request['id']}/approve").status_code == 404
    assert browser.get("/api/ai/device/requests").json() == {"requests": []}
    assert settings(browser)["assistant_connection"] == {"status": "disconnected"}
    assert app.state.store.read()["assistant_sessions"] == []


@pytest.mark.parametrize("action", ["provider", "disconnect"])
def test_provider_changes_and_disconnect_revoke_requests_and_sessions(clients, action):
    app, browser, assistant = clients
    token = legacy_token(browser, assistant)
    assert assistant.post("/api/ai/connection/verify", headers=token).status_code == 200
    data, request = start(browser, assistant)
    assert browser.post(f"/api/ai/device/{request['id']}/approve").status_code == 200
    if action == "provider":
        assert browser.put("/api/ai/settings", json={"provider": "claude-code"}).status_code == 200
    else:
        assert browser.post("/api/ai/disconnect").status_code == 200
    assert assistant.post("/api/ai/device/poll", json={"device_code": data["device_code"]}).status_code == 401
    assert assistant.post("/api/ai/connection/verify", headers=token).status_code == 401
    assert assistant.get("/api/state", headers=token).status_code == 401
    assert settings(browser)["assistant_connection"] == {"status": "disconnected"}
    assert app.state.store.read()["device_pairings"] == []


def test_expired_and_legacy_unverified_sessions_are_not_connected(clients):
    app, browser, assistant = clients
    token = legacy_token(browser, assistant)
    app.state.store.update(lambda state: state["assistant_sessions"][0].pop("verified_at"))
    assert settings(browser)["assistant_connected"] is False
    assert assistant.post("/api/ai/connection/verify", headers=token).status_code == 200
    app.state.store.update(lambda state: state["assistant_sessions"][0].update(expires_at=time.time() - 1))
    assert settings(browser)["assistant_connection"] == {"status": "disconnected"}
    assert assistant.post("/api/ai/connection/verify", headers=token).status_code == 401


def test_device_management_requires_browser_authority(clients):
    _, browser, assistant = clients
    data, request = start(browser, assistant)
    token = legacy_token(browser, assistant)
    paths = [
        ("GET", "/api/ai/device/requests"),
        ("POST", f"/api/ai/device/{request['id']}/approve"),
        ("DELETE", f"/api/ai/device/{request['id']}"),
    ]
    for method, path in paths:
        assert assistant.request(method, path).status_code == 401
        assert assistant.request(method, path, headers=token).status_code == 403
    assert assistant.post("/api/ai/device/poll", json={"device_code": data["device_code"]}).json() == {
        "status": "pending"
    }


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "https://attacker.example"},
        {"Origin": "http://["},
        {"Origin": "null"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "same-site"},
    ],
)
def test_pairing_protects_browser_and_anonymous_operations_from_cross_origin(clients, headers):
    _, browser, assistant = clients
    data, request = start(browser, assistant)
    token = legacy_token(browser, assistant)
    assert (
        assistant.post("/api/ai/device/start", json={"client": "codex"}, headers=headers).status_code == 403
    )
    assert (
        assistant.post(
            "/api/ai/device/poll", json={"device_code": data["device_code"]}, headers=headers
        ).status_code
        == 403
    )
    assert browser.get("/api/ai/device/requests", headers=headers).status_code == 403
    assert browser.post(f"/api/ai/device/{request['id']}/approve", headers=headers).status_code == 403
    assert browser.delete(f"/api/ai/device/{request['id']}", headers=headers).status_code == 403
    assert assistant.post("/api/ai/connection/verify", headers={**token, **headers}).status_code == 403
    assert assistant.delete("/api/ai/connection", headers={**token, **headers}).status_code == 403


def test_device_provider_capacity_and_polling_limits(clients):
    app, browser, assistant = clients
    assert assistant.post("/api/ai/device/start", json={"client": "claude-code"}).status_code == 409
    data, _ = start(browser, assistant)
    payload = {"device_code": data["device_code"]}
    assert assistant.post("/api/ai/device/poll", json=payload).status_code == 200
    rate_limited = assistant.post("/api/ai/device/poll", json=payload)
    assert rate_limited.status_code == 429 and rate_limited.headers["Retry-After"] == "2"
    for _ in range(4):
        start(browser, assistant)
    assert assistant.post("/api/ai/device/start", json={"client": "codex"}).status_code == 429
    assert len(app.state.store.read()["device_pairings"]) == 5
    assert browser.put("/api/ai/settings", json={"provider": "none"}).status_code == 200
    assert assistant.post("/api/ai/device/start", json={"client": "codex"}).status_code == 409


def test_invalid_pairing_input_never_echoes_secret_values(clients):
    _, browser, assistant = clients
    data, _ = start(browser, assistant)
    for payload in [
        {"device_code": data["device_code"] + "x"},
        {"device_code": data["device_code"], "extra": "private-value"},
    ]:
        response = assistant.post("/api/ai/device/poll", json=payload)
        assert response.status_code == 422
        assert data["device_code"] not in response.text and "private-value" not in response.text
