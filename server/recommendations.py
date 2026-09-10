from __future__ import annotations

import hashlib
import heapq
import itertools
import re

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

ACCESSORY_TYPES = (
    ("scarf", r"围巾|围脖|丝巾|披肩|\bscarf\b|\bshawl\b"),
    ("hat", r"帽|\bhat\b|\bcap\b|\bbeanie\b"),
    ("gloves", r"手套|\bgloves?\b"),
    ("belt", r"腰带|皮带|\bbelt\b"),
    ("glasses", r"眼镜|墨镜|\bglasses\b|\bsunglasses\b"),
    ("watch", r"手表|腕表|\bwatch\b"),
    ("earrings", r"耳环|耳钉|耳饰|耳夹|\bearrings?\b"),
    ("necklace", r"项链|项圈|吊坠|\bnecklace\b|\bpendant\b"),
    ("bracelet", r"手链|手镯|腕链|\bbracelet\b|\bbangle\b"),
    ("ring", r"戒指|指环|\bring\b"),
    ("brooch", r"胸针|\bbrooch\b"),
    ("tie", r"领带|领结|\btie\b"),
)


def _accessory_text(item: dict) -> str:
    return " ".join([item.get("name", ""), *item.get("tags", [])]).lower()


def _accessory_type(item: dict) -> str:
    text = _accessory_text(item)
    return next((kind for kind, pattern in ACCESSORY_TYPES if re.search(pattern, text)), "other")


def _optional_suitable(item: dict, request: dict, temperature: float, season: str) -> bool:
    seasons = item.get("seasons", [])
    if (
        seasons
        and "all" not in seasons
        and season not in seasons
        and not (season == "autumn" and "spring" in seasons)
    ):
        return False
    occasions = item.get("occasions", [])
    if occasions and request.get("occasion", "casual") not in occasions:
        return False
    if item["category"] == "accessory" and temperature >= 22:
        kind, text = _accessory_type(item), _accessory_text(item)
        if kind == "scarf" and not re.search(r"丝巾|\bsilk\b", text):
            return False
        if kind == "gloves" and not re.search(r"防晒|骑行|\bcycling\b", text):
            return False
        if kind == "hat" and re.search(
            r"保暖|毛线|针织|羊毛|绒|\bwool\b|\bbeanie\b|\bknit\b|\bwinter\b", text
        ):
            return False
    return True


def _temperature_and_season(preferences: dict, request: dict) -> tuple[float, str]:
    temperature = request.get("temperature", 22) + {"cold": -4, "hot": 4}.get(
        preferences.get("sensitivity"), 0
    )
    season = "winter" if temperature < 12 else "summer" if temperature >= 25 else "autumn"
    return temperature, season


def validate_optional_items(items: list[dict], request: dict, preferences: dict) -> None:
    locked = set(request.get("locked_ids", []))
    temperature, season = _temperature_and_season(preferences, request)
    for category, limit in (("bag", 1), ("accessory", 2)):
        chosen = [item for item in items if item["category"] == category]
        fixed = [item for item in chosen if item["id"] in locked]
        extra = [item for item in chosen if item["id"] not in locked]
        if len(extra) > max(0, limit - len(fixed)):
            raise HTTPException(422, "自动搭配最多补充一个包和两件配饰，请减少额外单品。")
        if any(not _optional_suitable(item, request, temperature, season) for item in extra):
            raise HTTPException(422, "额外选择的包或配饰不适合当前季节、气温或场合，请重新搭配。")
        if category == "accessory":
            kinds = {_accessory_type(item) for item in fixed}
            for item in extra:
                kind = _accessory_type(item)
                if kind in kinds:
                    raise HTTPException(422, "自动搭配请避免重复叠加同类配饰。")
                kinds.add(kind)


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
    temperature, season = _temperature_and_season(preferences, request)
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
    optional = sorted(
        (
            item
            for item in candidates
            if item["category"] in {"accessory", "bag"}
            and _optional_suitable(item, request, temperature, season)
        ),
        key=lambda item: scores[item["id"]],
        reverse=True,
    )

    def with_optional(items):
        selected = list(items)
        ids = {item["id"] for item in selected}
        counts = {
            category: sum(item["category"] == category for item in selected)
            for category in ("accessory", "bag")
        }
        kinds = {_accessory_type(item) for item in selected if item["category"] == "accessory"}
        for item in optional:
            category = item["category"]
            if item["id"] in ids or counts[category] >= (1 if category == "bag" else 2):
                continue
            kind = _accessory_type(item) if category == "accessory" else None
            if kind in kinds or any(pair.issubset(ids | {item["id"]}) for pair in blocked_pairs):
                continue
            selected.append(item)
            ids.add(item["id"])
            counts[category] += 1
            if kind:
                kinds.add(kind)
        return selected

    bases = [entry[2] for entry in ranked]
    enhanced = [with_optional(items) for items in bases]
    variants = [enhanced[0], bases[0], *enhanced[1:], *bases[1:]] if bases else []
    outfits = []
    seen = set()
    for items in variants:
        signature = tuple(sorted(item["id"] for item in items))
        if signature in seen:
            continue
        seen.add(signature)
        validate_outfit(state, [item["id"] for item in items], request)
        validate_optional_items(items, request, preferences)
        unworn = sum(wears[item["id"]] == 0 for item in items)
        reason = "从已确认、当前可穿的衣物中组合。"
        if unworn:
            reason += f"包含 {unworn} 件尚未记录穿着的单品。"
        if temperature < 18 and any(item["category"] == "outerwear" for item in items):
            reason += "按当前气温加入外套。"
        if any(item["category"] in {"accessory", "bag"} and item["id"] not in locked for item in items):
            reason += "按场合与气温补充少量配饰或包。"
        outfits.append(
            {
                "name": f"{items[0]['name']}的搭配",
                "item_ids": [item["id"] for item in items],
                "reason": reason,
                "source": "rules",
            }
        )
        if len(outfits) == 3:
            break
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
