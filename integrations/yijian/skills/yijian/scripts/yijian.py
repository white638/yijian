"""衣间助手：通过短期授权读取衣橱照片、提交识别和图片美化结果、保存搭配。"""

import argparse
import base64
import ctypes
from contextlib import contextmanager
import getpass
import hashlib
import ipaddress
import json
import math
import os
import re
import secrets
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID, uuid4

DEFAULT_SERVER = "http://127.0.0.1:3110/api"
MAX_RESPONSE = 32 * 1024 * 1024
MAX_IMAGE_UPLOAD = 20 * 1024 * 1024
TAG_FIELDS = {
    "category",
    "name",
    "colors",
    "seasons",
    "occasions",
    "tags",
    "brand",
    "subcategory",
    "materials",
    "materials_evidence",
    "pattern",
    "styles",
    "fit",
    "cut",
    "neckline",
    "sleeve_length",
    "length",
}
OUTFIT_FIELDS = {"item_ids", "name", "notes"}
CATEGORIES = {"top", "bottom", "dress", "outerwear", "shoes", "bag", "accessory", "other"}


class BridgeError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def normalize_server(value):
    parts = urlsplit(value)
    if parts.username or parts.password or parts.query or parts.fragment or not parts.hostname:
        raise BridgeError("服务地址不能包含凭据、查询参数或片段。")
    try:
        loopback = parts.hostname.lower() == "localhost" or ipaddress.ip_address(parts.hostname).is_loopback
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


def image_multipart(path):
    with path.open("rb") as handle:
        content = handle.read(MAX_IMAGE_UPLOAD + 1)
    if len(content) > MAX_IMAGE_UPLOAD:
        raise BridgeError("美化图片不能超过 20 MiB。")
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        extension, content_type = "png", "image/png"
    elif content.startswith(b"\xff\xd8\xff"):
        extension, content_type = "jpg", "image/jpeg"
    elif content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        extension, content_type = "webp", "image/webp"
    else:
        raise BridgeError("请提交实际生成的 PNG、JPEG 或 WebP 图片文件。")
    boundary = "yijian-" + secrets.token_hex(24)
    while boundary.encode("ascii") in content:
        boundary = "yijian-" + secrets.token_hex(24)
    header = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="beautified.{extension}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("ascii")
    return header + content + f"\r\n--{boundary}--\r\n".encode("ascii"), boundary


