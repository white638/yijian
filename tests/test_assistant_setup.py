"""Only the authorized browser installs skills for its selected assistant."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from scripts.install_assistant import files
from server import assistant_setup
from server.main import create_app


@pytest.fixture
def setup_app(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    monkeypatch.setenv("YIJIAN_MODEL_CACHE", str(root / "models"))
    monkeypatch.setattr(assistant_setup, "target_for", lambda provider: root / provider / "skills/yijian")
    return create_app(root / "workspace")


@pytest.fixture
def client(setup_app):
    with TestClient(setup_app) as value:
        yield value


def browser(client, provider="codex"):
    assert client.post("/api/session", json={"code": client.app.state.bootstrap_code}).status_code == 200
    assert client.put("/api/ai/settings", json={"provider": provider}).status_code == 200


def test_anonymous_cannot_inspect_or_install_personal_skills(client):
    assert client.get("/api/ai/assistant/installation", params={"provider": "codex"}).status_code == 401
    assert client.post("/api/ai/assistant/install", json={"provider": "codex"}).status_code == 401
    assert not assistant_setup.target_for("codex").exists()


def test_assistant_token_cannot_inspect_or_install_even_with_browser_cookie(client):
    browser(client)
    code = client.post("/api/ai/connection-code").json()["code"]
    token = client.post("/api/ai/connect", json={"code": code}).json()["access_token"]
    headers = {"Authorization": "Bearer " + token}
    assert client.get("/api/state", headers=headers).status_code == 200
    assert (
        client.get(
            "/api/ai/assistant/installation", params={"provider": "codex"}, headers=headers
        ).status_code
        == 403
    )
    assert (
        client.post("/api/ai/assistant/install", json={"provider": "codex"}, headers=headers).status_code
        == 403
    )
    assert not assistant_setup.target_for("codex").exists()


@pytest.mark.parametrize("provider", ["codex", "claude-code"])
def test_browser_installs_self_contained_skill_and_repeated_install_is_unchanged(client, provider):
    browser(client, provider)
    target = assistant_setup.target_for(provider)
    before = client.get("/api/ai/assistant/installation", params={"provider": provider})
    assert before.status_code == 200
    assert before.json() == {"installed": False, "provider": provider, "path": str(target)}

    response = client.post("/api/ai/assistant/install", json={"provider": provider})
    assert response.status_code == 200, response.text
    assert response.json() == {
        "installed": True,
        "provider": provider,
        "path": str(target),
        "changed": True,
        "backup": None,
    }
    assert (target / "SKILL.md").is_file()
    assert (target / "scripts/yijian.py").is_file()
    assert files(target) == files(assistant_setup.SOURCE)
    installed_times = {
        path.relative_to(target): path.stat().st_mtime_ns for path in target.rglob("*") if path.is_file()
    }

    repeated = client.post("/api/ai/assistant/install", json={"provider": provider})
    assert repeated.status_code == 200
    assert repeated.json()["installed"] is True
    assert repeated.json()["changed"] is False
    assert repeated.json()["backup"] is None
    assert installed_times == {
        path.relative_to(target): path.stat().st_mtime_ns for path in target.rglob("*") if path.is_file()
    }
    assert (
        client.get("/api/ai/assistant/installation", params={"provider": provider}).json()["installed"]
        is True
    )
    assert not list(target.parent.glob("yijian.backup-*"))
    assert not list(target.parent.glob(".yijian-install-*"))


@pytest.mark.parametrize(
    "selected,requested", [("codex", "claude-code"), ("claude-code", "codex"), ("none", "codex")]
)
def test_installation_must_match_the_saved_assistant_provider(client, selected, requested):
    browser(client, selected)
    response = client.post("/api/ai/assistant/install", json={"provider": requested})
    assert response.status_code == 409
    assert "先保存" in response.json()["detail"]
    assert not assistant_setup.target_for(requested).exists()


@pytest.mark.parametrize(
    "headers,expected",
    [
        ({"Origin": "https://attacker.example"}, 403),
        ({"Origin": "http://testserver:9999"}, 403),
        ({"Origin": "http://testserver", "Host": "different.example"}, 400),
        ({"Sec-Fetch-Site": "cross-site"}, 403),
    ],
)
def test_installation_rejects_cross_origin_or_mismatched_host(client, headers, expected):
    browser(client)
    response = client.post("/api/ai/assistant/install", json={"provider": "codex"}, headers=headers)
    assert response.status_code == expected
    assert not assistant_setup.target_for("codex").exists()


def test_browser_same_origin_can_install(client):
    browser(client)
    response = client.post(
        "/api/ai/assistant/install", json={"provider": "codex"}, headers={"Origin": "http://testserver"}
    )
    assert response.status_code == 200
    assert response.json()["installed"] is True


def test_modified_skill_is_reported_outdated_and_preserved_before_replacement(client):
    browser(client)
    assert client.post("/api/ai/assistant/install", json={"provider": "codex"}).status_code == 200
    target = assistant_setup.target_for("codex")
    (target / "SKILL.md").write_text("Personal skill instructions", encoding="utf-8")
    (target / "notes.txt").write_text("Keep my notes", encoding="utf-8")
    personal_files = files(target)
    assert (
        client.get("/api/ai/assistant/installation", params={"provider": "codex"}).json()["installed"]
        is False
    )

    response = client.post("/api/ai/assistant/install", json={"provider": "codex"})
    assert response.status_code == 200
    assert response.json()["installed"] is True
    assert response.json()["changed"] is True
    backup = Path(response.json()["backup"])
    assert backup.parent == target.parent.parent / ".yijian-skill-backups"
    assert not backup.is_relative_to(target.parent)
    assert backup != target
    assert files(backup) == personal_files
    assert (backup / "notes.txt").read_text(encoding="utf-8") == "Keep my notes"
    assert files(target) == files(assistant_setup.SOURCE)
    assert list(target.parent.glob("*/SKILL.md")) == [target / "SKILL.md"]


def test_failed_install_preserves_existing_skill_and_returns_readable_error(client, monkeypatch):
    browser(client)
    target = assistant_setup.target_for("codex")
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text("Keep this version", encoding="utf-8")
    before = files(target)

    def deny(*_args, **_kwargs):
        raise PermissionError("private-internal-path")

    monkeypatch.setattr(assistant_setup, "install", deny)
    response = client.post("/api/ai/assistant/install", json={"provider": "codex"})
    assert response.status_code == 409
    assert "技能安装未完成" in response.json()["detail"]
    assert "private-internal-path" not in response.text
    assert files(target) == before


def test_unsupported_provider_cannot_select_an_installation_directory(client):
    browser(client)
    for provider in ("openai", "../outside", ""):
        assert client.get("/api/ai/assistant/installation", params={"provider": provider}).status_code == 422
        assert client.post("/api/ai/assistant/install", json={"provider": provider}).status_code == 422
    assert not assistant_setup.target_for("codex").exists()
