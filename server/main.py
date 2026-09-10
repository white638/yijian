from __future__ import annotations

import asyncio
import hashlib
import os
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .auth import COOKIE, bootstrap_key, create_browser_session, require_access
from .catalog import find, identifier, insights, item_view, public_data, timestamp
from .models import (
    ItemInput,
    ItemPatch,
    OutfitInput,
    PlanInput,
    RecommendationInput,
    ReferencePrice,
    SettingsPatch,
    SessionInput,
    TripInput,
    WearInput,
)
from .recommendations import recommend, validate_outfit
from .store import Store


def create_app(data_dir: Path | str | None = None) -> FastAPI:
    from . import ai
    from .images import ImagePipeline
    from .backup import router as backup_router
    from .assistant_setup import router as assistant_setup_router
    from .product_import import PreviewCache, router as product_import_router

    @asynccontextmanager
    async def lifespan(application):
        ai.recover_interrupted_jobs(application.state.store)
        yield

    application = FastAPI(
        title="衣间", version="0.2.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None
    )
    application.state.store = Store(
        Path(
            data_dir or os.environ.get("YIJIAN_DATA", Path(__file__).resolve().parents[1] / ".local" / "data")
        )
    )
    application.state.images = ImagePipeline(application.state.store.root / "images")
    application.state.product_previews = PreviewCache()
    application.state.bootstrap_code = bootstrap_key(application.state.store)
    launch_nonce = os.environ.get("YIJIAN_LAUNCH_NONCE")
    launch_instance = hashlib.sha256(launch_nonce.encode()).hexdigest() if launch_nonce else None
    application.add_middleware(
        TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]", "testserver"]
    )

    @application.middleware("http")
    async def request_controls(request, call_next):
        length = request.headers.get("content-length")
        if length:
            try:
                if int(length) > 96 * 1024 * 1024:
                    return JSONResponse({"detail": "文件总量过大，请分批上传。"}, status_code=413)
            except ValueError:
                return JSONResponse({"detail": "请求格式无效。"}, status_code=400)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        )
        if request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @application.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return JSONResponse(
            {
                "detail": "提交的内容有误，请检查填写项。",
                "fields": [
                    ".".join(str(part) for part in error["loc"] if part != "body") for error in exc.errors()
                ],
            },
            status_code=422,
        )

    @application.get("/api/health")
    def health(response: Response):
        if launch_instance is not None:
            response.headers["X-Yijian-Instance"] = launch_instance
        return {"ok": True, "version": "0.2.0"}

    @application.post("/api/session")
    def session(request: Request, response: Response, body: SessionInput = SessionInput()):
        token = create_browser_session(request, body.code.get_secret_value() if body.code else None)
        response.set_cookie(
            COOKIE,
            token,
            httponly=True,
            samesite="strict",
            secure=request.url.scheme == "https",
            max_age=86400 * 30,
        )
        return {"ok": True}

    authorized = [Depends(require_access)]

    @application.get("/api/state", dependencies=authorized)
    def snapshot():
        state = application.state.store.read()
        result = public_data(state)
        result["items"] = [item_view(item, state) for item in state["items"]]
        result["insights"] = insights(state)
        result["features"] = application.state.images.features()
        result["ai"] = ai.public_settings(application.state.store)
        return result

    @application.patch("/api/settings", dependencies=authorized)
    def settings(body: SettingsPatch):
        changes = body.model_dump(exclude_unset=True, mode="json")

        def save(state):
            preferences = changes.pop("preferences", None)
            if preferences is not None:
                existing_ids = {item["id"] for item in state["items"]}
                if any(value not in existing_ids for value in preferences.get("excluded_ids", [])):
                    raise HTTPException(422, "排除项包含不存在的衣物。")
                for pair in preferences.get("blocked_pairs", []):
                    if (
                        len(pair) != 2
                        or pair[0] == pair[1]
                        or any(value not in existing_ids for value in pair)
                    ):
                        raise HTTPException(422, "不搭组合需要两件不同且存在的衣物。")
                state["settings"]["preferences"].update(preferences)
            state["settings"].update(changes)
            return state["settings"]

        return application.state.store.update(save)

    @application.get("/api/images/{filename}", dependencies=authorized)
    def image_file(filename: str):
        try:
            image = application.state.images.resolve(filename)
        except ValueError:
            raise HTTPException(404, "图片不存在。") from None
        if not image.is_file():
            raise HTTPException(404, "图片不存在。")
        return FileResponse(image, media_type="image/jpeg")

    def create_item(body: dict, picture: dict | None = None, *, reference_price: dict | None = None):
        item = {
            **body,
            "id": identifier(),
            "created_at": timestamp(),
            "updated_at": timestamp(),
            "image_url": None,
            "original_url": None,
            "background_status": "skipped",
            "ai_status": "idle",
            "ai_error": None,
            "reference_price": reference_price,
        }
        if picture:
            item.update({key: picture.get(key) for key in ("image_url", "original_url", "background_status")})

        def save(state):
            if len(state["items"]) >= 2000:
                raise HTTPException(409, "当前衣橱已达到 2,000 件单品的容量。")
            state["items"].append(item)
            return item_view(item, state)

        return application.state.store.update(save)

    @application.post("/api/items", dependencies=authorized)
    def add_item(body: ItemInput):
        return create_item(body.model_dump(mode="json"))

    def discard_picture(picture: dict):
        for url in {picture.get("image_url"), picture.get("original_url")} - {None}:
            application.state.images.resolve(url.removeprefix("/api/images/")).unlink(missing_ok=True)

    async def import_photo(
        content: bytes,
        name: str,
        remove_background: bool,
        auto_analyze: bool,
        background_tasks: BackgroundTasks,
        *,
        access: str,
        notes: str = "",
        reference_price: dict | None = None,
    ):
        reference = (
            ReferencePrice.model_validate(reference_price).model_dump(mode="json")
            if reference_price is not None
            else None
        )
        if len(application.state.store.read()["items"]) >= 2000:
            raise HTTPException(409, "衣橱已达到 2,000 件容量，其余图片未导入。")
        if len(content) > 16 * 1024 * 1024:
            raise HTTPException(422, "一张超过 16 MB 的图片未导入。")
        preparation = asyncio.create_task(
            asyncio.to_thread(application.state.images.prepare, content, remove_background)
        )
        try:
            picture = await asyncio.shield(preparation)
        except asyncio.CancelledError:
            # The image worker cannot be cancelled; track it until its uncommitted files can be removed.
            while not preparation.done():
                try:
                    await asyncio.shield(preparation)
                except asyncio.CancelledError:
                    continue
                except (ValueError, OSError):
                    break
            if not preparation.cancelled() and preparation.exception() is None:
                discard_picture(preparation.result())
            raise
        except (ValueError, OSError):
            raise HTTPException(422, "一张图片无法读取，请使用常见的图片格式。") from None
        raw_name = name.strip()[:120] or "新衣物"
        try:
            item = create_item(
                ItemInput(name=raw_name, notes=notes).model_dump(mode="json"),
                picture,
                reference_price=reference,
            )
        except HTTPException:
            discard_picture(picture)
            raise
        warnings = []
        if picture.get("background_status") == "failed":
            warnings.append(f"{raw_name}的去背景未完成，已保留原图。")
        provider = ai._configuration(application.state.store.read())["provider"]
        if (
            auto_analyze
            and (access == "browser" or provider not in ai.HOSTS)
            and ai.capabilities(application.state.store).get("vision")
        ):
            try:
                ai.queue_analysis(
                    application.state.store,
                    application.state.images,
                    item["id"],
                    background_tasks,
                    access=access,
                )
                item["ai_status"] = "processing"
            except (ai.ModelConnectionError, HTTPException):
                warnings.append("AI 设置刚刚发生变化，图片已保存，可稍后重新识别。")
        return item, warnings

    application.state.import_photo = import_photo

    @application.post("/api/items/upload", dependencies=authorized)
    async def upload(
        background_tasks: BackgroundTasks,
        files: list[UploadFile] = File(...),
        remove_background: bool = Form(True),
        auto_analyze: bool = Form(True),
        access: str = Depends(require_access),
    ):
        if len(files) > 20:
            raise HTTPException(422, "每次最多上传 20 张图片。")
        items, warnings = [], []
        for photo in files:
            content = await photo.read(16 * 1024 * 1024 + 1)
            await photo.close()
            try:
                item, messages = await import_photo(
                    content,
                    Path(photo.filename or "新衣物").stem,
                    remove_background,
                    auto_analyze,
                    background_tasks,
                    access=access,
                )
            except HTTPException as error:
                if error.status_code not in {409, 422}:
                    raise
                warnings.append(error.detail)
                if error.status_code == 409:
                    break
                continue
            items.append(item)
            warnings.extend(messages)
        if not items:
            raise HTTPException(422, warnings[0] if warnings else "请选择图片。")
        return {"items": items, "warnings": warnings}

    @application.patch("/api/items/{item_id}", dependencies=authorized)
    def edit_item(item_id: str, body: ItemPatch):
        changes = body.model_dump(exclude_unset=True, mode="json")

        def save(state):
            item = find(state, "items", item_id)
            item.update(changes)
            item["updated_at"] = timestamp()
            if changes:
                item["ai_status"] = "idle" if item["confirmed"] else "review"
                item["ai_error"] = None
                item.pop("ai_job_id", None)
            return item_view(item, state)

        return application.state.store.update(save)

    @application.delete("/api/items/{item_id}", dependencies=authorized)
    def delete_item(item_id: str):
        def remove(state):
            item = find(state, "items", item_id)
            state["items"].remove(item)
            for collection in ("outfits", "plans"):
                for entity in state[collection]:
                    entity["item_ids"] = [value for value in entity["item_ids"] if value != item_id]
                    if collection == "outfits" and entity.get("layout"):
                        entity["layout"]["placements"] = [
                            entry for entry in entity["layout"]["placements"] if entry["item_id"] != item_id
                        ]
            for trip in state["trips"]:
                trip["entries"] = [entry for entry in trip["entries"] if entry["item_id"] != item_id]
            preferences = state["settings"]["preferences"]
            preferences["excluded_ids"] = [value for value in preferences["excluded_ids"] if value != item_id]
            preferences["blocked_pairs"] = [
                pair for pair in preferences["blocked_pairs"] if item_id not in pair
            ]
            return {"ok": True}

        return application.state.store.update(remove)

    @application.post("/api/items/{item_id}/wash", dependencies=authorized)
    def wash_item(item_id: str):
        def save(state):
            item = find(state, "items", item_id)
            if item["status"] == "archived":
                raise HTTPException(409, "请先将衣物移出归档。")
            item["status"] = "available"
            item["updated_at"] = timestamp()
            state.setdefault("care_events", []).append(
                {
                    "id": identifier(),
                    "item_id": item_id,
                    "item_name": item["name"],
                    "date": date.today().isoformat(),
                    "created_at": timestamp(),
                    "action": "wash",
                }
            )
            return item_view(item, state)

        return application.state.store.update(save)

    async def transform_item(item_id: str, restore: bool):
        item = find(application.state.store.read(), "items", item_id)
        original_url = item.get("original_url") or item.get("image_url")
        if not original_url:
            raise HTTPException(422, "该衣物还没有照片。")
        updated = item["updated_at"]
        operation = application.state.images.restore if restore else application.state.images.cutout
        result = await asyncio.to_thread(operation, original_url)

        def save(state):
            current = find(state, "items", item_id)
            if current["updated_at"] != updated:
                raise HTTPException(409, "衣物刚刚发生变化，请重试图片操作。")
            current.update(
                {
                    key: value
                    for key, value in result.items()
                    if key in {"image_url", "original_url", "background_status"}
                }
            )
            current["updated_at"] = timestamp()
            return item_view(current, state)

        return application.state.store.update(save)

    @application.post("/api/items/{item_id}/background", dependencies=authorized)
    async def background(item_id: str):
        return await transform_item(item_id, False)

    @application.post("/api/items/{item_id}/restore", dependencies=authorized)
    async def restore_photo(item_id: str):
        return await transform_item(item_id, True)

    @application.post("/api/recommendations", dependencies=authorized)
    def recommendations(body: RecommendationInput):
        return recommend(application.state.store.read(), body.model_dump())

    @application.post("/api/outfits", dependencies=authorized)
    def add_outfit(body: OutfitInput, access: str = Depends(require_access)):
        def save(state):
            constrained = access == "assistant" or body.source in {"assistant", "ai", "rules"}
            validate_outfit(
                state, body.item_ids, request={} if constrained else None, require_complete=constrained
            )
            entity = {**body.model_dump(), "id": identifier(), "created_at": timestamp()}
            state["outfits"].append(entity)
            return entity

        return application.state.store.update(save)

    @application.patch("/api/outfits/{outfit_id}", dependencies=authorized)
    def edit_outfit(outfit_id: str, body: dict, access: str = Depends(require_access)):
        def save(state):
            entity = find(state, "outfits", outfit_id)
            merged = {key: value for key, value in entity.items() if key not in {"id", "created_at"}}
            merged.update(body)
            try:
                if (
                    "item_ids" in body
                    and "layout" not in body
                    and set(body["item_ids"]) != set(entity["item_ids"])
                ):
                    merged["layout"] = None
                value = OutfitInput.model_validate(merged)
            except (ValueError, TypeError):
                raise HTTPException(422, "请检查穿搭名称、衣物与画布布局。") from None
            constrained = access == "assistant" or value.source in {"assistant", "ai", "rules"}
            validate_outfit(
                state, value.item_ids, request={} if constrained else None, require_complete=constrained
            )
            entity.update(value.model_dump())
            return entity

        return application.state.store.update(save)

    @application.delete("/api/outfits/{outfit_id}", dependencies=authorized)
    def delete_outfit(outfit_id: str):
        def save(state):
            entity = find(state, "outfits", outfit_id)
            state["outfits"].remove(entity)
            for plan in state["plans"]:
                if plan.get("outfit_id") == outfit_id:
                    plan["outfit_id"] = None
            return {"ok": True}

        return application.state.store.update(save)

    @application.post("/api/wear", dependencies=authorized)
    def wear(body: WearInput):
        if body.date > date.today():
            raise HTTPException(422, "实际穿着日期不能晚于今天，请使用日历安排未来穿搭。")
        value = body.model_dump(mode="json")

        def save(state):
            existing = next(
                (event for event in state["wear_events"] if event["request_id"] == body.request_id), None
            )
            if existing:
                if any(existing[key] != value[key] for key in value):
                    raise HTTPException(409, "这次记录已提交，请刷新后再次操作。")
                return existing
            items = validate_outfit(state, body.item_ids, require_complete=False)
            if any(item["status"] != "available" or not item["confirmed"] for item in items):
                raise HTTPException(409, "请先确认衣物，并检查可用状态。")
            event = {
                **value,
                "id": identifier(),
                "item_names": {item["id"]: item["name"] for item in items},
                "created_at": timestamp(),
            }
            state["wear_events"].append(event)
            return event

        return application.state.store.update(save)

    @application.delete("/api/wear/{event_id}", dependencies=authorized)
    def undo_wear(event_id: str):
        def save(state):
            state["wear_events"].remove(find(state, "wear_events", event_id))
            return {"ok": True}

        return application.state.store.update(save)

    def validate_plan(state, value):
        if value.get("outfit_id"):
            outfit = find(state, "outfits", value["outfit_id"])
            if not value["item_ids"]:
                value["item_ids"] = list(outfit["item_ids"])
        validate_outfit(state, value["item_ids"], require_complete=False)

    @application.post("/api/plans", dependencies=authorized)
    def add_plan(body: PlanInput):
        def save(state):
            value = body.model_dump(mode="json")
            validate_plan(state, value)
            entity = {**value, "id": identifier()}
            state["plans"].append(entity)
            return entity

        return application.state.store.update(save)

    @application.patch("/api/plans/{plan_id}", dependencies=authorized)
    def edit_plan(plan_id: str, body: dict):
        def save(state):
            entity = find(state, "plans", plan_id)
            try:
                value = PlanInput.model_validate(
                    {**{key: value for key, value in entity.items() if key != "id"}, **body}
                ).model_dump(mode="json")
            except ValueError:
                raise HTTPException(422, "请检查计划日期与衣物。") from None
            validate_plan(state, value)
            entity.update(value)
            return entity

        return application.state.store.update(save)

    @application.delete("/api/plans/{plan_id}", dependencies=authorized)
    def delete_plan(plan_id: str):
        def save(state):
            state["plans"].remove(find(state, "plans", plan_id))
            return {"ok": True}

        return application.state.store.update(save)

    def validate_trip(state, value):
        if value["end_date"] < value["start_date"]:
            raise HTTPException(422, "结束日期不能早于开始日期。")
        ids = [entry["item_id"] for entry in value["entries"]]
        existing = {item["id"] for item in state["items"]}
        if len(set(ids)) != len(ids) or any(item_id not in existing for item_id in ids):
            raise HTTPException(422, "清单必须使用不同且存在的衣物。")

    @application.post("/api/trips", dependencies=authorized)
    def add_trip(body: TripInput):
        def save(state):
            value = body.model_dump(mode="json")
            validate_trip(state, value)
            entity = {**value, "id": identifier(), "created_at": timestamp()}
            state["trips"].append(entity)
            return entity

        return application.state.store.update(save)

    @application.patch("/api/trips/{trip_id}", dependencies=authorized)
    def edit_trip(trip_id: str, body: dict):
        def save(state):
            entity = find(state, "trips", trip_id)
            try:
                value = TripInput.model_validate(
                    {
                        **{key: value for key, value in entity.items() if key not in {"id", "created_at"}},
                        **body,
                    }
                ).model_dump(mode="json")
            except ValueError:
                raise HTTPException(422, "请检查行程日期与清单内容。") from None
            validate_trip(state, value)
            entity.update(value)
            return entity

        return application.state.store.update(save)

    @application.delete("/api/trips/{trip_id}", dependencies=authorized)
    def delete_trip(trip_id: str):
        def save(state):
            state["trips"].remove(find(state, "trips", trip_id))
            return {"ok": True}

        return application.state.store.update(save)

    application.include_router(ai.router)
    application.include_router(assistant_setup_router)
    application.include_router(backup_router)
    application.include_router(product_import_router)
    build_dir = Path(__file__).resolve().parents[1] / "web" / "dist"

    @application.get("/{path:path}")
    def web(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404, "接口不存在。")
        target = (build_dir / path).resolve()
        if not target.is_relative_to(build_dir.resolve()):
            raise HTTPException(404, "页面不存在。")
        if target.is_file():
            return FileResponse(target)
        if (build_dir / "index.html").exists():
            return FileResponse(build_dir / "index.html")
        return JSONResponse({"detail": "请先构建网页，或启动前端开发服务。"}, status_code=503)

    return application