def request(server, path, *, token=None, method="GET", payload=None, binary=False, file=None):
    url = server + path
    if not path.startswith("/") or path.startswith("//"):
        raise BridgeError("请求路径无效。")
    headers = {"Accept": "image/*" if binary else "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None
    if file is not None:
        if payload is not None or method != "POST":
            raise BridgeError("图片提交请求格式无效。")
        body, boundary = image_multipart(file)
        headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
    elif payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open(Request(url, data=body, headers=headers, method=method), timeout=45) as response:
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
            raise BridgeError("服务返回重定向，已停止请求。请使用最终服务地址重新连接。") from None
        if error.code in (401, 403):
            raise BridgeError("连接无效、已过期或没有权限，请重新发起配对。", error.code) from None
        if error.code == 409:
            if path.startswith("/beautify/"):
                raise BridgeError("图片美化任务状态或连接已变化，请回到衣间检查任务。", 409) from None
            raise BridgeError("衣间当前状态不支持此操作，请先在设置中保存对应的助手方式。", 409) from None
        raise BridgeError(f"衣橱请求失败（HTTP {error.code}）。", error.code) from None
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
        raise BridgeError(
            "无法在当前系统账户中读取或保护授权。请使用与连接时相同的 Windows 用户执行衣间工具；Codex 的沙箱与宿主用户不能混用。"
        )
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
    saved_token = base64.b64encode(windows_protect(token.encode())).decode() if protected else token
    content = {
        "server": server,
        "token": saved_token,
        "protected": protected,
        "expires_at": time.time() + lifetime,
        "user_id": response.get("user_id"),
    }
    path = credential_path(cache, server)
    temporary = path.with_name(f".{uuid4().hex}.tmp")
    serialized = json.dumps(content).encode("utf-8")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(serialized)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return serialized


def load_token(cache, server):
    path = credential_path(cache, server)
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
        if saved["server"] != server or saved["expires_at"] <= time.time():
            raise BridgeError("连接已过期，请重新运行 connect，并在衣间中确认配对。")
        token = saved["token"]
        if saved.get("protected"):
            if os.name != "nt":
                raise BridgeError("该连接凭据属于原 Windows 账户，请重新连接。")
            token = windows_protect(base64.b64decode(token), decrypt=True).decode()
        if not isinstance(token, str) or not token:
            raise ValueError("empty token")
        return token
    except (OSError, ValueError, KeyError):
        raise BridgeError("尚未连接衣橱。请运行 connect，再在衣间设置中确认配对。") from None


def preflight_credentials(cache):
    probe = cache / f".write-check-{uuid4().hex}"
    try:
        cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        sample = secrets.token_bytes(32)
        protected = windows_protect(sample) if os.name == "nt" else sample
        descriptor = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(protected)
        restored = probe.read_bytes()
        if os.name == "nt":
            restored = windows_protect(restored, decrypt=True)
        if not secrets.compare_digest(sample, restored):
            raise BridgeError("授权保存自检失败，请检查当前系统账户。")
    except OSError:
        raise BridgeError(
            "当前运行环境无法保存衣间授权。请使用同一 Windows 用户的宿主执行环境运行助手，或选择仅自己可访问的缓存目录。"
        ) from None
    finally:
        probe.unlink(missing_ok=True)


def verify_connection(server, token):
    state = request(server, "/state", token=token)
    if not isinstance(state, dict) or not isinstance(state.get("items"), list):
        raise BridgeError("衣柜读取验证未通过，连接尚未完成。")
    verified = request(server, "/ai/connection/verify", token=token, method="POST", payload={})
    if not isinstance(verified, dict) or verified.get("connected") is not True:
        raise BridgeError("助手授权验证未通过，连接尚未完成。")
    return {**verified, "wardrobe_items": len(state["items"])}


@contextmanager
def credential_lock(cache, server):
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = credential_path(cache, server).with_suffix(".lock")
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "r+b") as handle:
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise BridgeError("另一条连接正在保存授权，请稍后重试。") from None
        try:
            yield
        finally:
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def complete_connection(cache, server, response):
    if not isinstance(response, dict):
        raise BridgeError("连接响应格式无效。")
    acquired = False
    try:
        with credential_lock(cache, server):
            acquired = True
            return _complete_connection(cache, server, response)
    except (BridgeError, OSError):
        token = response.get("access_token")
        if not acquired and isinstance(token, str) and token:
            try:
                request(server, "/ai/connection", token=token, method="DELETE")
            except BridgeError:
                pass
        raise


def _complete_connection(cache, server, response):
    token = response.get("access_token")
    path = credential_path(cache, server)
    previous = None
    previous_token = None
    saved = None
    try:
        previous = path.read_bytes() if path.exists() else None
        if previous is not None:
            try:
                previous_token = load_token(cache, server)
            except BridgeError:
                pass
        saved = store_credentials(cache, server, response)
        stored_token = load_token(cache, server)
        if not isinstance(token, str) or not secrets.compare_digest(token, stored_token):
            raise BridgeError("另一条连接刚刚更新了授权，请重新检查连接状态。")
        result = verify_connection(server, stored_token)
    except (BridgeError, OSError):
        if isinstance(token, str) and token:
            try:
                request(server, "/ai/connection", token=token, method="DELETE")
            except BridgeError:
                pass
        if saved is not None and path.exists() and path.read_bytes() == saved:
            if previous is None:
                path.unlink()
            else:
                temporary = path.with_name(f".restore-{uuid4().hex}")
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    with os.fdopen(descriptor, "wb") as handle:
                        handle.write(previous)
                    os.replace(temporary, path)
                finally:
                    temporary.unlink(missing_ok=True)
        raise
    if previous_token and previous_token != token:
        try:
            request(server, "/ai/connection", token=previous_token, method="DELETE")
        except BridgeError as error:
            if error.status not in (401, 403):
                print("新连接已验证；旧授权未能撤销，将在原有效期结束时失效。", file=sys.stderr)
    return result


