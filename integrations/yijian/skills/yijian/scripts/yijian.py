"""衣间助手：通过短期授权读取衣橱照片、提交识别结果和保存搭配。"""

import argparse
import base64
import ctypes
import getpass
import hashlib
import ipaddress
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID, uuid4

DEFAULT_SERVER = "http://127.0.0.1:3110/api"
MAX_RESPONSE = 32 * 1024 * 1024
TAG_FIELDS = {"category", "name", "colors", "seasons", "occasions", "tags"}
OUTFIT_FIELDS = {"item_ids", "name", "notes"}
CATEGORIES = {"top", "bottom", "dress", "outerwear", "shoes", "bag", "accessory", "other"}


class BridgeError(Exception):
    pass


def normalize_server(value):
    parts = urlsplit(value)
    if (
        parts.username
        or parts.password
        or parts.query
        or parts.fragment
        or not parts.hostname
    ):
        raise BridgeError("服务地址不能包含凭据、查询参数或片段。")
    try:
        loopback = (
            parts.hostname.lower() == "localhost"
            or ipaddress.ip_address(parts.hostname).is_loopback
        )
    except ValueError:
        loopback = parts.hostname.lower() == "localhost"
    if parts.scheme != "https" and not (parts.scheme == "http" and loopback):
        raise BridgeError("远程服务必须使用 HTTPS；HTTP 仅支持本机地址。")
    if parts.path.rstrip("/") not in ("", "/api"):
        raise BridgeError("服务地址必须指向站点根目录或 /api。")
    try:
        _port = parts.port
    except ValueError as error:
        raise BridgeError("服务端口无效。") from error
    return f"{parts.scheme}://{parts.netloc}/api"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(server, path, *, token=None, method="GET", payload=None, binary=False):
    url = server + path
    if not path.startswith("/") or path.startswith("//"):
        raise BridgeError("请求路径无效。")
    headers = {"Accept": "image/*" if binary else "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open(
            Request(url, data=body, headers=headers, method=method), timeout=45
        ) as response:
            content = response.read(MAX_RESPONSE + 1)
            if len(content) > MAX_RESPONSE:
                raise BridgeError("服务响应超过大小限制。")
            if binary:
                if response.headers.get_content_type() not in (
                    "image/jpeg",
                    "image/png",
                    "image/webp",
                ):
                    raise BridgeError("服务没有返回可用图片。")
                return content
            return json.loads(content)
    except HTTPError as error:
        error.close()
        if error.code in (301, 302, 303, 307, 308):
            raise BridgeError(
                "服务返回重定向，已停止请求。请使用最终服务地址重新连接。"
            ) from None
        if error.code in (401, 403):
            raise BridgeError(
                "连接已过期或没有权限，请在衣间中生成新的连接码。"
            ) from None
        raise BridgeError(f"衣橱请求失败（HTTP {error.code}）。") from None
    except (URLError, TimeoutError, json.JSONDecodeError):
        raise BridgeError("无法读取衣橱服务响应。请检查地址及运行状态。") from None


def default_cache():
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local")))
    else:
        base = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
    return base / "Yijian/assistant"


def credential_path(cache, server):
    return cache / (hashlib.sha256(server.encode()).hexdigest()[:24] + ".json")


def windows_protect(data, decrypt=False):
    class Blob(ctypes.Structure):
        _fields_ = [("size", ctypes.c_ulong), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    if decrypt:
        ok = ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)
        )
    else:
        ok = ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)
        )
    if not ok:
        raise BridgeError("无法使用当前系统账户保护连接凭据。")
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        ctypes.windll.kernel32.LocalFree(result.data)


