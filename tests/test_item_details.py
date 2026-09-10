from __future__ import annotations

import asyncio
import io
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from PIL import Image

from server import ai, host_vision
from server.auth import digest
from server.backup import make_archive, restore_archive
from server.main import create_app
from server.models import ItemInput
from server.images import ImagePipeline
from server.store import Store

pytestmark = pytest.mark.anyio
DETAILS = {
    "subcategory": "针织开衫",
    "materials": ["羊毛", "聚酯纤维"],
    "pattern": "条纹",
    "styles": ["通勤", "复古"],
    "fit": "宽松",
    "cut": "落肩",
    "neckline": "V领",
    "sleeve_length": "长袖",
    "length": "及臀",
    "size": "M",
    "care_notes": "手洗，平铺晾干",
}
OBSERVABLE = {key: value for key, value in DETAILS.items() if key not in {"materials", "size", "care_notes"}}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def case(tmp_path):
    app = create_app(tmp_path / "data")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        assert (await client.post("/api/session", json={"code": app.state.bootstrap_code})).status_code == 200
        yield SimpleNamespace(app=app, client=client, store=app.state.store, images=app.state.images)


async def create_item(case, **changes):
    response = await case.client.post("/api/items", json={"name": "我的上衣", "category": "top", **changes})
    assert response.status_code == 200, response.text
    return response.json()


async def add_photo(case, **changes):
    item = await create_item(case, **changes)
    content = io.BytesIO()
    Image.new("RGB", (90, 120), "navy").save(content, "PNG")
    picture = case.images.prepare(content.getvalue(), False)
    case.store.update(lambda state: state["items"][0].update(picture))
    return item["id"]


async def configure(case, provider, monkeypatch):
    if provider == "codex":

        def host(state):
            state["ai"]["configuration"] = {"provider": "codex", "automatic_vision": True}
            state["assistant_sessions"] = [
                {
                    "provider": "codex",
                    "token_hash": digest("codex"),
                    "expires_at": time.time() + 3600,
                    "verified_at": time.time(),
                }
            ]

        case.store.update(host)
        monkeypatch.setattr(ai, "_host_available", lambda: True)
    else:
        response = await case.client.put(
            "/api/ai/settings",
            json={
                "provider": provider,
                "base_url": "http://localhost:11434/v1"
                if provider == "ollama"
                else "https://vision.example/v1",
                "vision_model": "vision-one",
                "api_key": "test-vision-key" if provider != "ollama" else None,
            },
        )
        assert response.status_code == 200, response.text


async def test_detail_fields_create_patch_and_backup_preserve_values(case, tmp_path):
    item = await create_item(
        case, **{**DETAILS, "materials": [" 羊毛 ", "羊毛", "聚酯纤维"], "styles": ["通勤", " 复古 ", "通勤"]}
    )
    for key, value in DETAILS.items():
        assert item[key] == value
    response = await case.client.patch(f"/api/items/{item['id']}", json={"name": "调整名称", "fit": "修身"})
    assert response.status_code == 200
    changed = response.json()
    assert changed["fit"] == "修身"
    for key, value in DETAILS.items():
        if key != "fit":
            assert changed[key] == value
    archive = make_archive(case.store, case.images)
    target = Store(tmp_path / "restored")
    assert restore_archive(target, ImagePipeline(target.root / "images"), archive)["ok"]
    restored = target.read()["items"][0]
    assert {key: restored[key] for key in DETAILS} == {**DETAILS, "fit": "修身"}


