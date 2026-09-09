import hashlib
import io
import json
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from server.main import create_app
from server.store import Store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("YIJIAN_MODEL_CACHE", str(tmp_path / "empty-models"))
    with TestClient(create_app(tmp_path / "workspace")) as current:
        assert (
            current.post("/api/session", json={"code": current.app.state.bootstrap_code}).status_code == 200
        )
        yield current


def add(client, category="top", **values):
    response = client.post(
        "/api/items", json={"name": f"测试{category}", "category": category, "confirmed": True, **values}
    )
    assert response.status_code == 200, response.text
    return response.json()


def snapshot(client):
    response = client.get("/api/state")
    assert response.status_code == 200, response.text
    return response.json()


def photo():
    buffer = io.BytesIO()
    Image.new("RGB", (80, 100), "navy").save(buffer, "JPEG")
    return buffer.getvalue()


def test_browser_and_assistant_authorization(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        assert client.get("/api/state").status_code == 401
        assert client.post("/api/session", headers={"origin": "https://attacker.example"}).status_code == 403
        assert client.post("/api/session", headers={"sec-fetch-site": "same-site"}).status_code == 403
        assert client.post("/api/session", json={"code": app.state.bootstrap_code}).status_code == 200
        assert (
            client.patch(
                "/api/settings", json={"name": "bad"}, headers={"origin": "http://localhost:1234"}
            ).status_code
            == 403
        )
        assert client.get("/api/state", headers={"host": "attacker.example"}).status_code == 400
        token = "test-bearer-token"
        app.state.store.update(
            lambda s: s["assistant_sessions"].append(
                {
                    "token_hash": hashlib.sha256(token.encode()).hexdigest(),
                    "expires_at": time.time() + 60,
                    "scope": "assistant",
                }
            )
        )
        client.cookies.clear()
        assert client.get("/api/state", headers={"authorization": "Bearer " + token}).status_code == 200
        assert client.get("/api/state", headers={"authorization": "Bearer bad"}).status_code == 401


def test_first_use_skip_and_partial_preferences(client):
    assert snapshot(client)["settings"]["onboarded"] is False
    assert (
        client.patch(
            "/api/settings", json={"name": "小白", "onboarded": True, "preferences": {"temperature": 19}}
        ).status_code
        == 200
    )
    assert client.patch("/api/settings", json={"preferences": {"location": "北京"}}).status_code == 200
    state = snapshot(client)
    assert state["settings"]["name"] == "小白"
    assert state["settings"]["preferences"]["temperature"] == 19
    assert state["ai"]["provider"] == "none"
    assert not {"pairings", "assistant_sessions", "browser_sessions"} & state.keys()


def test_manual_item_validation_and_edit(client):
    item = add(client, price="0", currency=None)
    assert item["price"] == "0.00"
    assert (
        client.patch(f"/api/items/{item['id']}", json={"favorite": True, "name": "白衬衫"}).status_code == 200
    )
    current = snapshot(client)["items"][0]
    assert current["category"] == "top" and current["favorite"]
    for bad in ("-1", "NaN", "Infinity", "100000001"):
        assert client.patch(f"/api/items/{item['id']}", json={"price": bad}).status_code == 422
    response = client.patch(f"/api/items/{item['id']}", json={"api_key": "must-not-echo"})
    assert response.status_code == 422 and "must-not-echo" not in response.text


def test_upload_restore_images_and_invalid_picture(client):
    response = client.post(
        "/api/items/upload",
        files=[("files", ("外套.jpg", photo(), "image/jpeg"))],
        data={"remove_background": "false"},
    )
    assert response.status_code == 200, response.text
    item = response.json()["items"][0]
    assert not item["confirmed"] and item["background_status"] == "skipped"
    original = client.get(item["original_url"]).content
    assert client.post(f"/api/items/{item['id']}/restore").status_code == 200
    assert client.get(snapshot(client)["items"][0]["image_url"]).content == original
    assert (
        client.post(
            "/api/items/upload", files=[("files", ("bad.jpg", b"not image", "image/jpeg"))]
        ).status_code
        == 422
    )
    assert client.get("/api/images/invalid.jpg").status_code == 404


def test_recommendation_requires_real_confirmed_available_items(client):
    top = add(client)
    bottom = add(client, "bottom")
    shoes = add(client, "shoes")
    other = add(client, confirmed=False)
    dirty = add(client, status="laundry")
    archived = add(client, status="archived")
    response = client.post("/api/recommendations", json={"temperature": 25, "locked_ids": [top["id"]]})
    assert response.status_code == 200
    outfits = response.json()["outfits"]
    assert outfits and set(outfits[0]["item_ids"]) == {top["id"], bottom["id"], shoes["id"]}
    for item in (other, dirty, archived):
        assert client.post("/api/recommendations", json={"locked_ids": [item["id"]]}).status_code == 409
    assert (
        client.post(
            "/api/recommendations", json={"locked_ids": [top["id"]], "excluded_ids": [top["id"]]}
        ).status_code
        == 409
    )


def test_blocked_pair_scope_and_one_piece(client):
    top = add(client)
    bottom = add(client, "bottom")
    shoes = add(client, "shoes")
    assert (
        client.patch(
            "/api/settings", json={"preferences": {"blocked_pairs": [[top["id"], bottom["id"]]]}}
        ).status_code
        == 200
    )
    assert client.post("/api/recommendations", json={}).json()["outfits"] == []
    dress = add(client, "dress")
    result = client.post("/api/recommendations", json={"locked_ids": [dress["id"]]}).json()
    assert result["outfits"][0]["item_ids"] == [dress["id"], shoes["id"]]
    assert (
        client.patch("/api/settings", json={"preferences": {"closet_scope": "出差衣橱"}}).status_code == 200
    )
    assert client.post("/api/recommendations", json={}).json()["outfits"] == []


def test_saved_plan_packing_do_not_count_as_wear(client):
    item = add(client, price="120", currency="CNY")
    outfit = client.post("/api/outfits", json={"name": "白色日常", "item_ids": [item["id"]]}).json()
    plan = client.post("/api/plans", json={"date": date.today().isoformat(), "outfit_id": outfit["id"]})
    assert plan.status_code == 200
    trip = client.post(
        "/api/trips",
        json={
            "name": "周末",
            "start_date": "2026-09-10",
            "end_date": "2026-09-12",
            "entries": [{"item_id": item["id"], "packed": True}],
        },
    )
    assert trip.status_code == 200
    assert snapshot(client)["items"][0]["wear_count"] == 0
    request = {"item_ids": [item["id"]], "date": date.today().isoformat(), "request_id": str(uuid4())}
    event = client.post("/api/wear", json=request)
    assert event.status_code == 200
    assert client.post("/api/wear", json=request).json()["id"] == event.json()["id"]
    assert client.post("/api/wear", json={**request, "notes": "different"}).status_code == 409
    state = snapshot(client)
    assert state["items"][0]["wear_count"] == 1
    assert state["items"][0]["cost_per_wear"] == "120.00"
    assert client.delete("/api/wear/" + event.json()["id"]).status_code == 200
    assert snapshot(client)["items"][0]["wear_count"] == 0


def test_future_wear_is_not_a_plan(client):
    item = add(client)
    assert (
        client.post(
            "/api/wear",
            json={
                "item_ids": [item["id"]],
                "date": (date.today() + timedelta(days=1)).isoformat(),
                "request_id": str(uuid4()),
            },
        ).status_code
        == 422
    )


def test_currency_separation_unknown_zero_and_archived(client):
    add(client, price=100, currency="CNY")
    add(client, price=10, currency="USD")
    add(client, price=0, currency="CNY")
    add(client, price=5, currency=None)
    add(client, price=None)
    add(client, price=500, status="archived")
    costs = {value["currency"]: value for value in snapshot(client)["insights"]["costs"]}
    assert costs["CNY"]["total"] == "100.00" and costs["CNY"]["priced_items"] == 2
    assert costs["USD"]["total"] == "10.00"
    assert costs[None]["total"] == "5.00"


def test_delete_item_removes_live_references_keeps_history(client):
    item = add(client)
    outfit = client.post("/api/outfits", json={"name": "搭配", "item_ids": [item["id"]]}).json()
    client.post("/api/plans", json={"date": date.today().isoformat(), "outfit_id": outfit["id"]})
    client.post(
        "/api/wear",
        json={"date": date.today().isoformat(), "item_ids": [item["id"]], "request_id": str(uuid4())},
    )
    client.post(f"/api/items/{item['id']}/wash")
    assert client.delete(f"/api/items/{item['id']}").status_code == 200
    state = snapshot(client)
    assert state["outfits"][0]["item_ids"] == state["plans"][0]["item_ids"] == []
    assert state["wear_events"][0]["item_names"][item["id"]] == item["name"]


def test_trip_partial_update_duplicates_and_dates(client):
    item = add(client)
    trip = client.post(
        "/api/trips", json={"name": "海边", "start_date": "2026-09-10", "end_date": "2026-09-12"}
    ).json()
    url = "/api/trips/" + trip["id"]
    assert client.patch(url, json={"entries": [{"item_id": item["id"], "packed": True}]}).status_code == 200
    assert client.patch(url, json={"entries": [{"item_id": item["id"]}] * 2}).status_code == 422
    assert client.patch(url, json={"end_date": "2026-09-01"}).status_code == 422


def test_backup_round_trip_and_secrets_omitted(client, tmp_path):
    item = client.post(
        "/api/items/upload",
        files=[("files", ("coat.jpg", photo(), "image/jpeg"))],
        data={"remove_background": "false"},
    ).json()["items"][0]
    client.patch(f"/api/items/{item['id']}", json={"confirmed": True, "price": 30})
    client.post(
        "/api/wear",
        json={"item_ids": [item["id"]], "date": date.today().isoformat(), "request_id": str(uuid4())},
    )
    archive = client.get("/api/backup")
    assert archive.status_code == 200
    with zipfile.ZipFile(io.BytesIO(archive.content)) as bundle:
        manifest = json.loads(bundle.read("manifest.json"))
        assert "ai" not in manifest["data"] and "browser_sessions" not in manifest["data"]
    assert client.post("/api/restore", files={"file": ("backup.zip", archive.content)}).status_code == 409
    with TestClient(create_app(tmp_path / "restore")) as other:
        other.post("/api/session", json={"code": other.app.state.bootstrap_code})
        result = other.post("/api/restore", files={"file": ("backup.zip", archive.content)})
        assert result.status_code == 200, result.text
        assert snapshot(other)["items"][0]["wear_count"] == 1
        assert other.get(item["image_url"]).content == client.get(item["image_url"]).content


def test_backup_bad_paths_and_digest_rejected(client):
    fake = io.BytesIO()
    with zipfile.ZipFile(fake, "w") as archive:
        archive.writestr("../escape", b"bad")
        archive.writestr("manifest.json", "{}")
    assert client.post("/api/restore", files={"file": ("bad.zip", fake.getvalue())}).status_code == 422
    assert snapshot(client)["items"] == []


def test_sqlite_transactions_do_not_lose_concurrent_updates(tmp_path):
    store = Store(tmp_path)
    store.update(lambda state: state.update(counter=0))

    def increment(_):
        store.update(lambda state: state.update(counter=state["counter"] + 1))

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(increment, range(40)))
    assert store.read()["counter"] == 40
    assert Store(tmp_path).read()["counter"] == 40


