from __future__ import annotations

import asyncio
import base64
import binascii
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
from io import BytesIO
import ipaddress
import json
from pathlib import Path
import re
import secrets
import socket
import threading
import time
import zipfile
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
import httpx
from pydantic import Field, StrictBool, StrictInt, ValidationError

from .auth import require_access
from .images import ImagePipeline
from .models import ReferencePrice, StrictModel
from .public_dns import PublicDNSError, public_address, resolve_fake_ip

router = APIRouter(prefix="/api/import", tags=["product-import"])
PAGE_BYTES = 2 * 1024 * 1024
IMAGE_BYTES = 8 * 1024 * 1024
CACHE_BYTES = 64 * 1024 * 1024
MAX_IMAGES = 8
TTL = 600
FETCH_SECONDS = 12
PREVIEW_SECONDS = 45
UNREADABLE = "暂时无法读取这个页面，可能需要登录或限制了访问。请保存商品截图后上传。"
DEWU_NO_IMAGES = "这个得物页面没有提供可读取的商品图。请在得物中保存商品图片或截图，再上传到衣间。"
CAPTURE_ROOT = Path(__file__).resolve().parents[1] / "integrations" / "browser-capture"
CAPTURE_RUNTIME = ("manifest.json", "core.js", "entry.js", "popup.html", "popup.js", "popup.css")


class PreviewInput(StrictModel):
    text: str = Field(min_length=1, max_length=8000)


class ImportInput(StrictModel):
    preview_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    image_id: str = Field(pattern=r"^[a-f0-9]{16}$")
    remove_background: StrictBool = True
    auto_analyze: StrictBool = True


class CaptureInput(StrictModel):
    version: StrictInt = Field(ge=1, le=1)
    title: str = Field(max_length=120)
    source_url: str = Field(min_length=1, max_length=2600)
    image: str = Field(min_length=1, max_length=4 * 1024 * 1024)


def _browser(access: str = Depends(require_access)) -> None:
    if access != "browser":
        raise HTTPException(403, "请在衣间页面选择并导入商品图片。")


def _public_address(value: str) -> None:
    try:
        public_address(value)
    except PublicDNSError:
        raise HTTPException(422, "只支持公开的商品网页或图片地址。") from None


def _normalize_url(value: str) -> str:
    try:
        if len(value) > 2600 or any(ord(c) <= 32 or ord(c) == 127 for c in value) or "\\" in value:
            raise ValueError
        parts = urlsplit(value)
        if parts.scheme not in {"https", "http"} or not parts.hostname:
            raise ValueError
        if parts.username is not None or parts.password is not None:
            raise ValueError
        host = parts.hostname.encode("idna").decode("ascii").lower().rstrip(".")
        if not host or "%" in host or parts.port not in {None, 80, 443}:
            raise ValueError
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
            raise ValueError
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            _public_address(host)
        authority = f"[{host}]" if ":" in host else host
        if parts.port is not None:
            authority += f":{parts.port}"
        return urlunsplit((parts.scheme, authority, parts.path or "/", parts.query, ""))
    except (ValueError, UnicodeError):
        raise HTTPException(422, "请粘贴有效的公开商品链接，不要包含账号或密码。") from None


def _extract_url(text: str) -> str:
    match = re.search(r"https?://[^\s<>\"'`]+", text, re.IGNORECASE)
    if not match:
        raise HTTPException(422, "分享文字中没有找到链接，请粘贴完整的商品网址。")
    return _normalize_url(match.group().rstrip("，。！？；：、）】》”’.,;!?)"))


def _product_page_url(url: str) -> str:
    parts = urlsplit(url)
    sku = re.fullmatch(r"/([0-9]+)\.html", parts.path)
    if parts.hostname == "item.jd.com" and sku:
        return "https://item.m.jd.com/product/" + sku[1] + ".html"
    return url


def _saved_source_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.hostname == "fast.dewu.com" and parts.path == "/page/productDetail":
        values = dict(parse_qsl(parts.query))
        product = {
            key: values[key]
            for key in ("spuId", "propertyValueId", "skuId")
            if key in values and re.fullmatch(r"[0-9]+", values[key])
        }
        if "spuId" in product:
            return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(product), ""))
    return url