def store_credentials(cache, server, response):
    token = response.get("access_token")
    lifetime = response.get("expires_in")
    if (
        not isinstance(token, str)
        or not token
        or not isinstance(lifetime, (int, float))
        or isinstance(lifetime, bool)
        or not math.isfinite(lifetime)
        or lifetime <= 0
        or lifetime > 3600
    ):
        raise BridgeError("连接响应不完整，凭据未保存。")
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    (cache / ".gitignore").write_text("*\n", encoding="utf-8")
    protected = os.name == "nt"
    saved_token = (
        base64.b64encode(windows_protect(token.encode())).decode()
        if protected
        else token
    )
    content = {
        "server": server,
        "token": saved_token,
        "protected": protected,
        "expires_at": time.time() + lifetime,
        "user_id": response.get("user_id"),
    }
    path = credential_path(cache, server)
    temporary = path.with_name(f".{uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(content, handle)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_token(cache, server):
    path = credential_path(cache, server)
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
        if saved["server"] != server or saved["expires_at"] <= time.time():
            raise BridgeError("连接已过期，请在衣间中生成新的连接码。")
        token = saved["token"]
        if saved.get("protected"):
            if os.name != "nt":
                raise BridgeError("该连接凭据属于原 Windows 账户，请重新连接。")
            token = windows_protect(base64.b64decode(token), decrypt=True).decode()
        if not isinstance(token, str) or not token:
            raise ValueError("empty token")
        return token
    except (OSError, ValueError, KeyError):
        raise BridgeError(
            "尚未连接衣橱。请运行 connect，并输入衣间提供的连接码。"
        ) from None


def item_id(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise BridgeError("衣物编号必须是衣橱返回的 UUID。") from None


def list_items(server, token, pending=False):
    items = request(server, "/state", token=token)["items"]
    return [item for item in items if item["status"] != "archived"
            and (not pending or not item["confirmed"])]


def get_item(server, token, identifier):
    identifier = item_id(identifier)
    items = request(server, "/state", token=token)["items"]
    for item in items:
        if item["id"] == identifier:
            return item
    raise BridgeError("已连接的衣橱中没有这件衣物。")


def download_item(server, token, identifier, target):
    item = get_item(server, token, identifier)
    image_url = item.get("image_url")
    if not isinstance(image_url, str):
        raise BridgeError("衣物没有可读取的照片。")
    resolved = urlsplit(urljoin(server + "/", image_url))
    origin = urlsplit(server)
    if (
        (resolved.scheme, resolved.netloc) != (origin.scheme, origin.netloc)
        or not re.fullmatch(r"/api/images/[a-f0-9]{32}-(?:original|cutout)\.jpg", resolved.path)
        or resolved.query
        or resolved.fragment
    ):
        raise BridgeError("衣物图片不在已连接的衣橱服务中。")
    path = resolved.path.removeprefix("/api")
    data = request(server, path, token=token, binary=True)
    target = target.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as handle:
        handle.write(data)
    return {"item_id": item["id"], "path": str(target)}


def read_payload(path, allowed):
    if path.stat().st_size > 64 * 1024:
        raise BridgeError("提交内容超过大小限制。")
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict) or not payload or set(payload) - allowed:
        raise BridgeError("提交内容包含不支持的字段。请按 skill 中的格式填写。")
    return payload


def tag_item(server, token, identifier, payload, confirmed=False):
    identifier = item_id(identifier)
    if not isinstance(payload.get("category"), str) or payload["category"] not in CATEGORIES:
        raise BridgeError("识别结果必须包含有效的衣物类别。")
    current = get_item(server, token, identifier)
    if current["ai_status"] == "processing":
        raise BridgeError("衣物仍在处理中，请稍后再写入标签。")
    payload = {**payload, "confirmed": confirmed}
    return request(
        server, "/items/" + identifier, token=token, method="PATCH", payload=payload
    )


def save_outfit(server, token, payload):
    identifiers = payload.get("item_ids")
    if not isinstance(identifiers, list) or not 1 <= len(identifiers) <= 20:
        raise BridgeError("搭配必须包含 1 至 20 件衣橱中的衣物。")
    ids = list(dict.fromkeys(item_id(value) for value in identifiers))
    available = {item["id"] for item in list_items(server, token)
                 if item["status"] == "available" and item["confirmed"]
                 and item["ai_status"] != "processing"}
    if any(identifier not in available for identifier in ids):
        raise BridgeError("搭配中有不存在、待确认、待洗或已归档的衣物，请重新选择。")
    payload = {**payload, "item_ids": ids, "source": "assistant"}
    return request(
        server, "/outfits", token=token, method="POST", payload=payload
    )


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--cache-dir", type=Path, default=default_cache())
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("connect")
    commands.add_parser("disconnect")
    commands.add_parser("status")
    listing = commands.add_parser("list")
    listing.add_argument("--pending", action="store_true")
    download = commands.add_parser("download")
    download.add_argument("item_id")
    download.add_argument("--output", required=True, type=Path)
    tag = commands.add_parser("tag")
    tag.add_argument("item_id")
    tag.add_argument("--file", required=True, type=Path)
    tag.add_argument("--confirm", action="store_true", help="仅在用户明确认可识别结果后确认衣物")
    outfit = commands.add_parser("save-outfit")
    outfit.add_argument("--file", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        server = normalize_server(args.server)
        if args.command == "disconnect":
            token = load_token(args.cache_dir, server)
            request(server, "/ai/disconnect", token=token, method="POST", payload={})
            credential_path(args.cache_dir, server).unlink(missing_ok=True)
            output = {"connected": False}
        elif args.command == "connect":
            code = (
                getpass.getpass("衣间连接码：")
                if sys.stdin.isatty()
                else sys.stdin.readline().strip()
            )
            if not code or len(code) > 512:
                raise BridgeError("连接码无效。")
            response = request(
                server, "/ai/connect", method="POST", payload={"code": code}
            )
            store_credentials(args.cache_dir, server, response)
            output = {"connected": True, "expires_in": response["expires_in"]}
        else:
            token = load_token(args.cache_dir, server)
            if args.command == "status":
                output = request(server, "/ai/settings", token=token)
            elif args.command == "list":
                items = list_items(server, token, args.pending)
                output = {"items": items, "total": len(items)}
            elif args.command == "download":
                output = download_item(server, token, args.item_id, args.output)
            elif args.command == "tag":
                output = tag_item(
                    server, token, args.item_id, read_payload(args.file, TAG_FIELDS), args.confirm
                )
            else:
                output = save_outfit(
                    server, token, read_payload(args.file, OUTFIT_FIELDS)
                )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    except (BridgeError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
