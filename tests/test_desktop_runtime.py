import hashlib
import json
import secrets
import socket

from fastapi.testclient import TestClient
import pytest

from desktop.launcher import smoke_http
from desktop.runtime import (
    DesktopASGI,
    DesktopError,
    InstanceLock,
    LocalService,
    activate_existing,
    control_request,
    default_data_dir,
    prepare_bundled_model,
    private_json,
    reserve_socket,
    signature,
)
from server.auth import COOKIE
from server.main import create_app
from server.store import Store


def test_desktop_data_is_independent_of_source_workspace(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "windows-user"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "linux-user"))
    assert default_data_dir().name == "data"
    assert default_data_dir().parent.name == "Yijian"
    assert str(default_data_dir()).startswith(str(tmp_path))


def test_instance_lock_serializes_same_data_and_recovers_on_close(tmp_path):
    first, second = InstanceLock(tmp_path), InstanceLock(tmp_path)
    other = InstanceLock(tmp_path / "another-wardrobe")
    try:
        assert first.acquire()
        assert not second.acquire()
        assert other.acquire()
        first.close()
        assert second.acquire()
    finally:
        first.close()
        second.close()
        other.close()


def test_port_conflict_reserves_different_loopback_port_without_connecting():
    first = reserve_socket()
    second = reserve_socket(first.getsockname()[1])
    try:
        assert first.getsockname()[0] == second.getsockname()[0] == "127.0.0.1"
        assert first.getsockname()[1] != second.getsockname()[1]
    finally:
        first.close()
        second.close()


@pytest.fixture
def desktop(tmp_path, monkeypatch):
    monkeypatch.setenv("YIJIAN_MODEL_CACHE", str(tmp_path / "models"))
    app = create_app(tmp_path / "data")
    activated = []
    key, ticket = secrets.token_hex(32), secrets.token_urlsafe(32)
    host = DesktopASGI(app, 31999, key, ticket, lambda: activated.append(True))
    with TestClient(host, base_url="http://127.0.0.1:31999") as client:
        yield app, host, client, key, ticket, activated


def test_launch_ticket_sets_private_cookie_once_without_exposing_bootstrap(desktop):
    app, host, client, key, ticket, activated = desktop
    assert client.get("/api/state").status_code == 401
    response = client.get("/_desktop/open", params={"ticket": ticket}, follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/"
    assert "httponly" in response.headers["set-cookie"].lower()
    assert "samesite=strict" in response.headers["set-cookie"].lower()
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert app.state.bootstrap_code not in str(response.headers)
    assert key not in response.text and ticket not in response.text
    assert client.get("/api/state").status_code == 200
    assert client.get("/_desktop/open", params={"ticket": ticket}).status_code == 401
    client.cookies.clear()
    assert client.get("/api/state").status_code == 401
    assert len(app.state.store.read()["browser_sessions"]) == 1


def test_launch_rejects_expired_foreign_and_malformed_tickets(desktop):
    app, host, client, key, ticket, activated = desktop
    assert client.get("/_desktop/open", params={"ticket": "错误"}).status_code == 401
    assert (
        client.get(
            "/_desktop/open", params={"ticket": ticket}, headers={"Origin": "https://example.com"}
        ).status_code
        == 403
    )
    assert (
        client.get("/_desktop/open", params={"ticket": ticket}, headers={"Host": "evil.example"}).status_code
        == 403
    )
    host.ticket_expires = 0
    assert client.get("/_desktop/open", params={"ticket": ticket}).status_code == 401
    assert app.state.store.read()["browser_sessions"] == []


def test_control_has_bidirectional_proof_and_cannot_issue_browser_session(desktop):
    app, host, client, key, ticket, activated = desktop
    challenge = secrets.token_hex(32)
    headers = {"X-Yijian-Challenge": challenge, "X-Yijian-Proof": signature(key, "activate", challenge)}
    assert client.post("/_desktop/activate").status_code == 404
    assert (
        client.post("/_desktop/activate", headers={**headers, "X-Yijian-Proof": "wrong"}).status_code == 403
    )
    response = client.post("/_desktop/activate", headers=headers)
    assert response.status_code == 200 and activated == [True]
    assert response.headers["X-Yijian-Proof"] == signature(key, "response:activate", challenge)
    assert key not in response.text and "set-cookie" not in response.headers
    assert client.get("/api/state").status_code == 401
    assert client.get("/_desktop/ping", headers=headers).status_code == 403
    assert client.cookies.get(COOKIE) is None


@pytest.mark.parametrize(
    "descriptor",
    [
        {"port": "31999", "control_key": "a" * 64},
        {"port": 80, "control_key": "a" * 64},
        {"port": 31999, "control_key": "bad"},
    ],
)
def test_invalid_instance_descriptor_does_not_contact_network(descriptor, monkeypatch):
    monkeypatch.setattr("desktop.runtime.build_opener", lambda *args: pytest.fail("unexpected connection"))
    assert not control_request(descriptor, "ping")


def test_untrusted_service_cannot_pass_activation_handshake(tmp_path, monkeypatch):
    calls = []

    class Response:
        status = 200
        headers = {"X-Yijian-Proof": "invented"}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    class Opener:
        def open(self, request, timeout):
            calls.append(request)
            return Response()

    monkeypatch.setattr("desktop.runtime.build_opener", lambda *args: Opener())
    key = secrets.token_hex(32)
    private_json(tmp_path / "instance.json", {"port": 31999, "control_key": key})
    assert not activate_existing(tmp_path, timeout=0.1)
    assert len(calls) == 1
    assert calls[0].method == "GET" and calls[0].full_url.endswith("/_desktop/ping")
    assert key not in json.dumps(dict(calls[0].header_items()))


def test_bundled_model_is_verified_copied_and_corrupt_bundle_fails(tmp_path, monkeypatch):
    root, data = tmp_path / "bundle", tmp_path / "data"
    (root / "models").mkdir(parents=True)
    model = b"fixture-model"
    monkeypatch.setattr("server.images.MODEL_SHA256", hashlib.sha256(model).hexdigest())
    (root / "models/u2netp.onnx").write_bytes(model)
    assert prepare_bundled_model(root, data)
    assert (data / "models/u2netp.onnx").read_bytes() == model
    (root / "models/u2netp.onnx").write_bytes(b"corrupt")
    assert prepare_bundled_model(root, data)
    with pytest.raises(DesktopError, match="校验失败"):
        prepare_bundled_model(root, tmp_path / "fresh-data")
    assert not list(data.rglob("*.tmp"))


def test_live_service_bootstrap_activation_and_shutdown(tmp_path):
    service = LocalService(tmp_path / "data")
    try:
        service.start()
        assert service.process.is_alive()
        assert smoke_http(service)["authenticated"]
        assert control_request(service.descriptor(), "activate")
        assert service.activation.wait(timeout=1)
        impostor = {**service.descriptor(), "control_key": secrets.token_hex(32)}
        assert not control_request(impostor, "ping")
        assert "items" in Store(tmp_path / "data").read()
    finally:
        assert service.stop()
    assert not service.process.is_alive()
    with socket.socket() as probe:
        probe.settimeout(0.2)
        assert probe.connect_ex(("127.0.0.1", service.port)) != 0
