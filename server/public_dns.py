from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import socket

import httpx

FAKE_IP_RANGE = ipaddress.ip_network("198.18.0.0/15")
MAX_DNS_BYTES = 64 * 1024


class PublicDNSError(Exception):
    pass


def _address(value: str):
    result = ipaddress.ip_address(value)
    return result.ipv4_mapped or result if isinstance(result, ipaddress.IPv6Address) else result


def public_address(value: str) -> None:
    try:
        address = _address(value)
        if isinstance(address, ipaddress.IPv6Address) and (
            address.sixtofour or address.teredo or address in ipaddress.ip_network("64:ff9b::/96")
        ):
            raise ValueError
        if (
            not address.is_global
            or address.is_multicast
            or address.is_reserved
            or str(address)
            in {
                "168.63.129.16",
                "100.100.100.200",
            }
        ):
            raise ValueError
    except ValueError:
        raise PublicDNSError("DNS did not return a public address") from None


async def _query(hostname: str, kind: int) -> list[str]:
    try:
        async with httpx.AsyncClient(timeout=6, trust_env=False, follow_redirects=False) as client:
            async with client.stream(
                "GET",
                "https://1.1.1.1/dns-query",
                params={"name": hostname, "type": kind},
                headers={
                    "Host": "cloudflare-dns.com",
                    "Accept": "application/dns-json",
                    "Accept-Encoding": "identity",
                },
                extensions={"sni_hostname": "cloudflare-dns.com"},
            ) as response:
                if (
                    response.status_code != 200
                    or response.headers.get("content-encoding", "identity") != "identity"
                ):
                    raise PublicDNSError("Public DNS is unavailable")
                data = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=4096):
                    if len(data) + len(chunk) > MAX_DNS_BYTES:
                        raise PublicDNSError("Public DNS response is too large")
                    data.extend(chunk)
        payload = json.loads(data)
        question = payload.get("Question")
        if (
            type(payload.get("Status")) is not int
            or payload["Status"] != 0
            or not isinstance(question, list)
            or len(question) != 1
            or not isinstance(question[0], dict)
            or str(question[0].get("name", "")).lower().rstrip(".") != hostname
            or question[0].get("type") != kind
        ):
            raise PublicDNSError("Public DNS response did not match the question")
        answers = payload.get("Answer", [])
        if not isinstance(answers, list):
            raise ValueError
        addresses = []
        for answer in answers:
            if not isinstance(answer, dict):
                raise ValueError
            if answer.get("type") in {1, 28}:
                address = str(answer.get("data", ""))
                public_address(address)
                expected = 4 if answer["type"] == 1 else 6
                if ipaddress.ip_address(address).version != expected:
                    raise ValueError
                addresses.append(address)
        return addresses
    except PublicDNSError:
        raise
    except (httpx.RequestError, ValueError, TypeError, AttributeError, RecursionError):
        raise PublicDNSError("Public DNS is unavailable") from None


async def resolve_fake_ip(hostname: str, rows: list[tuple]) -> list[tuple]:
    if not rows or not all(_address(row[4][0]) in FAKE_IP_RANGE for row in rows):
        return rows
    hostname = hostname.lower().rstrip(".")
    if not re.fullmatch(r"[a-z0-9.-]{1,253}", hostname):
        raise PublicDNSError("Invalid DNS hostname")
    try:
        async with asyncio.timeout(8):
            results = await asyncio.gather(_query(hostname, 1), _query(hostname, 28), return_exceptions=True)
    except TimeoutError:
        raise PublicDNSError("Public DNS timed out") from None
    if any(isinstance(result, BaseException) for result in results):
        raise PublicDNSError("Public DNS is unavailable")
    addresses = list(dict.fromkeys(address for result in results for address in result))
    if not addresses:
        raise PublicDNSError("Public DNS did not return an address")
    port = rows[0][4][1]
    return [
        (
            socket.AF_INET6 if ":" in address else socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            (address, port, 0, 0) if ":" in address else (address, port),
        )
        for address in addresses
    ]
