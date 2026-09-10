from __future__ import annotations

import asyncio
import hashlib
import io
import json
import re
import stat
import zipfile
from contextlib import contextmanager
from copy import deepcopy
from datetime import date
from pathlib import PurePosixPath
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response
from PIL import Image

from .auth import require_access
from .catalog import public_data, timestamp
from .models import ItemInput, OutfitInput, OutfitLayout, PlanInput, ReferencePrice, SettingsPatch, TripInput
from .store import initial_state

router = APIRouter(prefix="/api", dependencies=[Depends(require_access)])
FORMAT = "yijian-workspace"
MAX_ARCHIVE = 96 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_MANIFEST = 8 * 1024 * 1024
MAX_FILE = 24 * 1024 * 1024
MAX_ENTRIES = 10000


def image_urls(item):
    return list(
        dict.fromkeys(
            url
            for url in [
                item.get("image_url"),
                item.get("original_url"),
                item.get("beautified_url"),
                *item.get("extra_images", []),
            ]
            if url
        )
    )


def make_archive(store, images):
    data = deepcopy(public_data(store.read()))
    output = io.BytesIO()
    hashes = {}
    expanded = 0
    names = list(
        dict.fromkeys(url.removeprefix("/api/images/") for item in data["items"] for url in image_urls(item))
    )
    if len(names) + 1 > MAX_ENTRIES:
        raise HTTPException(413, "备份的文件数量超过恢复上限，无法生成可恢复的备份。")

    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:

        def write_entry(name, content):
            nonlocal expanded
            if len(content) > MAX_FILE:
                raise HTTPException(413, "备份中的单个文件超过恢复上限，无法生成可恢复的备份。")
            expanded += len(content)
            if expanded > MAX_EXPANDED:
                raise HTTPException(413, "备份展开后的总容量超过恢复上限，无法生成可恢复的备份。")
            archive.writestr(name, content)
            if output.tell() > MAX_ARCHIVE:
                raise HTTPException(413, "备份压缩包超过恢复容量上限，无法生成可恢复的备份。")

        for name in names:
            with images.resolve(name).open("rb") as photo:
                content = photo.read(MAX_FILE + 1)
            hashes[name] = hashlib.sha256(content).hexdigest()
            write_entry("images/" + name, content)
        manifest = {
            "format": FORMAT,
            "version": 1,
            "exported_at": timestamp(),
            "data": data,
            "sha256": hashes,
        }
        encoded = json.dumps(manifest, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(encoded) > MAX_MANIFEST:
            raise HTTPException(413, "备份清单超过恢复容量上限，无法生成可恢复的备份。")
        write_entry("manifest.json", encoded)
    if output.tell() > MAX_ARCHIVE:
        raise HTTPException(413, "备份压缩包超过恢复容量上限，无法生成可恢复的备份。")
    return output.getvalue()


def valid_uuid(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError("ID 无效")
    return value


def validate_data(data):
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise ValueError("版本无效")
    result = initial_state()
    result["settings"] = SettingsPatch.model_validate(data["settings"]).model_dump(mode="json")
    if result["settings"]["preferences"] is None:
        result["settings"]["preferences"] = initial_state()["settings"]["preferences"]
    collections = ("items", "outfits", "plans", "wear_events", "care_events", "trips")
    for key in collections:
        values = data.get(key, [])
        if not isinstance(values, list) or len(values) > (2000 if key == "items" else 20000):
            raise ValueError("内容数量无效")
        result[key] = deepcopy(values)
        ids = [valid_uuid(entity["id"]) for entity in values]
        if len(set(ids)) != len(ids):
            raise ValueError("ID 重复")
    for item in result["items"]:
        base = ItemInput.model_validate(
            {key: value for key, value in item.items() if key in ItemInput.model_fields}
        ).model_dump(mode="json")
        item.update(base)
        item["reference_price"] = (
            ReferencePrice.model_validate(item["reference_price"]).model_dump(mode="json")
            if item.get("reference_price") is not None
            else None
        )
        item["prior_wear_count"] = int(item.get("prior_wear_count", 0))
        if not 0 <= item["prior_wear_count"] <= 100000:
            raise ValueError("穿着次数无效")
        item["created_at"] = str(item.get("created_at") or timestamp())[:50]
        item["updated_at"] = str(item.get("updated_at") or item["created_at"])[:50]
        item["ai_status"] = "idle" if item["confirmed"] else "review"
        item["ai_error"] = None
        item.pop("ai_job_id", None)
        if item.get("background_status") not in {"skipped", "completed", "failed"}:
            raise ValueError("图片状态无效")
        for url in image_urls(item):
            if not isinstance(url, str) or not re.fullmatch(
                r"/api/images/[a-f0-9]{32}-(?:original|cutout|beautified)\.jpg", url
            ):
                raise ValueError("图片引用无效")
        if item.get("original_url") and not item["original_url"].endswith("-original.jpg"):
            raise ValueError("原图引用无效")
        if item.get("beautified_url") and not item["beautified_url"].endswith("-beautified.jpg"):
            raise ValueError("美化图引用无效")
        if item.get("beautified_source_url") and item["beautified_source_url"] != (
            item.get("original_url") or item.get("image_url")
        ):
            raise ValueError("美化原图引用无效")
    item_ids = {item["id"] for item in result["items"]}
    outfit_ids = {outfit["id"] for outfit in result["outfits"]}

    def refs(ids):
        if len(set(ids)) != len(ids) or any(value not in item_ids for value in ids):
            raise ValueError("衣物引用无效")

    for entity in result["outfits"]:
        if entity["item_ids"]:
            OutfitInput.model_validate(
                {key: value for key, value in entity.items() if key in OutfitInput.model_fields}
            )
        refs(entity["item_ids"])
        if entity.get("layout") is not None:
            entity["layout"] = (
                OutfitLayout.model_validate(entity["layout"])
                .check_items(entity["item_ids"])
                .model_dump(mode="json")
            )
    for entity in result["plans"]:
        PlanInput.model_validate(
            {key: value for key, value in entity.items() if key in PlanInput.model_fields}
        )
        refs(entity["item_ids"])
        if entity.get("outfit_id") and entity["outfit_id"] not in outfit_ids:
            raise ValueError("搭配引用无效")
    for entity in result["trips"]:
        TripInput.model_validate(
            {key: value for key, value in entity.items() if key in TripInput.model_fields}
        )
        if entity["end_date"] < entity["start_date"]:
            raise ValueError("行程日期无效")
        refs([entry["item_id"] for entry in entity["entries"]])
    requests = set()
    for event in result["wear_events"]:
        if not isinstance(event.get("request_id"), str) or event["request_id"] in requests:
            raise ValueError("穿着记录重复")
        requests.add(event["request_id"])
        date.fromisoformat(event["date"])
        if len(set(event["item_ids"])) != len(event["item_ids"]) or not event["item_ids"]:
            raise ValueError("穿着引用无效")
        if any(
            value not in item_ids and not isinstance(event.get("item_names", {}).get(value), str)
            for value in event["item_ids"]
        ):
            raise ValueError("穿着引用无效")
    for event in result["care_events"]:
        date.fromisoformat(event["date"])
        if event["item_id"] not in item_ids and not isinstance(event.get("item_name"), str):
            raise ValueError("洗护引用无效")
    prefs = result["settings"]["preferences"]
    refs(prefs["excluded_ids"])
    for pair in prefs["blocked_pairs"]:
        if len(pair) != 2:
            raise ValueError("排除组合无效")
        refs(pair)
    return result


def read_archive(content):
    if len(content) > MAX_ARCHIVE:
        raise ValueError("备份文件过大")
    archive = zipfile.ZipFile(io.BytesIO(content))
    infos = archive.infolist()
    names = [entry.filename for entry in infos]
    if (
        len(infos) > MAX_ENTRIES
        or len(set(names)) != len(names)
        or sum(entry.file_size for entry in infos) > MAX_EXPANDED
    ):
        raise ValueError("备份内容过大或重复")
    for entry in infos:
        path = PurePosixPath(entry.filename)
        if (
            path.is_absolute()
            or ".." in path.parts
            or "\\" in entry.filename
            or ":" in entry.filename
            or stat.S_ISLNK(entry.external_attr >> 16)
        ):
            raise ValueError("备份路径无效")
        if entry.file_size > MAX_FILE:
            raise ValueError("备份文件过大")
    if "manifest.json" not in names or archive.getinfo("manifest.json").file_size > MAX_MANIFEST:
        raise ValueError("备份清单不存在或过大")
    manifest = json.loads(archive.read("manifest.json"))
    if not isinstance(manifest, dict):
        raise ValueError("备份清单无效")
    if manifest.get("format") == "wardrobe-commons-backup" and manifest.get("version") == 1:
        from .migration import convert_legacy

        data, blobs = convert_legacy(manifest, archive)
    elif manifest.get("format") == FORMAT and manifest.get("version") == 1:
        data = validate_data(manifest["data"])
        blobs = {}
        for item in data["items"]:
            for url in image_urls(item):
                name = url.removeprefix("/api/images/")
                if not re.fullmatch(r"[a-f0-9]{32}-(?:original|cutout|beautified)\.jpg", name):
                    raise ValueError("图片名称无效")
                if name not in blobs:
                    blob = archive.read("images/" + name)
                    if hashlib.sha256(blob).hexdigest() != manifest["sha256"].get(name):
                        raise ValueError("图片校验失败")
                    blobs[name] = blob
    else:
        raise ValueError("备份格式不受支持")
    result = validate_data(data)
    for blob in blobs.values():
        with Image.open(io.BytesIO(blob)) as picture:
            if picture.format != "JPEG" or picture.width * picture.height > 25_000_000:
                raise ValueError("图片格式或分辨率无效")
            picture.verify()
    archive.close()
    return result, blobs


@contextmanager
def exclusive_restore(store):
    import os

    with (store.root / ".restore.lock").open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise HTTPException(409, "另一项恢复正在进行，请等待完成。") from None
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def restore_archive(store, images, content):
    with exclusive_restore(store):
        return _restore_archive(store, images, content)


def _restore_archive(store, images, content):
    data, blobs = read_archive(content)
    existing = store.read()
    if any(existing.get(key) for key in ("items", "outfits", "plans", "wear_events", "care_events", "trips")):
        raise HTTPException(409, "恢复需要空衣橱；已有数据请先另行备份。")
    written = []
    try:
        for name, blob in blobs.items():
            target = images.resolve(name)
            if target.exists():
                if target.read_bytes() != blob:
                    raise ValueError("图片文件冲突")
                continue
            with target.open("xb") as handle:
                written.append(target)
                handle.write(blob)

        def save(state):
            if any(
                state.get(key) for key in ("items", "outfits", "plans", "wear_events", "care_events", "trips")
            ):
                raise HTTPException(409, "衣橱内容已发生变化，恢复已取消。")
            for key in public_data(data):
                state[key] = data[key]
            return {
                "ok": True,
                "items": len(data["items"]),
                "outfits": len(data["outfits"]),
                "wear_events": len(data["wear_events"]),
                "trips": len(data["trips"]),
            }

        return store.update(save)
    except BaseException:
        for target in written:
            target.unlink(missing_ok=True)
        raise


@router.get("/backup")
async def backup(request: Request):
    try:
        content = await asyncio.to_thread(make_archive, request.app.state.store, request.app.state.images)
    except (ValueError, OSError):
        raise HTTPException(409, "部分照片无法读取，请检查数据目录后重试。") from None
    return Response(
        content,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="yijian-backup.zip"'},
    )


@router.post("/restore")
async def restore(request: Request, file: UploadFile = File(...)):
    content = await file.read(MAX_ARCHIVE + 1)
    await file.close()
    try:
        return await asyncio.to_thread(
            restore_archive, request.app.state.store, request.app.state.images, content
        )
    except HTTPException:
        raise
    except (ValueError, KeyError, TypeError, AttributeError, OSError, zipfile.BadZipFile, OverflowError):
        raise HTTPException(422, "备份校验失败，请选择完整且受支持的衣间备份。") from None