async def _destination(url: str) -> tuple[httpx.URL, str, str]:
    normalized = _normalize_url(url)
    parts = urlsplit(normalized)
    try:
        rows = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(
                parts.hostname,
                parts.port or (443 if parts.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            ),
            timeout=4,
        )
    except (OSError, TimeoutError):
        raise HTTPException(422, "无法访问这个地址，请检查链接或改用商品截图。") from None
    if not rows:
        raise HTTPException(422, "无法访问这个地址，请检查链接或改用商品截图。")
    try:
        rows = await resolve_fake_ip(parts.hostname, rows)
    except PublicDNSError:
        raise HTTPException(422, "当前网络无法解析公开商品地址，请稍后重试或上传截图。") from None
    for row in rows:
        _public_address(row[4][0])
    address = next((row[4][0] for row in rows if row[0] == socket.AF_INET), rows[0][4][0])
    return httpx.URL(normalized).copy_with(host=address), parts.netloc, parts.hostname


async def _fetch(url: str, max_bytes: int) -> tuple[bytes, str, str]:
    current = _normalize_url(url)
    # The public Dewu detail streams its HTML after the share link's two redirects.
    dewu_page = urlsplit(current).hostname in {"dw4.co", "fast.dewu.com"}
    try:
        async with asyncio.timeout(FETCH_SECONDS * 2 if dewu_page else FETCH_SECONDS):
            for hop in range(4):
                destination, authority, hostname = await _destination(current)
                # A new client per hop prevents remote cookies from becoming ambient credentials.
                timeout = 12 if hostname == "fast.dewu.com" else 8
                async with httpx.AsyncClient(
                    timeout=timeout, follow_redirects=False, trust_env=False
                ) as client:
                    async with client.stream(
                        "GET",
                        destination,
                        headers={
                            "Host": authority,
                            "User-Agent": "Yijian/0.2 (+public-product-preview)",
                            "Accept": "text/html,application/xhtml+xml,image/jpeg,image/png,image/webp",
                            "Accept-Encoding": "identity",
                        },
                        extensions={"sni_hostname": hostname},
                    ) as response:
                        if response.status_code in {301, 302, 303, 307, 308}:
                            location = response.headers.get("location")
                            if not location or hop == 3:
                                raise HTTPException(422, UNREADABLE)
                            current = _normalize_url(urljoin(current, location))
                            continue
                        if response.status_code != 200:
                            raise HTTPException(422, UNREADABLE)
                        if response.headers.get("content-encoding", "identity").lower() != "identity":
                            raise HTTPException(422, UNREADABLE)
                        content_type = response.headers.get("content-type", "")
                        budget = min(max_bytes, PAGE_BYTES) if "html" in content_type.lower() else max_bytes
                        length = response.headers.get("content-length")
                        if length is not None and (
                            not length.isascii()
                            or not length.isdigit()
                            or len(length) > 10
                            or int(length) > budget
                        ):
                            raise HTTPException(422, "页面或图片过大，请保存商品截图后上传。")
                        data = bytearray()
                        async for chunk in response.aiter_bytes(chunk_size=64 * 1024):
                            if len(data) + len(chunk) > budget:
                                raise HTTPException(422, "页面或图片过大，请保存商品截图后上传。")
                            data.extend(chunk)
                        return bytes(data), content_type, current
    except (httpx.RequestError, TimeoutError):
        raise HTTPException(422, "读取链接超时或网络不可用，请稍后重试，也可以上传商品截图。") from None
    raise HTTPException(422, UNREADABLE)


