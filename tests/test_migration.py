import io
import json
import zipfile
from uuid import uuid4

from PIL import Image
import pytest

from server.backup import make_archive, read_archive, restore_archive
from server.catalog import item_view
from server.images import ImagePipeline
from server.store import Store


def legacy_archive():
    item_id, wear_id, wash_id = (str(uuid4()) for _ in range(3))
    image = io.BytesIO()
    Image.new("RGB", (60, 70), "blue").save(image, "JPEG")
    manifest = {
        "format": "wardrobe-commons-backup",
        "version": 1,
        "items": [
            {
                "id": item_id,
                "attributes": {
                    "name": "蓝色外套",
                    "type": "jacket",
                    "purchase_price": "0",
                    "purchase_currency": None,
                    "wear_count": 5,
                    "tagged_by": "manual",
                    "colors": ["蓝色"],
                    "created_at": "2026-09-01T12:00:00Z",
                },
                "image_path": "assets/item.jpg",
                "original_image_path": None,
                "thumbnail_path": None,
                "medium_path": None,
                "additional_images": [],
            }
        ],
        "wear_history": [{"id": wear_id, "item_id": item_id, "worn_at": "2026-09-02", "notes": "散步"}],
        "wash_history": [{"id": wash_id, "item_id": item_id, "washed_at": "2026-09-03"}],
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        archive.writestr("assets/item.jpg", image.getvalue())
    return output.getvalue(), image.getvalue()


def test_legacy_import_preserves_money_images_and_count_without_inventing_dates(tmp_path):
    content, original = legacy_archive()
    store = Store(tmp_path)
    images = ImagePipeline(tmp_path / "images")
    result = restore_archive(store, images, content)
    assert result["items"] == 1 and result["wear_events"] == 1
    state = store.read()
    item = item_view(state["items"][0], state)
    assert item["category"] == "outerwear" and item["name"] == "蓝色外套"
    assert item["price"] == "0.00" and item["currency"] is None
    assert item["wear_count"] == 5 and item["prior_wear_count"] == 4
    assert state["care_events"][0]["date"] == "2026-09-03"
    assert images.resolve(item["original_url"].split("/")[-1]).read_bytes() == original
    new_data, blobs = read_archive(make_archive(store, images))
    assert new_data["items"][0]["prior_wear_count"] == 4
    assert list(blobs.values()) == [original]


def test_digest_corruption_keeps_destination_empty(tmp_path):
    content, _ = legacy_archive()
    source = Store(tmp_path / "source")
    images = ImagePipeline(source.root / "images")
    restore_archive(source, images, content)
    exported = make_archive(source, images)
    target = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(exported)) as archive, zipfile.ZipFile(target, "w") as modified:
        for name in archive.namelist():
            blob = archive.read(name)
            modified.writestr(name, blob + b"changed" if name.startswith("images/") else blob)
    destination = Store(tmp_path / "destination")
    with pytest.raises(ValueError):
        restore_archive(destination, ImagePipeline(destination.root / "images"), target.getvalue())
    assert destination.read()["items"] == []
    assert list((destination.root / "images").iterdir()) == []
