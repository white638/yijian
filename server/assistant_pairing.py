from __future__ import annotations

import re
import secrets
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from .auth import check_origin, current_assistant_session, digest, require_access

CLIENT_NAMES = {"codex": "Codex", "claude-code": "Claude Code"}
PAIRING_SECONDS = 300
SESSION_SECONDS = 3600
POLL_INTERVAL = 2
MAX_REQUESTS = 5


class DeviceStart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client: Literal["codex", "claude-code"]


class DevicePoll(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_code: SecretStr = Field(min_length=43, max_length=43)


class PairingRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_handler(request):
            try:
                return await handler(request)
            except RequestValidationError:
                raise HTTPException(422, "配对请求格式有误，请重新发起。") from None

        return private_handler


router = APIRouter(route_class=PairingRoute)


def _provider(state: dict) -> str:
    return state.get("ai", {}).get("configuration", {}).get("provider", "none")


def _browser(access: str, request: Request) -> None:
    if access != "browser":
        raise HTTPException(403, "请在衣间页面批准或拒绝助手连接。")
    check_origin(request)


def _charge(store, name: str, maximum: int) -> None:
    def charge(state):
        now = time.time()
        limits = state.setdefault("ai", {}).setdefault("limits", {})
        key = "device_" + name
        previous = [stamp for stamp in limits.get(key, []) if stamp > now - 60]
        if len(previous) >= maximum:
            raise HTTPException(429, "配对操作较频繁，请稍后重试。", headers={"Retry-After": "2"})
        limits[key] = [*previous, now]

    store.update(charge)


def _active_requests(state: dict, now: float) -> list[dict]:
    provider = _provider(state)
    return [
        entry
        for entry in state.get("device_pairings", [])
        if entry.get("expires_at", 0) > now and entry.get("provider") == provider
    ]


def create_assistant_session(
    state: dict, token: str, provider: str, now: float, request_id: str | None = None
) -> dict:
    session = {
        "token_hash": digest(token),
        "expires_at": now + SESSION_SECONDS,
        "scope": "assistant",
        "provider": provider,
        "client_name": CLIENT_NAMES[provider],
        "verified_at": None,
    }
    if request_id:
        session["request_id"] = request_id
    sessions = [entry for entry in state.get("assistant_sessions", []) if entry.get("expires_at", 0) > now]
    state["assistant_sessions"] = [*sessions[-9:], session]
    return session


def connection_status(state: dict) -> dict:
    now = time.time()
    provider = _provider(state)
    if provider not in CLIENT_NAMES:
        return {"status": "disconnected"}
    sessions = [
        session
        for session in state.get("assistant_sessions", [])
        if session.get("expires_at", 0) > now and session.get("provider", provider) == provider
    ]
    verified = [session for session in sessions if 0 < (session.get("verified_at") or 0) <= now]
    if verified:
        latest = max(verified, key=lambda session: session["verified_at"])
        return {
            "status": "connected",
            "client_name": CLIENT_NAMES[provider],
            "expires_at": latest["expires_at"],
            "verified_at": latest["verified_at"],
            **({"request_id": latest["request_id"]} if latest.get("request_id") else {}),
        }
    waiting = [*sessions, *_active_requests(state, now)]
    if waiting:
        return {
            "status": "pending",
            "client_name": CLIENT_NAMES[provider],
            "expires_at": max(entry["expires_at"] for entry in waiting),
        }
    return {"status": "disconnected"}


@router.post("/connection/verify")
def verify_connection(request: Request, access: str = Depends(require_access)):
    if access != "assistant":
        raise HTTPException(403, "请由助手客户端验证自己的连接。")

    def verify(state):
        session = current_assistant_session(state, request)
        if not session.get("verified_at"):
            session["verified_at"] = time.time()
        session["provider"] = _provider(state)
        session["client_name"] = CLIENT_NAMES[session["provider"]]
        return {
            "connected": True,
            "client_name": session["client_name"],
            "expires_at": session["expires_at"],
            "verified_at": session["verified_at"],
            **({"request_id": session["request_id"]} if session.get("request_id") else {}),
        }

    return request.app.state.store.update(verify)


@router.delete("/connection")
def revoke_connection(request: Request, access: str = Depends(require_access)):
    if access != "assistant":
        raise HTTPException(403, "请由助手客户端撤销自己的连接。")

    def revoke(state):
        current = current_assistant_session(state, request)
        state["assistant_sessions"] = [
            session for session in state["assistant_sessions"] if session is not current
        ]

    request.app.state.store.update(revoke)
    return {"ok": True}


@router.post("/device/start")
def start_device(data: DeviceStart, request: Request):
    check_origin(request)
    store = request.app.state.store
    _charge(store, "start", 10)
    device_code = secrets.token_urlsafe(32)

    def start(state):
        now = time.time()
        if _provider(state) != data.client:
            raise HTTPException(409, "请先在衣间中选择对应的助手模式并保存。")
        entries = _active_requests(state, now)
        if len(entries) >= MAX_REQUESTS:
            raise HTTPException(429, "待处理连接较多，请先批准或拒绝已有请求。")
        existing_codes = {entry["user_code"] for entry in entries}
        while True:
            letters = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
            user_code = letters[:4] + "-" + letters[4:]
            if user_code not in existing_codes:
                break
        entries.append(
            {
                "id": secrets.token_hex(16),
                "device_hash": digest(device_code),
                "user_code": user_code,
                "provider": data.client,
                "created_at": now,
                "expires_at": now + PAIRING_SECONDS,
                "status": "pending",
                "last_poll_at": 0,
            }
        )
        state["device_pairings"] = entries
        return user_code

    user_code = store.update(start)
    return {
        "device_code": device_code,
        "user_code": user_code,
        "expires_in": PAIRING_SECONDS,
        "interval": POLL_INTERVAL,
        "verification_uri": str(request.base_url).rstrip("/") + "/#settings",
    }


@router.get("/device/requests")
def list_devices(request: Request, access: str = Depends(require_access)):
    _browser(access, request)
    entries = _active_requests(request.app.state.store.read(), time.time())
    return {
        "requests": [
            {
                **{key: entry[key] for key in ("id", "user_code", "expires_at", "status")},
                "client_name": CLIENT_NAMES[entry["provider"]],
            }
            for entry in entries
        ]
    }


@router.post("/device/{request_id}/approve")
def approve_device(request_id: str, request: Request, access: str = Depends(require_access)):
    _browser(access, request)
    store = request.app.state.store
    _charge(store, "approve", 20)

    def approve(state):
        entries = _active_requests(state, time.time())
        entry = next((entry for entry in entries if entry["id"] == request_id), None)
        if entry is None:
            raise HTTPException(404, "这条连接请求已失效，请重新发起。")
        entry["status"] = "approved"
        state["device_pairings"] = entries

    store.update(approve)
    return {"approved": True}


@router.delete("/device/{request_id}")
def reject_device(request_id: str, request: Request, access: str = Depends(require_access)):
    _browser(access, request)

    def reject(state):
        entries = _active_requests(state, time.time())
        if not any(entry["id"] == request_id for entry in entries):
            raise HTTPException(404, "这条连接请求已失效，请重新发起。")
        state["device_pairings"] = [entry for entry in entries if entry["id"] != request_id]

    request.app.state.store.update(reject)
    return {"ok": True}


@router.post("/device/poll")
def poll_device(data: DevicePoll, request: Request):
    check_origin(request)
    store = request.app.state.store
    _charge(store, "poll", 240)
    raw = data.device_code.get_secret_value()
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", raw):
        raise HTTPException(401, "连接请求已过期、被拒绝或已使用，请重新发起。")
    wanted = digest(raw)

    def poll(state):
        now = time.time()
        entries = _active_requests(state, now)
        entry = next(
            (entry for entry in entries if secrets.compare_digest(entry["device_hash"], wanted)), None
        )
        if entry is None:
            raise HTTPException(401, "连接请求已过期、被拒绝或已使用，请重新发起。")
        if now - entry["last_poll_at"] < POLL_INTERVAL:
            raise HTTPException(429, "请稍候再查询连接状态。", headers={"Retry-After": str(POLL_INTERVAL)})
        if entry["status"] != "approved":
            entry["last_poll_at"] = now
            state["device_pairings"] = entries
            return {"status": "pending"}
        token = secrets.token_urlsafe(32)
        create_assistant_session(state, token, entry["provider"], now, request_id=entry["id"])
        state["device_pairings"] = [other for other in entries if other is not entry]
        return {"status": "approved", "access_token": token, "expires_in": SESSION_SECONDS}

    return store.update(poll)