class _ProductPage(HTMLParser):
    def __init__(self, hostname="", path=""):
        super().__init__(convert_charrefs=True)
        self.hostname = hostname
        self.title = ""
        self.og_title = ""
        self.images = []
        self.documents = []
        self.in_title = False
        self.in_head = False
        self.seen_title = False
        self.in_json = False
        self.script = []
        self.product_images = []
        self.mobile_pages = []
        self.dewu_detail = hostname == "fast.dewu.com" and path == "/page/productDetail"
        self.product_title = ""
        self.dewu_price_module = ""
        self.in_product_title = False
        self.price_amounts = set()
        self.price_currencies = set()
        self.div_depth = 0
        self.parameter_row = None
        self.release_values = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").split()
        if tag == "div":
            self.div_depth += 1
        if self.dewu_detail:
            if tag == "div":
                for value in classes:
                    row = re.fullmatch(r"_item_([A-Za-z0-9]+)_\d+", value)
                    if row:
                        self.parameter_row = {
                            "depth": self.div_depth,
                            "module": row[1],
                            "field": None,
                            "label": "",
                            "value": "",
                            "labels": 0,
                            "values": 0,
                        }
            row = self.parameter_row
            if tag == "span" and row and row["depth"] == self.div_depth:
                for value in classes:
                    if re.fullmatch(rf"_itemTitle_{row['module']}_\d+", value):
                        row["field"] = "label"
                        row["labels"] += 1
                    elif re.fullmatch(rf"_itemValue_{row['module']}_\d+", value):
                        row["field"] = "value"
                        row["values"] += 1
        if self.dewu_detail and tag == "div":
            for value in classes:
                module = re.fullmatch(r"_priceCon_([A-Za-z0-9]+)_\d+", value)
                if module and not self.dewu_price_module:
                    self.dewu_price_module = module[1]
            if self.dewu_price_module and not self.product_title:
                self.in_product_title = any(
                    re.fullmatch(rf"_title_{self.dewu_price_module}_\d+", value) for value in classes
                )
        if tag == "head":
            self.in_head = True
        elif tag == "meta":
            key = (attrs.get("property") or attrs.get("name") or "").lower()
            value = attrs.get("content") or ""
            if key == "og:title":
                self.og_title = value
            if key == "product:price:amount":
                self.price_amounts.add(value.strip())
            if key == "product:price:currency":
                self.price_currencies.add(value.strip().upper())
            if key in {"og:image", "og:image:url", "og:image:secure_url", "twitter:image"}:
                if len(self.images) < 40:
                    self.images.append(value)
            if (attrs.get("http-equiv") or "").lower() == "mobile-agent":
                match = re.search(r"(?:^|;)\s*url\s*=\s*(\S+)", value)
                if match:
                    self.mobile_pages.append(match.group(1))
        elif tag == "img" and len(self.product_images) < MAX_IMAGES:
            taobao = self.hostname in {"pcdetail.taobao.com", "item.taobao.com", "detail.tmall.com"}
            jd = self.hostname in {"item.jd.com", "item.m.jd.com"}
            pdd = self.hostname in {"mobile.yangkeduo.com", "m.pinduoduo.com"}
            selected = (
                (taobao and any(value == "mainPic" or value.startswith("mainPic--") for value in classes))
                or (taobao and attrs.get("id") == "J_ImgBooth")
                or (jd and attrs.get("id") in {"firstImg", "spec-img"})
                or (pdd and "goods-image" in classes)
                or (
                    self.dewu_detail
                    and "cat_image" in classes
                    and any(re.fullmatch(r"_carouselImg_[A-Za-z0-9]+_\d+", value) for value in classes)
                )
            )
            if selected and attrs.get("src"):
                self.product_images.append(attrs["src"])
        elif tag == "title" and self.in_head and not self.seen_title:
            self.in_title = True
            self.seen_title = True
        elif tag == "script" and (attrs.get("type") or "").lower() == "application/ld+json":
            self.in_json = True
            self.script = []

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if self.in_json:
            self.script.append(data)
        if self.in_product_title:
            self.product_title += data
        if self.parameter_row and self.parameter_row["field"]:
            self.parameter_row[self.parameter_row["field"]] += data

    def handle_endtag(self, tag):
        if tag == "span" and self.parameter_row:
            self.parameter_row["field"] = None
        if tag == "div":
            row = self.parameter_row
            if row and row["depth"] == self.div_depth:
                if row["labels"] == row["values"] == 1 and row["label"].strip() == "发售价格":
                    self.release_values.add(row["value"].strip())
                self.parameter_row = None
            self.div_depth = max(0, self.div_depth - 1)
            self.in_product_title = False
        if tag == "title":
            self.in_title = False
        elif tag == "head":
            self.in_head = False
            self.in_title = False
        elif tag == "script" and self.in_json:
            self.in_json = False
            try:
                self.documents.append(json.loads("".join(self.script)))
            except (ValueError, RecursionError):
                pass
            self.script = []


def _reference_value(amount, currency, label: str, source_url: str) -> dict | None:
    if isinstance(amount, bool) or not isinstance(amount, (str, int, float)):
        return None
    if isinstance(amount, str) and not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", amount.strip()):
        return None
    if not isinstance(currency, str):
        return None
    try:
        return ReferencePrice(
            amount=float(amount),
            currency=currency.strip().upper(),
            label=label,
            observed_at=datetime.now(timezone.utc),
            source_url=_saved_source_url(source_url),
        ).model_dump(mode="json")
    except (ValueError, OverflowError, ValidationError):
        return None


