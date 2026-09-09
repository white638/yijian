from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import time
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

COOKIE = "wardrobe_session"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def bootstrap_key(store) -> str:
    path = store.root / ".browser-key"
    if not path.exists():
        temporary = store.root / (".browser-key-" + secrets.token_hex(12) + ".tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="ascii") as file:
                file.write(secrets.token_urlsafe(32))
                file.flush()
                os.fsync(file.fileno())
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        finally:
            temporary.unlink(missing_ok=True)
    try:
        value = path.read_text(encoding="ascii")
        if re.fullmatch(r"[A-Za-z0-9_-]{43}", value) is None:
            raise ValueError
        os.chmod(path, 0o600)
    except (OSError, UnicodeError, ValueError):
        raise RuntimeError("本机启动密钥文件无法读取，请检查工作目录。") from None
    return value


def check_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin:
        try:
            parsed = urlsplit(origin)
        except ValueError:
            raise HTTPException(403, "请从衣间页面发起操作。") from None
        if parsed.netloc != request.headers.get("host") or parsed.scheme != request.url.scheme:
            raise HTTPException(403, "请从衣间页面发起操作。")
    elif request.headers.get("sec-fetch-site") in {"cross-site", "same-site"}:
        raise HTTPException(403, "请从衣间页面发起操作。")


def require_access(request: Request) -> str:
    authorization = request.headers.get("authorization", "")
    bearer = authorization.startswith("Bearer ")
    token = authorization[7:] if bearer else request.cookies.get(COOKIE, "")
    if not token or len(token) > 512:
        raise HTTPException(401, "请重新打开衣间，或重新连接助手。")
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        check_origin(request)
    state = request.app.state.store.read()
    sessions = state.get("assistant_sessions" if bearer else "browser_sessions", [])
    wanted = digest(token)
    for session in sessions:
        if session.get("expires_at", 0) > time.time() and hmac.compare_digest(
            session.get("token_hash", ""), wanted
        ):
            return "assistant" if bearer else "browser"
    raise HTTPException(401, "连接已过期，请重新连接。")


def create_browser_session(request: Request, code: str | None = None) -> str:
    check_origin(request)
    store = request.app.state.store
    cookie = request.cookies.get(COOKIE, "")
    cookie_hash = digest(cookie) if cookie and len(cookie) <= 512 else None
    valid_code = (
        isinstance(code, str)
        and len(code) <= 512
        and code.isascii()
        and hmac.compare_digest(digest(code), digest(bootstrap_key(store)))
    )
    token = secrets.token_urlsafe(32)
    now = time.time()

    def save(state):
        valid_cookie = cookie_hash is not None and any(
            session.get("expires_at", 0) > now
            and hmac.compare_digest(session.get("token_hash", ""), cookie_hash)
            for session in state.get("browser_sessions", [])
        )
        if not valid_code and not valid_cookie:
            raise HTTPException(401, "请通过本机启动程序打开衣间，或使用完整的启动链接。")
        current = [s for s in state.get("browser_sessions", []) if s["expires_at"] > now][-19:]
        current.append({"token_hash": digest(token), "expires_at": now + 86400 * 30})
        state["browser_sessions"] = current

    store.update(save)
    return token