@pytest.mark.parametrize(
    "changes",
    [
        {"subcategory": "字" * 81},
        {"materials": ["棉"] * 11},
        {"materials": ["字" * 81]},
        {"materials": "棉"},
        {"styles": ["通勤"] * 13},
        {"styles": ["字" * 81]},
        {"pattern": "字" * 81},
        {"fit": "字" * 41},
        {"cut": "字" * 81},
        {"neckline": "字" * 81},
        {"sleeve_length": "字" * 41},
        {"length": "字" * 41},
        {"size": "字" * 81},
        {"care_notes": "字" * 1001},
        {"subcategory": None},
    ],
)
async def test_detail_field_limits_reject_invalid_create_and_patch(case, changes):
    assert (await case.client.post("/api/items", json={"name": "上衣", **changes})).status_code == 422
    item = await create_item(case, **DETAILS)
    assert (await case.client.patch(f"/api/items/{item['id']}", json=changes)).status_code == 422
    assert {key: case.store.read()["items"][0][key] for key in DETAILS} == DETAILS


async def test_legacy_item_can_be_read_and_sparsely_edited_without_new_fields(case):
    item = await create_item(case)
    case.store.update(lambda state: [state["items"][0].pop(key) for key in DETAILS])
    response = await case.client.get("/api/state")
    assert response.status_code == 200 and response.json()["items"][0]["id"] == item["id"]
    changed = await case.client.patch(f"/api/items/{item['id']}", json={"notes": "手动备注"})
    assert changed.status_code == 200 and changed.json()["notes"] == "手动备注"
    defaults = ItemInput().model_dump()
    assert all(defaults[key] == ([] if key in {"materials", "styles"} else "") for key in DETAILS)


@pytest.mark.parametrize("provider", ["openai", "compatible", "ollama", "codex"])
async def test_all_vision_providers_save_observable_details_without_guessing_material_size_or_care(
    case, monkeypatch, provider
):
    item_id = await add_photo(case, size="XL", care_notes="衣标注明干洗", materials=["用户确认的羊毛"])
    await configure(case, provider, monkeypatch)
    description = {
        "name": "蓝色条纹针织开衫",
        "category": "top",
        "colors": ["蓝色"],
        **OBSERVABLE,
        "styles": [" 通勤 ", "通勤", "复古"],
        "materials": ["100%棉"],
        "size": "S",
        "care_notes": "随意机洗",
        "price": "99999",
    }
    if provider == "codex":
        inference = AsyncMock(return_value=description)
        monkeypatch.setattr(host_vision, "describe", inference)
    else:
        inference = AsyncMock(return_value=json.dumps(description))
        monkeypatch.setattr(ai, "completion", inference)
    await ai.analyze_item(case.store, case.images, item_id)
    item = case.store.read()["items"][0]
    assert item["ai_status"] == "review" and not item["confirmed"]
    for key, value in OBSERVABLE.items():
        assert item[key] == value
    assert item["materials"] == ["用户确认的羊毛"]
    assert item["size"] == "XL" and item["care_notes"] == "衣标注明干洗"
    assert item["price"] is None and "materials_evidence" not in item
    if provider == "codex":
        prompt = inference.await_args.args[2]
        schema = inference.await_args.args[1]
        assert "subcategory" in schema["properties"] and "size" not in schema["properties"]
    else:
        prompt = inference.await_args.args[1][0]["content"]
    assert "不能根据布料外观" in prompt and "materials_evidence" in prompt
    assert "不要输出size或care_notes" in prompt


async def test_visible_material_label_evidence_allows_materials_but_is_not_stored(case, monkeypatch):
    item_id = await add_photo(case)
    await configure(case, "ollama", monkeypatch)
    description = {
        "name": "棉质上衣",
        "category": "top",
        "materials": ["棉", "棉", "聚酯纤维"],
        "materials_evidence": "衣标原文：棉80%，聚酯纤维20%",
    }
    monkeypatch.setattr(ai, "completion", AsyncMock(return_value=json.dumps(description)))
    await ai.analyze_item(case.store, case.images, item_id)
    item = case.store.read()["items"][0]
    assert item["materials"] == ["棉", "聚酯纤维"] and "materials_evidence" not in item


