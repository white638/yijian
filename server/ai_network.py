from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit, urlunsplit

import httpx


class ModelConnectionError(Exception):
    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


def _address(value: str):
    address = ipaddress.ip_address(value)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def endpoint_url(value: str) -> str:
    try:
        if not value or any(ord(character) <= 32 for character in value) or "\\" in value:
            raise ValueError
        parts = urlsplit(value)
        if parts.scheme not in {"https", "http"} or not parts.hostname:
            raise ValueError
        if parts.username is not None or parts.password is not None or parts.query or parts.fragment:
            raise ValueError
        host = parts.hostname.encode("idna").decode("ascii").lower().rstrip(".")
        port = parts.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError
    except (ValueError, UnicodeError):
        raise ModelConnectionError("请填写有效的模型接口地址，不要在地址中包含密码或参数。") from None
    loopback = host == "localhost"
    try:
        address = _address(host)
    except ValueError:
        address = None
    if address is not None:
        _allow_address(str(address))
        loopback = address.is_loopback
    if parts.scheme == "http" and not loopback:
        raise ModelConnectionError("公网模型接口需要 HTTPS；本机模型请使用 localhost 或回环地址。")
    if host in {"metadata.google.internal", "metadata.goog", "instance-data.ec2.internal"}:
        raise ModelConnectionError("这个地址不能用作模型接口。")
    authority = f"[{host}]" if ":" in host else host
    if port and port != (443 if parts.scheme == "https" else 80):
        authority += f":{port}"
    return urlunsplit((parts.scheme, authority, parts.path.rstrip("/"), "", ""))


def _allow_address(value: str) -> None:
    address = _address(value)
    if address.is_loopback:
        return
    denied = {"100.100.100.200", "168.63.129.16", "fd00:ec2::254"}
    if not address.is_global or address.is_multicast or address.is_reserved or str(address) in denied:
        raise ModelConnectionError("只支持公网 HTTPS 接口和本机回环接口。")


async def _destination(base_url: str) -> tuple[httpx.URL, str, str]:
    normalized = endpoint_url(base_url)
    parts = urlsplit(normalized)
    host = parts.hostname
    try:
        results = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(
                host,
                parts.port or (443 if parts.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            ),
            timeout=5,
        )
    except (OSError, TimeoutError):
        raise ModelConnectionError("无法解析模型接口地址，请检查地址和网络。") from None
    if not results:
        raise ModelConnectionError("无法解析模型接口地址，请检查地址和网络。")
    for result in results:
        _allow_address(result[4][0])
        if _address(result[4][0]).is_loopback:
            try:
                explicit_loopback = _address(host).is_loopback
            except ValueError:
                explicit_loopback = host == "localhost"
            if not explicit_loopback:
                raise ModelConnectionError("本机模型请使用 localhost 或回环地址。")
    address = next((row[4][0] for row in results if row[0] == socket.AF_INET), results[0][4][0])
    if parts.scheme == "http" and not _address(address).is_loopback:
        raise ModelConnectionError("本机 HTTP 接口只能连接回环地址。")
    return httpx.URL(normalized + "/chat/completions").copy_with(host=address), parts.netloc, host


async def completion(configuration: dict, messages: list[dict], *, model: str, limit: int = 1800) -> str:
    if not model:
        raise ModelConnectionError("请先填写这个功能使用的模型名称。")
    destination, authority, hostname = await _destination(configuration["base_url"])
    headers = {"Content-Type": "application/json", "Host": authority}
    key = configuration.get("api_key")
    if key:
        headers["Authorization"] = "Bearer " + key
    body = {"model": model, "messages": messages, "stream": False}
    body["max_completion_tokens" if configuration["provider"] == "openai" else "max_tokens"] = limit
    try:
        async with asyncio.timeout(55):
            async with httpx.AsyncClient(timeout=45, follow_redirects=False, trust_env=False) as client:
                async with client.stream(
                    "POST", destination, headers=headers, json=body, extensions={"sni_hostname": hostname}
                ) as response:
                    if response.status_code in {401, 403}:
                        raise ModelConnectionError("模型服务没有接受密钥，请检查密钥和访问权限。")
                    if response.status_code == 429:
                        raise ModelConnectionError("模型服务暂时限流，或可用额度不足，请稍后重试。")
                    if response.status_code in {400, 404, 422}:
                        raise ModelConnectionError("请检查模型名称、接口地址及模型支持的输入类型。")
                    if response.status_code != 200:
                        raise ModelConnectionError("模型服务暂时不可用，请稍后重试。")
                    payload = bytearray()
                    async for chunk in response.aiter_bytes():
                        payload.extend(chunk)
                        if len(payload) > 1_000_000:
                            raise ModelConnectionError("模型返回内容过长，请重试。")
        import json

        parsed = json.loads(payload)
        answer = parsed["choices"][0]["message"]["content"]
        if not isinstance(answer, str) or not answer.strip():
            raise ValueError
        if key and key in answer:
            raise ModelConnectionError("模型返回内容异常，请检查接口设置。")
        return answer.strip()
    except ModelConnectionError:
        raise
    except (TimeoutError, httpx.TimeoutException):
        raise ModelConnectionError("模型响应超时，请稍后重试或换用更快的模型。") from None
    except httpx.RequestError:
        raise ModelConnectionError("无法连接模型服务，请检查地址和网络。") from None
    except (KeyError, IndexError, TypeError, ValueError, UnicodeError):
        raise ModelConnectionError("模型没有返回可用内容，请检查模型设置。") from None