def test_cold_recommendation_tries_other_compatible_layers(client):
    top = add(client)
    add(client, "bottom")
    add(client, "shoes")
    add(client, "outerwear")
    add(client, "outerwear")
    first = client.post("/api/recommendations", json={"temperature": 10}).json()["outfits"][0]
    by_id = {item["id"]: item for item in snapshot(client)["items"]}
    blocked_layer = next(
        item_id for item_id in first["item_ids"] if by_id[item_id]["category"] == "outerwear"
    )
    client.patch("/api/settings", json={"preferences": {"blocked_pairs": [[top["id"], blocked_layer]]}})
    result = client.post("/api/recommendations", json={"temperature": 10})
    assert result.status_code == 200 and result.json()["outfits"]
    assert blocked_layer not in result.json()["outfits"][0]["item_ids"]


def test_partial_capacity_upload_keeps_success_and_runs_background_tasks(client, monkeypatch):
    from server import ai

    template = add(client)
    client.app.state.store.update(
        lambda state: state.update(items=[{**template, "id": str(uuid4())} for _ in range(1999)])
    )
    analyzed = []
    monkeypatch.setattr(ai, "capabilities", lambda store: {"vision": True})
    monkeypatch.setattr(
        ai,
        "queue_analysis",
        lambda store, images, item_id, background, **kwargs: background.add_task(analyzed.append, item_id),
    )
    result = client.post(
        "/api/items/upload",
        files=[("files", (name, photo(), "image/jpeg")) for name in ("first.jpg", "second.jpg")],
        data={"remove_background": "false"},
    )
    assert result.status_code == 200
    assert len(result.json()["items"]) == len(analyzed) == 1
    assert result.json()["warnings"]
    assert len(snapshot(client)["items"]) == 2000


def test_blank_filename_uses_a_readable_default(client):
    result = client.post(
        "/api/items/upload",
        files=[("files", ("   .jpg", photo(), "image/jpeg"))],
        data={"remove_background": "false"},
    )
    assert result.status_code == 200, result.text
    assert result.json()["items"][0]["name"] == "新衣物"