def _schema_types(node: dict) -> list[str]:
    values = node.get("@type", [])
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, list):
        return []
    return [value.rsplit("/", 1)[-1] for value in values if isinstance(value, str)]


def _offer_reference(offers, source_url: str) -> dict | None:
    if not isinstance(offers, list):
        offers = [offers]
    if not offers or len(offers) > 40:
        return None
    prices = []
    for offer in offers:
        if not isinstance(offer, dict):
            return None
        kinds = _schema_types(offer)
        aggregate = "AggregateOffer" in kinds
        if kinds and not aggregate and "Offer" not in kinds:
            return None
        price = _reference_value(
            offer.get("lowPrice" if aggregate else "price"),
            offer.get("priceCurrency"),
            "起售价" if aggregate else "页面售价",
            source_url,
        )
        if price is None:
            return None
        prices.append(price)
    distinct = {(price["amount"], price["currency"], price["label"]) for price in prices}
    return prices[0] if len(distinct) == 1 else None


def _page_metadata(data: bytes, content_type: str, source_url: str) -> tuple[str, list[str], dict | None]:
    if len(data) > PAGE_BYTES:
        raise HTTPException(422, "商品页面过大，请保存商品截图后上传。")
    charset = re.search(r"charset\s*=\s*[\"']?([\w-]+)", content_type, re.IGNORECASE)
    try:
        text = data.decode(charset.group(1) if charset else "utf-8", errors="replace")
    except LookupError:
        text = data.decode("utf-8", errors="replace")
    source = urlsplit(source_url)
    parser = _ProductPage(source.hostname, source.path)
    parser.feed(text)
    product_title, product_images = "", []
    products = []
    pending = list(parser.documents)
    visited = 0
    while pending and visited < 2000:
        node = pending.pop()
        visited += 1
        if isinstance(node, list):
            pending.extend(node[:2000])
        elif isinstance(node, dict):
            kinds = _schema_types(node)
            if "Product" in kinds:
                products.append(node)
                if isinstance(node.get("name"), str) and not product_title:
                    product_title = node["name"]
                pictures = node.get("image", [])
                if not isinstance(pictures, list):
                    pictures = [pictures]
                for picture in pictures[:40]:
                    if isinstance(picture, dict):
                        picture = picture.get("url") or picture.get("contentUrl")
                    if isinstance(picture, str):
                        product_images.append(picture)
            pending.extend(value for value in node.values() if isinstance(value, (dict, list)))
    title = (
        " ".join((product_title or parser.product_title or parser.og_title or parser.title).split())[:120]
        or "链接导入的衣物"
    )
    images = []
    for value in product_images + parser.product_images + parser.images:
        try:
            image = _normalize_url(urljoin(source_url, value))
        except HTTPException:
            continue
        if image not in images:
            images.append(image)
        if len(images) == MAX_IMAGES:
            break
    reference_price = None
    if len(products) == 1 and products[0].get("offers") is not None:
        reference_price = _offer_reference(products[0]["offers"], source_url)
    elif len(products) <= 1 and len(parser.price_amounts) == len(parser.price_currencies) == 1:
        reference_price = _reference_value(
            next(iter(parser.price_amounts)), next(iter(parser.price_currencies)), "页面售价", source_url
        )
    if (
        reference_price is None
        and parser.product_images
        and parser.product_title
        and len(parser.release_values) == 1
    ):
        release = re.fullmatch(r"[¥￥]\s*([0-9]+(?:\.[0-9]+)?)", next(iter(parser.release_values)))
        if release:
            reference_price = _reference_value(release[1], "CNY", "发售价格", source_url)
    return title, images, reference_price


def _metadata(data: bytes, content_type: str, source_url: str) -> tuple[str, list[str]]:
    title, images, _ = _page_metadata(data, content_type, source_url)
    return title, images


def _published_mobile_page(data: bytes, source_url: str) -> str | None:
    source = urlsplit(source_url)
    sku = re.fullmatch(r"/([0-9]+)\.html", source.path)
    if source.hostname != "item.jd.com" or not sku:
        return None
    parser = _ProductPage(source.hostname)
    parser.feed(data.decode("utf-8", errors="replace"))
    for value in parser.mobile_pages:
        try:
            destination = _normalize_url(urljoin(source_url, value))
        except HTTPException:
            continue
        parts = urlsplit(destination)
        if parts.hostname == "item.m.jd.com" and parts.path == f"/product/{sku[1]}.html":
            return destination
    return None


