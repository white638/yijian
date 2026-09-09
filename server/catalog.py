from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from fastapi import HTTPException


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def identifier():
    return str(uuid4())


def find(state, collection, entity_id):
    entity = next((item for item in state[collection] if item["id"] == entity_id), None)
    if entity is None:
        raise HTTPException(404, "内容不存在，可能已被删除。")
    return entity


def item_view(item, state):
    result = dict(item)
    result["wear_count"] = item.get("prior_wear_count", 0) + sum(
        item["id"] in event["item_ids"] for event in state["wear_events"]
    )
    result["cost_per_wear"] = (
        str((Decimal(item["price"]) / result["wear_count"]).quantize(Decimal("0.01")))
        if item.get("price") is not None and result["wear_count"]
        else None
    )
    return result


def insights(state):
    items = [item_view(item, state) for item in state["items"]]
    costs = {}
    for item in items:
        if item.get("price") is not None and item["status"] != "archived":
            current = costs.setdefault(item["currency"], {"total": Decimal(0), "priced_items": 0})
            current["total"] += Decimal(item["price"])
            current["priced_items"] += 1
    return {
        "total": len(items),
        "available": sum(item["status"] == "available" for item in items),
        "laundry": sum(item["status"] == "laundry" for item in items),
        "unworn": sum(item["wear_count"] == 0 for item in items),
        "costs": [
            {"currency": currency, "total": str(values["total"]), "priced_items": values["priced_items"]}
            for currency, values in sorted(costs.items(), key=lambda entry: entry[0] or "")
        ],
        "categories": [
            {"category": category, "count": count}
            for category, count in Counter(item["category"] for item in items).items()
        ],
        "colors": [
            {"color": color, "count": count}
            for color, count in Counter(color for item in items for color in item["colors"]).most_common()
        ],
        "most_worn": sorted(
            (item for item in items if item["wear_count"]), key=lambda item: item["wear_count"], reverse=True
        )[:8],
        "unworn_items": [item for item in items if item["wear_count"] == 0][:8],
    }


def public_data(state):
    return {
        key: state.get(key, [])
        for key in (
            "schema_version",
            "settings",
            "items",
            "outfits",
            "plans",
            "wear_events",
            "care_events",
            "trips",
        )
    }