def device_connect(cache, server, client):
    preflight_credentials(cache)
    invitation = request(server, "/ai/device/start", method="POST", payload={"client": client})
    if not isinstance(invitation, dict):
        raise BridgeError("配对响应格式无效，请更新衣间后重试。")
    device_code, user_code = invitation.get("device_code"), invitation.get("user_code")
    if (
        not isinstance(device_code, str)
        or not re.fullmatch(r"[A-Za-z0-9_-]{43}", device_code)
        or not isinstance(user_code, str)
        or not re.fullmatch(r"[A-Z0-9]{4}-[A-Z0-9]{4}", user_code)
    ):
        raise BridgeError("配对响应格式无效，请更新衣间后重试。")
    name = "Codex" if client == "codex" else "Claude Code"
    print(f"请在衣间的 AI 设置中确认 {name} 连接，核对短码：{user_code}", flush=True)
    print(f"衣间页面：{server.removesuffix('/api')}/#settings", flush=True)
    lifetime = invitation.get("expires_in")
    if not isinstance(lifetime, (int, float)) or isinstance(lifetime, bool) or not 0 < lifetime <= 300:
        raise BridgeError("配对有效期无效，请重新发起连接。")
    deadline = time.monotonic() + lifetime
    while time.monotonic() < deadline:
        time.sleep(2)
        try:
            response = request(server, "/ai/device/poll", method="POST", payload={"device_code": device_code})
        except BridgeError as error:
            if error.status == 429:
                continue
            raise
        if not isinstance(response, dict):
            raise BridgeError("配对响应格式无效，请重新发起连接。")
        if response.get("status") == "approved":
            return complete_connection(cache, server, response)
        if response.get("status") != "pending":
            raise BridgeError("配对没有完成，请回到衣间重新发起连接。")
    raise BridgeError("等待确认已超时，没有建立连接；请重新发起配对。")


def item_id(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise BridgeError("衣物编号必须是衣橱返回的 UUID。") from None


def list_items(server, token, pending=False):
    items = request(server, "/state", token=token)["items"]
    return [item for item in items if item["status"] != "archived" and (not pending or not item["confirmed"])]


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
        or not re.fullmatch(r"/api/images/[a-f0-9]{32}-(?:original|cutout|beautified)\.jpg", resolved.path)
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


def beautify_job_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}", value):
        raise BridgeError("美化任务编号必须使用衣间返回的真实编号。")
    return value


def download_beautify(server, token, identifier, target):
    identifier = beautify_job_id(identifier)
    data = request(server, f"/beautify/jobs/{identifier}/source", token=token, binary=True)
    target = target.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as handle:
        handle.write(data)
    return {"job_id": identifier, "path": str(target)}


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
    evidence = payload.pop("materials_evidence", "")
    if not isinstance(evidence, str) or not evidence.strip():
        payload.pop("materials", None)
    for field in TAG_FIELDS - {"category", "name", "colors", "seasons", "occasions", "tags"}:
        value = payload.get(field)
        if isinstance(value, str):
            value = value.strip()
        elif isinstance(value, list):
            value = [entry.strip() if isinstance(entry, str) else entry for entry in value]
            value = [entry for entry in value if entry != ""]
        if not value:
            payload.pop(field, None)
        else:
            payload[field] = value
    return request(server, "/items/" + identifier, token=token, method="PATCH", payload=payload)


