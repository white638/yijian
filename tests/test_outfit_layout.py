import copy

import pytest
from fastapi.testclient import TestClient

from server.backup import make_archive, read_archive
from server.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("YIJIAN_MODEL_CACHE", str(tmp_path / "empty-models"))
    with TestClient(create_app(tmp_path / "workspace")) as current:
        assert (
            current.post("/api/session", json={"code": current.app.state.bootstrap_code}).status_code == 200
        )
        yield current


def garment(client, name="蓝色上衣", category="top"):
    result = client.post("/api/items", json={"name": name, "category": category, "confirmed": True})
    assert result.status_code == 200
    return result.json()["id"]


def layout(ids):
    return {
        "version": 1,
        "mode": "free",
        "template": "balanced",
        "background": "#f7f5f0",
        "placements": [
            {"item_id": key, "x": 20.5 + i * 5, "y": 35, "width": 27.5, "rotation": -14}
            for i, key in enumerate(ids)
        ],
    }


def saved(client, ids):
    response = client.post("/api/outfits", json={"name": "我的画布", "item_ids": ids, "layout": layout(ids)})
    assert response.status_code == 200, response.text
    return response.json()


def test_canvas_survives_save_reload_and_backup(client):
    ids = [garment(client), garment(client, "银色项链", "accessory")]
    outfit = saved(client, ids)
    changed = layout(ids)
    changed["placements"].reverse()
    changed["placements"][0].update(x=76, y=64, width=16, rotation=30)
    changed["background"] = "#FFFFFF"
    assert client.patch(f"/api/outfits/{outfit['id']}", json={"layout": changed}).status_code == 200
    state = client.get("/api/state").json()
    assert state["outfits"][0]["layout"] == changed
    archive = make_archive(client.app.state.store, client.app.state.images)
    restored, _ = read_archive(archive)
    assert restored["outfits"][0]["layout"] == changed
    assert restored["outfits"][0]["item_ids"] == ids
    assert not restored["wear_events"]


def test_legacy_outfit_and_client_remain_compatible(client):
    first, second = garment(client), garment(client, "帆布包", "bag")
    created = client.post("/api/outfits", json={"name": "旧搭配", "item_ids": [first]}).json()
    assert created["layout"] is None
    outfit = saved(client, [first])
    renamed = client.patch(f"/api/outfits/{outfit['id']}", json={"name": "改名"})
    assert renamed.json()["layout"] == outfit["layout"]
    changed = client.patch(f"/api/outfits/{outfit['id']}", json={"item_ids": [first, second]})
    assert changed.status_code == 200
    assert changed.json()["layout"] is None


def test_reordering_item_ids_keeps_independent_canvas_layers(client):
    ids = [garment(client), garment(client, "围巾", "accessory")]
    outfit = saved(client, ids)
    response = client.patch(f"/api/outfits/{outfit['id']}", json={"item_ids": list(reversed(ids))})
    assert response.status_code == 200
    assert response.json()["layout"] == outfit["layout"]


@pytest.mark.parametrize("bad_ids", [None, [{}], "not-a-list"])
def test_malformed_legacy_edit_is_rejected(client, bad_ids):
    outfit = saved(client, [garment(client)])
    result = client.patch(f"/api/outfits/{outfit['id']}", json={"item_ids": bad_ids})
    assert result.status_code == 422
    assert client.get("/api/state").json()["outfits"][0]["layout"] == outfit["layout"]


@pytest.mark.parametrize(
    "mutation",
    [
        "foreign",
        "duplicate",
        "missing",
        "coordinate",
        "width",
        "rotation",
        "color",
        "mode",
        "version",
        "extra",
    ],
)
def test_invalid_canvas_rejected_without_changing_saved_outfit(client, mutation):
    first, second = garment(client), garment(client, "帽子", "accessory")
    outfit = saved(client, [first])
    bad = copy.deepcopy(outfit["layout"])
    if mutation == "foreign":
        bad["placements"][0]["item_id"] = second
    elif mutation == "duplicate":
        bad["placements"].append(dict(bad["placements"][0]))
    elif mutation == "missing":
        bad["placements"] = []
    elif mutation == "coordinate":
        bad["placements"][0]["x"] = -1
    elif mutation == "width":
        bad["placements"][0]["width"] = 100000
    elif mutation == "rotation":
        bad["placements"][0]["rotation"] = 181
    elif mutation == "color":
        bad["background"] = "url(https://example.com/track)"
    elif mutation == "mode":
        bad["mode"] = "unknown"
    elif mutation == "version":
        bad["version"] = 2
    else:
        bad["placements"][0]["image_url"] = "https://example.com/track"
    result = client.patch(f"/api/outfits/{outfit['id']}", json={"layout": bad})
    assert result.status_code == 422
    assert client.get("/api/state").json()["outfits"][0]["layout"] == outfit["layout"]


def test_deleting_items_prunes_canvas_and_preserves_recoverable_empty_history(client):
    ids = [garment(client), garment(client, "手表", "accessory")]
    saved(client, ids)
    assert client.delete(f"/api/items/{ids[0]}").status_code == 200
    current = client.get("/api/state").json()["outfits"][0]
    assert current["item_ids"] == [ids[1]]
    assert [p["item_id"] for p in current["layout"]["placements"]] == [ids[1]]
    assert client.delete(f"/api/items/{ids[1]}").status_code == 200
    restored, _ = read_archive(make_archive(client.app.state.store, client.app.state.images))
    assert restored["outfits"][0]["item_ids"] == []
    assert restored["outfits"][0]["layout"]["placements"] == []


def test_backup_rejects_canvas_referencing_unselected_item(client):
    from server.backup import validate_data

    first, second = garment(client), garment(client, "帆布包", "bag")
    saved(client, [first])
    data = client.app.state.store.read()
    data["outfits"][0]["layout"]["placements"][0]["item_id"] = second
    with pytest.raises(ValueError):
        validate_data(data)
