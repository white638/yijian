from __future__ import annotations

import hashlib
import heapq
import itertools

from fastapi import HTTPException

CATEGORY_NAMES = {
    "top": "上衣",
    "bottom": "下装",
    "dress": "连衣裙",
    "outerwear": "外套",
    "shoes": "鞋",
    "bag": "包",
    "accessory": "配饰",
    "other": "其他",
}


def eligible_items(state: dict, request: dict | None = None) -> list[dict]:
    request = request or {}
    preferences = state["settings"].get("preferences", {})
    excluded = set(request.get("excluded_ids", [])) | set(preferences.get("excluded_ids", []))
    scope = preferences.get("closet_scope", "all")
    return [
        item
        for item in state["items"]
        if item["confirmed"]
        and item["status"] == "available"
        and item["id"] not in excluded
        and (scope == "all" or item.get("closet") == scope)
    ]


def validate_outfit(
    state: dict, ids: list[str], request: dict | None = None, require_complete: bool = True
) -> list[dict]:
    if not ids or len(set(ids)) != len(ids) or len(ids) > 24:
        raise HTTPException(422, "请选择不同的衣物。")
    if request is None:
        by_id = {item["id"]: item for item in state["items"]}
    else:
        by_id = {item["id"]: item for item in eligible_items(state, request)}
    if any(item_id not in by_id for item_id in ids):
        raise HTTPException(409, "部分衣物已不可用，请重新选择。")
    items = [by_id[item_id] for item_id in ids]
    if require_complete:
        if any(not item["confirmed"] or item["status"] != "available" for item in items):
            raise HTTPException(409, "请先确认衣物，并检查待洗和归档状态。")
        counts = {
            category: sum(item["category"] == category for item in items) for category in CATEGORY_NAMES
        }
        if counts["shoes"] != 1 or not (
            (counts["dress"] == 1 and counts["top"] == counts["bottom"] == 0)
            or (counts["dress"] == 0 and counts["top"] == counts["bottom"] == 1)
        ):
            raise HTTPException(422, "完整穿搭需要上衣、下装和鞋，或连衣裙和鞋。")
        if counts["outerwear"] > 1:
            raise HTTPException(422, "一套推荐最多使用一件外套。")
    if request is not None:
        if not set(request.get("locked_ids", [])).issubset(ids):
            raise HTTPException(409, "推荐必须保留已锁定的衣物。")
        for pair in state["settings"].get("preferences", {}).get("blocked_pairs", []):
            if len(pair) == 2 and set(pair).issubset(ids):
                raise HTTPException(409, "这套穿搭包含你排除的组合。")
    return items


def recommend(state: dict, request: dict) -> dict:
    candidates = eligible_items(state, request)
    by_id = {item["id"]: item for item in candidates}
    locked = list(dict.fromkeys(request.get("locked_ids", [])))
    if any(item_id not in by_id for item_id in locked):
        raise HTTPException(409, "锁定的衣物不可用，或已被推荐设置排除。")
    preferences = state["settings"].get("preferences", {})
    temperature = request.get("temperature", 22) + {"cold": -4, "hot": 4}.get(
        preferences.get("sensitivity"), 0
    )
    season = "winter" if temperature < 12 else "summer" if temperature >= 25 else "autumn"
    events = state.get("wear_events", [])
    wears = {
        item_id: by_id[item_id].get("prior_wear_count", 0)
        + sum(item_id in event["item_ids"] for event in events)
        for item_id in by_id
    }

    def score(item):
        value = 8 / (1 + wears[item["id"]])
        if (
            not item["seasons"]
            or season in item["seasons"]
            or (season == "autumn" and "spring" in item["seasons"])
        ):
            value += 5
        if not item["occasions"] or request.get("occasion", "casual") in item["occasions"]:
            value += 5
        if item["favorite"]:
            value += 1
        salt = f"{request.get('seed', 0)}:{item['id']}"
        return value + int(hashlib.sha256(salt.encode()).hexdigest()[:6], 16) / 0xFFFFFF * 5

    groups = {}
    for category in CATEGORY_NAMES:
        fixed = [by_id[item_id] for item_id in locked if by_id[item_id]["category"] == category]
        if len(fixed) > 1 and category in {"top", "bottom", "dress", "outerwear", "shoes"}:
            raise HTTPException(422, "请减少同一类别的锁定衣物。")
        groups[category] = (
            fixed
            or sorted((item for item in candidates if item["category"] == category), key=score, reverse=True)[
                :18
            ]
        )
    combinations = []
    if not any(by_id[i]["category"] == "dress" for i in locked):
        combinations.extend(itertools.product(groups["top"], groups["bottom"], groups["shoes"]))
    if not any(by_id[i]["category"] in {"top", "bottom"} for i in locked):
        combinations.extend(itertools.product(groups["dress"], groups["shoes"]))
    ranked = []
    scores = {item["id"]: score(item) for item in candidates}
    layers = [None]
    if temperature < 18 or any(by_id[i]["category"] == "outerwear" for i in locked):
        layers = groups["outerwear"] or [None]
    blocked_pairs = [set(pair) for pair in preferences.get("blocked_pairs", []) if len(pair) == 2]
    for base in combinations:
        for layer in layers:
            items = list(base) + ([layer] if layer else [])
            items.extend(by_id[i] for i in locked if i not in {item["id"] for item in items})
            ids = {item["id"] for item in items}
            if any(pair.issubset(ids) for pair in blocked_pairs):
                continue
            entry = (sum(scores[item["id"]] for item in items) / len(items), tuple(sorted(ids)), items)
            if len(ranked) < 3:
                heapq.heappush(ranked, entry)
            elif entry[:2] > ranked[0][:2]:
                heapq.heapreplace(ranked, entry)
    ranked.sort(key=lambda entry: entry[:2], reverse=True)
    outfits = []
    for _, _, items in ranked:
        validate_outfit(state, [item["id"] for item in items], request)
        unworn = sum(wears[item["id"]] == 0 for item in items)
        reason = "从已确认、当前可穿的衣物中组合。"
        if unworn:
            reason += f"包含 {unworn} 件尚未记录穿着的单品。"
        if temperature < 18 and any(item["category"] == "outerwear" for item in items):
            reason += "按当前气温加入外套。"
        outfits.append(
            {
                "name": f"{items[0]['name']}的搭配",
                "item_ids": [item["id"] for item in items],
                "reason": reason,
                "source": "rules",
            }
        )
    missing = []
    if not groups["shoes"]:
        missing.append("shoes")
    if not groups["dress"]:
        missing.extend(category for category in ("top", "bottom") if not groups[category])
    return {
        "outfits": outfits,
        "missing": missing,
        "message": "" if outfits else "请补充并确认所需衣物，或调整锁定、排除和衣橱范围。",
    }