def save_outfit(server, token, payload):
    identifiers = payload.get("item_ids")
    if not isinstance(identifiers, list) or not 1 <= len(identifiers) <= 20:
        raise BridgeError("搭配必须包含 1 至 20 件衣橱中的衣物。")
    ids = list(dict.fromkeys(item_id(value) for value in identifiers))
    available = {
        item["id"]
        for item in list_items(server, token)
        if item["status"] == "available" and item["confirmed"] and item["ai_status"] != "processing"
    }
    if any(identifier not in available for identifier in ids):
        raise BridgeError("搭配中有不存在、待确认、待洗或已归档的衣物，请重新选择。")
    payload = {**payload, "item_ids": ids, "source": "assistant"}
    return request(server, "/outfits", token=token, method="POST", payload=payload)


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--cache-dir", type=Path, default=default_cache())
    commands = parser.add_subparsers(dest="command", required=True)
    connecting = commands.add_parser("connect")
    connecting.add_argument("--client", choices=("codex", "claude-code"), default="codex")
    connecting.add_argument(
        "--code-stdin", action="store_true", help="备用方式：从隐藏输入或标准输入读取一次性连接码"
    )
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
    commands.add_parser("beautify-list")
    commands.add_parser("beautify-claim").add_argument("job_id")
    beautify_download = commands.add_parser("beautify-download")
    beautify_download.add_argument("job_id")
    beautify_download.add_argument("--output", required=True, type=Path)
    beautify_submit = commands.add_parser("beautify-submit")
    beautify_submit.add_argument("job_id")
    beautify_submit.add_argument("--file", required=True, type=Path)
    commands.add_parser("beautify-fail").add_argument("job_id")
    args = parser.parse_args(argv)
    try:
        server = normalize_server(args.server)
        if args.command == "disconnect":
            with credential_lock(args.cache_dir, server):
                token = load_token(args.cache_dir, server)
                request(server, "/ai/connection", token=token, method="DELETE")
                credential_path(args.cache_dir, server).unlink(missing_ok=True)
            output = {"connected": False}
        elif args.command == "connect":
            if args.code_stdin:
                preflight_credentials(args.cache_dir)
                code = getpass.getpass("衣间连接码：") if sys.stdin.isatty() else sys.stdin.readline().strip()
                if not code or len(code) > 512:
                    raise BridgeError("连接码无效。")
                response = request(server, "/ai/connect", method="POST", payload={"code": code})
                output = complete_connection(args.cache_dir, server, response)
            else:
                output = device_connect(args.cache_dir, server, args.client)
        else:
            token = load_token(args.cache_dir, server)
            if args.command == "status":
                verified = verify_connection(server, token)
                output = {**request(server, "/ai/settings", token=token), **verified}
            elif args.command == "list":
                items = list_items(server, token, args.pending)
                output = {"items": items, "total": len(items)}
            elif args.command == "download":
                output = download_item(server, token, args.item_id, args.output)
            elif args.command == "tag":
                output = tag_item(
                    server, token, args.item_id, read_payload(args.file, TAG_FIELDS), args.confirm
                )
            elif args.command == "beautify-list":
                output = request(server, "/beautify/jobs", token=token)
            elif args.command == "beautify-download":
                output = download_beautify(server, token, args.job_id, args.output)
            elif args.command in {"beautify-claim", "beautify-submit", "beautify-fail"}:
                identifier = beautify_job_id(args.job_id)
                action = {"beautify-claim": "claim", "beautify-submit": "result", "beautify-fail": "fail"}[
                    args.command
                ]
                output = request(
                    server,
                    f"/beautify/jobs/{identifier}/{action}",
                    token=token,
                    method="POST",
                    **({"file": args.file} if action == "result" else {"payload": {}}),
                )
            else:
                output = save_outfit(server, token, read_payload(args.file, OUTFIT_FIELDS))
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    except (BridgeError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