@pytest.mark.parametrize("brand", ["", "   "])
async def test_unknown_recognized_brand_preserves_known_brand(case, monkeypatch, brand):
    item_id = await add_photo(case, brand="用户确认品牌")
    await configure(case, "compatible", monkeypatch)
    description = {"name": "识别上衣", "category": "top", "brand": brand}
    monkeypatch.setattr(ai, "completion", AsyncMock(return_value=json.dumps(description)))
    await ai.analyze_item(case.store, case.images, item_id)
    item = case.store.read()["items"][0]
    assert item["ai_status"] == "review" and item["name"] == "识别上衣"
    assert item["brand"] == "用户确认品牌"


@pytest.mark.parametrize("empty_details", [False, True])
async def test_legacy_or_unknown_description_details_preserve_user_values(case, monkeypatch, empty_details):
    item_id = await add_photo(case, **DETAILS)
    await configure(case, "compatible", monkeypatch)
    description = {
        "name": "识别名称",
        "category": "top",
        "colors": ["蓝色"],
        "seasons": [],
        "occasions": [],
        "tags": [],
        "brand": "",
    }
    if empty_details:
        description.update({key: [] if key in {"materials", "styles"} else "" for key in DETAILS})
    monkeypatch.setattr(ai, "completion", AsyncMock(return_value=json.dumps(description)))
    await ai.analyze_item(case.store, case.images, item_id)
    item = case.store.read()["items"][0]
    assert item["name"] == "识别名称" and item["ai_status"] == "review"
    assert {key: item[key] for key in DETAILS} == DETAILS


async def test_manual_detail_edits_during_recognition_are_not_overwritten(case, monkeypatch):
    item_id = await add_photo(case, **DETAILS)
    await configure(case, "ollama", monkeypatch)
    started, release = asyncio.Event(), asyncio.Event()

    async def inference(*args, **kwargs):
        started.set()
        await release.wait()
        return json.dumps({"name": "模型名称", "category": "top", "fit": "修身", "pattern": "纯色"})

    monkeypatch.setattr(ai, "completion", inference)
    task = asyncio.create_task(ai.analyze_item(case.store, case.images, item_id))
    try:
        await asyncio.wait_for(started.wait(), 2)
        changed = await case.client.patch(f"/api/items/{item_id}", json={"fit": "手动确认宽松", "size": "L"})
        assert changed.status_code == 200
        release.set()
        await asyncio.wait_for(task, 3)
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
    item = case.store.read()["items"][0]
    assert item["fit"] == "手动确认宽松" and item["size"] == "L" and item["pattern"] == DETAILS["pattern"]
    assert item["name"] == "我的上衣"


@pytest.mark.parametrize(
    "details",
    [{"materials": ["x" * 81]}, {"styles": ["x" * 81]}, {"fit": "x" * 41}, {"subcategory": "x" * 81}],
)
async def test_invalid_recognition_details_preserve_existing_item(case, monkeypatch, details):
    item_id = await add_photo(case, **DETAILS)
    await configure(case, "ollama", monkeypatch)
    monkeypatch.setattr(
        ai,
        "completion",
        AsyncMock(return_value=json.dumps({"name": "错误结果", "category": "top", **details})),
    )
    await ai.analyze_item(case.store, case.images, item_id)
    item = case.store.read()["items"][0]
    assert item["ai_status"] == "error" and item["name"] == "我的上衣"
    assert {key: item[key] for key in DETAILS} == DETAILS


async def test_codex_schema_includes_optional_details_without_requiring_them_in_legacy_responses():
    schema = ai.GarmentDescription.model_json_schema()
    assert "subcategory" not in schema["required"] and "materials_evidence" not in schema["required"]
    strict = host_vision.strict_schema(schema)
    assert set(strict["required"]) == set(strict["properties"])
    assert strict["additionalProperties"] is False
    assert "size" not in strict["properties"] and "care_notes" not in strict["properties"]
    legacy = ai.GarmentDescription.model_validate({"name": "上衣", "category": "top"})
    assert legacy.subcategory == "" and legacy.materials == []
    assert legacy.model_dump(exclude_unset=True) == {"name": "上衣", "category": "top"}