def _jpeg(data: bytes) -> bytes:
    image = ImagePipeline._decode(data)
    try:
        buffer = BytesIO()
        image.save(buffer, "JPEG", quality=90, optimize=True)
        return buffer.getvalue()
    finally:
        image.close()


class PreviewCache:
    def __init__(self):
        self.lock = threading.Lock()
        self.previews = {}
        self.starts = []
        self.active = 0

    def _prune(self):
        now = time.time()
        self.previews = {
            key: value for key, value in self.previews.items() if value["expires_at"] > now or value["busy"]
        }

    def reserve(self):
        with self.lock:
            self._prune()
            now = time.time()
            self.starts = [value for value in self.starts if value > now - 60]
            if self.active >= 2 or len(self.starts) >= 6:
                raise HTTPException(429, "链接读取较频繁，请稍等片刻再试。")
            self.starts.append(now)
            self.active += 1

    def release(self):
        with self.lock:
            self.active -= 1

    def save(self, title, source_url, images, reference_price=None):
        source_url = _saved_source_url(source_url)
        with self.lock:
            self._prune()
            size = sum(len(data) for data in images.values())
            occupied = sum(
                len(data) for preview in self.previews.values() for data in preview["images"].values()
            )
            pending = sum(not preview["consumed"] for preview in self.previews.values())
            if pending >= 8 or occupied + size > CACHE_BYTES:
                raise HTTPException(429, "待确认的链接较多，请稍后重新读取。")
            preview_id = secrets.token_hex(16)
            self.previews[preview_id] = {
                "title": title,
                "source_url": source_url,
                "reference_price": reference_price,
                "images": images,
                "expires_at": time.time() + TTL,
                "busy": False,
                "consumed": False,
            }
            return {
                "preview_id": preview_id,
                "title": title,
                "source_url": source_url,
                "reference_price": reference_price,
                "images": [
                    {"id": key, "url": f"/api/import/preview/{preview_id}/images/{key}"} for key in images
                ],
            }

    def get(self, preview_id, image_id, *, consume=False):
        with self.lock:
            self._prune()
            preview = self.previews.get(preview_id)
            if preview is None:
                raise HTTPException(410, "图片预览已过期，请重新读取链接。")
            if preview["consumed"] or (consume and preview["busy"]):
                raise HTTPException(409, "这个预览已经导入或正在导入，请查看衣橱。")
            if image_id not in preview["images"]:
                raise HTTPException(404, "预览图片不存在，请重新选择。")
            if consume:
                preview["busy"] = True
            return (
                preview["images"][image_id],
                preview["title"],
                preview["source_url"],
                preview["reference_price"],
            )

    def finish(self, preview_id, success):
        with self.lock:
            preview = self.previews.get(preview_id)
            if preview:
                preview["busy"] = False
                preview["consumed"] = success
                if success:
                    preview["images"] = {}


@router.post("/preview", dependencies=[Depends(_browser)])
async def preview_product(body: PreviewInput, request: Request):
    source = _product_page_url(_extract_url(body.text))
    cache = request.app.state.product_previews
    cache.reserve()
    images = {}
    hashes = set()
    title = "链接导入的衣物"
    reference_price = None
    try:
        try:
            async with asyncio.timeout(PREVIEW_SECONDS):
                data, content_type, source = await _fetch(source, IMAGE_BYTES)
                if content_type.lower().startswith("image/") or data.startswith(
                    (b"\xff\xd8\xff", b"\x89PNG", b"RIFF")
                ):
                    try:
                        images[secrets.token_hex(8)] = await asyncio.to_thread(_jpeg, data)
                    except (ValueError, OSError):
                        raise HTTPException(422, "这个链接不是可读取的商品图片，请上传商品截图。") from None
                else:
                    title, candidates, reference_price = _page_metadata(data, content_type, source)
                    if not candidates:
                        mobile_page = _published_mobile_page(data, source)
                        if mobile_page:
                            data, content_type, source = await _fetch(mobile_page, PAGE_BYTES)
                            title, candidates, reference_price = _page_metadata(data, content_type, source)
                    for url in candidates:
                        try:
                            content, _, _ = await _fetch(url, IMAGE_BYTES)
                            picture = await asyncio.to_thread(_jpeg, content)
                        except (HTTPException, ValueError, OSError):
                            continue
                        fingerprint = hashlib.sha256(picture).digest()
                        if fingerprint not in hashes:
                            hashes.add(fingerprint)
                            images[secrets.token_hex(8)] = picture
        except TimeoutError:
            if not images:
                raise HTTPException(422, "读取链接超时，请稍后重试或上传商品截图。") from None
        if not images:
            if urlsplit(source).hostname in {
                "dw4.co",
                "fast.dewu.com",
                "www.dewu.com",
                "m.dewu.com",
                "cdn-m.dewu.com",
                "h5.dewu.com",
            }:
                raise HTTPException(422, DEWU_NO_IMAGES)
            raise HTTPException(422, "没有找到可读取的商品图片，页面可能需要登录。请保存商品截图后上传。")
        return cache.save(title, source, images, reference_price)
    finally:
        cache.release()


