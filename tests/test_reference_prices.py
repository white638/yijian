from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from server.backup import validate_data
from server.catalog import public_data
from server.main import create_app
from server.models import ReferencePrice


REFERENCE = {
    "amount": 399,
    "currency": "CNY",
    "label": "发售价格",
    "observed_at": "2026-09-09T12:00:00Z",
    "source_url": "https://shop.example/product/123",
}


def with_reference(client):
    item = client.post("/api/items", json={"name": "参考价格单品", "confirmed": True}).json()
    reference = ReferencePrice.model_validate(REFERENCE).model_dump(mode="json")
    client.app.state.store.update(lambda s: s["items"][0].update(reference_price=reference))
    return item, reference


def test_reference_price_requires_confirmed_purchase_for_costs_and_survives_backup(tmp_path):
    with TestClient(create_app(tmp_path / "source")) as client:
        client.post("/api/session", json={"code": client.app.state.bootstrap_code})
        item, reference = with_reference(client)
        state = client.get("/api/state").json()
        assert state["items"][0]["price"] is None
        assert state["insights"]["costs"] == []
        assert (
            client.post(
                "/api/wear",
                json={"item_ids": [item["id"]], "date": "2026-09-09", "request_id": "reference-price-wear"},
            ).status_code
            == 200
        )
        assert client.get("/api/state").json()["items"][0]["cost_per_wear"] is None
        response = client.patch(f"/api/items/{item['id']}", json={"price": 199, "currency": "CNY"})
        assert response.status_code == 200
        assert response.json()["cost_per_wear"] == "199.00"
        assert response.json()["reference_price"] == reference
        archive = client.get("/api/backup")
        assert archive.status_code == 200
        with TestClient(create_app(tmp_path / "restored")) as restored:
            restored.post("/api/session", json={"code": restored.app.state.bootstrap_code})
            response = restored.post("/api/restore", files={"file": ("wardrobe.zip", archive.content)})
            assert response.status_code == 200, response.text
            restored_item = restored.get("/api/state").json()["items"][0]
            assert restored_item["reference_price"] == reference
            assert restored_item["price"] == "199.00"


def test_reference_source_metadata_is_not_client_editable(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        client.post("/api/session", json={"code": client.app.state.bootstrap_code})
        item, reference = with_reference(client)
        forged = {**reference, "amount": 1}
        assert (
            client.post("/api/items", json={"name": "伪造来源", "reference_price": forged}).status_code == 422
        )
        assert client.patch(f"/api/items/{item['id']}", json={"reference_price": forged}).status_code == 422
        assert client.patch(f"/api/items/{item['id']}", json={"name": "重新命名"}).status_code == 200
        assert client.get("/api/state").json()["items"][0]["reference_price"] == reference


@pytest.mark.parametrize(
    "change",
    [
        {"amount": -1},
        {"amount": float("inf")},
        {"amount": True},
        {"currency": "UNKNOWN"},
        {"label": "实付价格"},
        {"source_url": "javascript:alert(1)"},
        {"source_url": "https://user:secret@shop.example/"},
        {"observed_at": "2026-09-09T12:00:00"},
    ],
)
def test_restore_validates_reference_price_metadata(tmp_path, change):
    with TestClient(create_app(tmp_path)) as client:
        client.post("/api/session", json={"code": client.app.state.bootstrap_code})
        with_reference(client)
        data = deepcopy(public_data(client.app.state.store.read()))
        data["items"][0]["reference_price"].update(change)
        with pytest.raises(ValueError):
            validate_data(data)
