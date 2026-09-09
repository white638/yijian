from __future__ import annotations

from collections import Counter
from uuid import uuid4

from .catalog import timestamp
from .models import ItemInput
from .store import initial_state

CATEGORIES = {
    "shirt": "top",
    "tshirt": "top",
    "t-shirt": "top",
    "sweater": "top",
    "hoodie": "top",
    "top": "top",
    "pants": "bottom",
    "jeans": "bottom",
    "shorts": "bottom",
    "skirt": "bottom",
    "bottom": "bottom",
    "dress": "dress",
    "jumpsuit": "dress",
    "romper": "dress",
    "onepiece": "dress",
    "jacket": "outerwear",
    "coat": "outerwear",
    "blazer": "outerwear",
    "outerwear": "outerwear",
    "shoes": "shoes",
    "boots": "shoes",
    "sneakers": "shoes",
    "sandals": "shoes",
    "bag": "bag",
    "accessory": "accessory",
    "accessories": "accessory",
    "hat": "accessory",
    "scarf": "accessory",
}


def convert_legacy(manifest, archive):
    state = initial_state()
    state["settings"]["onboarded"] = True
    state["settings"]["name"] = ""
    blobs, mapping = {}, {}
    wear_counts = Counter(event["item_id"] for event in manifest.get("wear_history", []))

    def picture(path, role):
        if not path:
            return None
        if path not in mapping:
            name = f"{uuid4().hex}-{role}.jpg"
            blobs[name] = archive.read(path)
            mapping[path] = "/api/images/" + name
        return mapping[path]

    for old in manifest["items"]:
        attrs = old["attributes"]
        colors = attrs.get("colors") or ([attrs["primary_color"]] if attrs.get("primary_color") else [])
        tags = attrs.get("tags") or {}
        tags = list(tags) if isinstance(tags, dict) else tags
        value = ItemInput(
            name=attrs.get("name") or "导入的衣物",
            category=CATEGORIES.get(attrs.get("type"), "other"),
            colors=colors,
            seasons=attrs.get("season") or [],
            tags=tags[:30],
            status="archived"
            if attrs.get("is_archived")
            else "laundry"
            if attrs.get("needs_wash")
            else "available",
            confirmed=attrs.get("tagged_by") == "manual",
            favorite=bool(attrs.get("favorite")),
            price=attrs.get("purchase_price"),
            currency=attrs.get("purchase_currency"),
            brand=attrs.get("brand") or "",
            notes=attrs.get("notes") or "",
            purchased_at=attrs.get("purchase_date"),
        ).model_dump(mode="json")
        original_path = old.get("original_image_path") or old.get("image_path")
        original = picture(original_path, "original")
        processed = picture(old.get("image_path"), "cutout") or original
        extras = [
            picture(path, "cutout")
            for path in (old.get("thumbnail_path"), old.get("medium_path"))
            if path and path not in {original_path, old.get("image_path")}
        ]
        for additional in old.get("additional_images") or []:
            path = additional.get("image_path") if isinstance(additional, dict) else additional
            if path:
                extras.append(picture(path, "cutout"))
        state["items"].append(
            {
                **value,
                "id": old["id"],
                "created_at": attrs.get("created_at") or timestamp(),
                "updated_at": attrs.get("updated_at") or timestamp(),
                "image_url": processed,
                "original_url": original,
                "extra_images": extras,
                "background_status": "completed" if processed != original else "skipped",
                "ai_status": "idle" if value["confirmed"] else "review",
                "ai_error": None,
                "prior_wear_count": max(0, int(attrs.get("wear_count") or 0) - wear_counts[old["id"]]),
                "imported_metadata": attrs,
            }
        )
    by_id = {item["id"]: item for item in state["items"]}
    for old in manifest.get("wear_history", []):
        item = by_id[old["item_id"]]
        state["wear_events"].append(
            {
                "id": old["id"],
                "request_id": "import-" + old["id"],
                "item_ids": [item["id"]],
                "item_names": {item["id"]: item["name"]},
                "date": old["worn_at"][:10],
                "notes": old.get("notes") or "",
                "created_at": old.get("created_at") or timestamp(),
            }
        )
    for old in manifest.get("wash_history", []):
        item = by_id[old["item_id"]]
        state["care_events"].append(
            {
                "id": old["id"],
                "item_id": item["id"],
                "item_name": item["name"],
                "date": old["washed_at"][:10],
                "action": "wash",
                "created_at": old.get("created_at") or timestamp(),
            }
        )
    return state, blobs