@router.post("/capture", dependencies=[Depends(_browser)])
async def preview_capture(body: CaptureInput, request: Request):
    source = _normalize_url(body.source_url)
    match = re.fullmatch(r"data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)", body.image)
    if not match:
        raise HTTPException(422, "网页采集图片格式无效，请重新选择商品图片。")
    try:
        content = base64.b64decode(match[2], validate=True)
    except (ValueError, binascii.Error):
        raise HTTPException(422, "网页采集图片已损坏，请重新采集。") from None
    if len(content) > 3 * 1024 * 1024:
        raise HTTPException(422, "采集图片过大，请缩小选取范围后重试。")
    valid_header = {
        "jpeg": content.startswith(b"\xff\xd8\xff"),
        "png": content.startswith(b"\x89PNG\r\n\x1a\n"),
        "webp": content.startswith(b"RIFF") and content[8:12] == b"WEBP",
    }
    if not valid_header[match[1]]:
        raise HTTPException(422, "网页采集图片格式无效，请重新选择商品图片。")
    cache = request.app.state.product_previews
    cache.reserve()
    try:
        try:
            content = await asyncio.to_thread(_jpeg, content)
        except (ValueError, OSError):
            raise HTTPException(422, "无法读取采集图片，请重新选择商品图片。") from None
        return cache.save(body.title.strip() or "网页采集的衣物", source, {secrets.token_hex(8): content})
    finally:
        cache.release()


@router.get("/capture-extension", dependencies=[Depends(_browser)])
def capture_extension():
    if CAPTURE_ROOT.is_symlink() or not CAPTURE_ROOT.is_dir():
        raise HTTPException(503, "采集工具暂不可用，请稍后重试。")
    files = []
    total = 0
    try:
        for name in (*CAPTURE_RUNTIME, "README.md", "LICENSE"):
            path = CAPTURE_ROOT / name
            if path.is_symlink() or path.resolve().parent != CAPTURE_ROOT.resolve():
                raise ValueError
            if not path.is_file():
                if name in CAPTURE_RUNTIME:
                    raise ValueError
                continue
            if path.stat().st_size > 512 * 1024:
                raise ValueError
            content = path.read_bytes()
            total += len(content)
            if total > 1024 * 1024:
                raise ValueError
            files.append((name, content))
    except (OSError, ValueError):
        raise HTTPException(503, "采集工具文件暂不完整，请稍后重试。") from None
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files:
            archive.writestr("yijian-browser-capture/" + name, content)
    return Response(
        buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="yijian-browser-capture-0.1.0.zip"'},
    )


@router.get("/preview/{preview_id}/images/{image_id}", dependencies=[Depends(_browser)])
def preview_image(preview_id: str, image_id: str, request: Request):
    data, _, _, _ = request.app.state.product_previews.get(preview_id, image_id)
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.post("/items", dependencies=[Depends(_browser)])
async def import_product(body: ImportInput, request: Request, background_tasks: BackgroundTasks):
    cache = request.app.state.product_previews
    content, title, source, reference_price = cache.get(body.preview_id, body.image_id, consume=True)
    success = False
    try:
        item, warnings = await request.app.state.import_photo(
            content,
            title,
            body.remove_background,
            body.auto_analyze,
            background_tasks,
            access="browser",
            notes="商品来源：" + source,
            reference_price=reference_price,
        )
        success = True
        return {"items": [item], "warnings": warnings}
    finally:
        cache.finish(body.preview_id, success)
