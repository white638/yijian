import asyncio
import base64
from datetime import datetime
import gzip
import io
import json
import socket
import threading
import time
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import BackgroundTasks, HTTPException
import httpx
from PIL import Image
import pytest

from server import ai, host_vision, product_import as links, public_dns
from server.auth import digest
from server.main import create_app

pytestmark = pytest.mark.anyio
REAL_CLIENT = httpx.AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


def picture(color="blue"):
    buffer = io.BytesIO()
    Image.new("RGB", (60, 80), color).save(buffer, "PNG")
    return buffer.getvalue()


@pytest.fixture
async def suite(tmp_path, monkeypatch):
    monkeypatch.setenv("YIJIAN_MODEL_CACHE", str(tmp_path / "models"))
    app = create_app(tmp_path / "wardrobe")
    async with REAL_CLIENT(transport=httpx.ASGITransport(app), base_url="http://testserver") as client:
        await client.post("/api/session", json={"code": app.state.bootstrap_code})
        yield SimpleNamespace(app=app, client=client, store=app.state.store)


@pytest.fixture
async def network(monkeypatch):
    routes, requests, clients = {}, [], []

    def handler(request):
        requests.append(request)
        key = (request.headers["host"], request.url.path)
        value = routes.get(key, (404, {}, b"not found"))
        if callable(value):
            return value(request)
        if isinstance(value, httpx.Response):
            return value
        return httpx.Response(value[0], headers=value[1], content=value[2])

    def client(**kwargs):
        clients.append(kwargs)
        return REAL_CLIENT(transport=httpx.MockTransport(handler), **kwargs)

    resolver = AsyncMock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))])
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolver)
    monkeypatch.setattr(links.httpx, "AsyncClient", client)
    return SimpleNamespace(routes=routes, requests=requests, clients=clients, resolver=resolver)


def page(network, html, path="/product"):
    network.routes[("shop.example", path)] = (
        200,
        {"Content-Type": "text/html; charset=utf-8"},
        html.encode(),
    )


def image(network, path="/shirt.png", color="blue", domain="shop.example"):
    network.routes[(domain, path)] = (200, {"Content-Type": "image/png"}, picture(color))


async def preview(suite, text="https://shop.example/product"):
    response = await suite.client.post("/api/import/preview", json={"text": text})
    assert response.status_code == 200, response.text
    return response.json()


def selection(result, **changes):
    return {
        "preview_id": result["preview_id"],
        "image_id": result["images"][0]["id"],
        "remove_background": False,
        "auto_analyze": False,
        **changes,
    }


async def test_share_page_uses_product_metadata_local_images_and_single_confirmed_import(suite, network):
    page(
        network,
        """<title>店铺</title><meta property="og:title" content="旧标题">
      <meta property="og:image" content="/shirt.png">
      <script type="application/ld+json">{"@graph":[{"@type":"Product","name":"蓝色衬衫",
      "image":[{"@type":"ImageObject","url":"/shirt.png"},"https://cdn.example/red.png"],
      "offers":{"price":"999"},"brand":{"name":"网页品牌"}}]}</script>""",
    )
    image(network)
    image(network, "/red.png", "red", "cdn.example")
    result = await preview(suite, "推荐这件衣服 https://shop.example/product?sku=123#details ，看看")
    assert result["title"] == "蓝色衬衫" and result["source_url"].endswith("?sku=123")
    assert len(result["images"]) == 2
    assert result["reference_price"] is None
    assert suite.store.read()["items"] == []
    local = await suite.client.get(result["images"][0]["url"])
    assert local.status_code == 200 and local.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(local.content)).format == "JPEG"
    calls = len(network.requests)
    network.routes.clear()
    response = await suite.client.post("/api/import/items", json=selection(result))
    assert response.status_code == 200 and response.json()["warnings"] == []
    item = response.json()["items"][0]
    assert item["name"] == "蓝色衬衫" and item["confirmed"] is False
    assert item["brand"] == "" and item["price"] is None
    assert item["notes"] == "商品来源：https://shop.example/product?sku=123"
    assert item["image_url"] == item["original_url"] and item["ai_status"] == "idle"
    assert len(network.requests) == calls
    assert (await suite.client.post("/api/import/items", json=selection(result))).status_code == 409
    assert len(suite.store.read()["items"]) == 1
    assert all(request.url.host == "93.184.216.34" for request in network.requests)
    assert all(request.extensions["sni_hostname"] == request.headers["host"] for request in network.requests)


@pytest.mark.parametrize("mime", ["image/png", "application/octet-stream"])
async def test_direct_image_preview_and_duplicate_picture_filter(suite, network, mime):
    image(network)
    network.routes[("shop.example", "/shirt.png")] = (200, {"Content-Type": mime}, picture())
    result = await preview(suite, "https://shop.example/shirt.png")
    assert result["title"] == "链接导入的衣物" and len(result["images"]) == 1
    assert result["reference_price"] is None
    page(
        network,
        '<meta property="og:image" content="/shirt.png"><meta property="og:image" content="/same.png">',
    )
    image(network, "/same.png")
    result = await preview(suite)
    assert len(result["images"]) == 1


async def test_dewu_share_reads_public_product_carousel_and_title_without_promotional_images(suite, network):
    network.routes[("dw4.co", "/t/A/ExampleShare")] = (
        302,
        {"Location": "https://fast.dewu.com/router/product/ProductDetail?spuId=123"},
        b"",
    )
    network.routes[("fast.dewu.com", "/router/product/ProductDetail")] = (
        301,
        {
            "Location": "/page/productDetail?spuId=123&propertyValueId=456&skuId=789&fromUserId=private&__sid__=tracking&sourceName=shareDetail"
        },
        b"",
    )
    html = """<head><title>商品详情</title></head><body>
      <img class="cat_image _carouselImg_abc12_19" src="https://webimg.dewucdn.com/front.png">
      <img class="cat_image _carouselImg_abc12_19" src="https://webimg.dewucdn.com/back.png">
      <div class="_priceCon_def34_6"><div class="_priceIcon_def34_11">¥</div></div>
      <div class="_title_def34_41">拼接短袖 Polo 衫</div>
      <img class="cat_image _brandImg_fff_10" src="https://webimg.dewucdn.com/logo.png">
      <img class="cat_image _image_ggg_56" src="https://webimg.dewucdn.com/qrcode.png">
      <div class="_item_info_44"><span class="_itemTitle_info_56">主货号</span><span class="_itemValue_info_57">123</span></div>
      <div class="_item_info_44"><span class="_itemTitle_info_56">发售价格</span><span class="_itemValue_info_57">¥399</span></div>
      <div class="_item_info_44"><span class="_itemTitle_info_56">服务费</span><span class="_itemValue_info_57">¥25</span></div>
      <div class="_title_hhh_14">服务</div></body>"""
    network.routes[("fast.dewu.com", "/page/productDetail")] = (
        200,
        {"Content-Type": "text/html; charset=utf-8"},
        html.encode(),
    )
    image(network, "/front.png", "blue", "webimg.dewucdn.com")
    image(network, "/back.png", "red", "webimg.dewucdn.com")
    result = await preview(
        suite,
        "【得物】发现一件好物，7 CA1201 å8k2qW1då https://dw4.co/t/A/ExampleShare 拼接短袖 Polo 衫，点击链接直接打开。",
    )
    assert result["title"] == "拼接短袖 Polo 衫"
    assert (
        result["source_url"]
        == "https://fast.dewu.com/page/productDetail?spuId=123&propertyValueId=456&skuId=789"
    )
    assert len(result["images"]) == 2
    reference = result["reference_price"]
    assert (reference["amount"], reference["currency"], reference["label"]) == (399.0, "CNY", "发售价格")
    assert reference["source_url"] == result["source_url"]
    for entry in result["images"]:
        response = await suite.client.get(entry["url"])
        assert response.status_code == 200
        with Image.open(io.BytesIO(response.content)) as decoded:
            assert decoded.format == "JPEG"
    assert {r.url.path for r in network.requests if r.headers["host"] == "webimg.dewucdn.com"} == {
        "/front.png",
        "/back.png",
    }
    assert suite.store.read()["items"] == []
    response = await suite.client.post("/api/import/items", json=selection(result))
    assert response.status_code == 200
    assert response.json()["items"][0]["notes"] == "商品来源：" + result["source_url"]
    assert response.json()["items"][0]["reference_price"] == reference
    assert response.json()["items"][0]["price"] is None


@pytest.mark.parametrize(
    "offer,expected",
    [
        ({"@type": "Offer", "price": "59.90", "priceCurrency": "CNY"}, (59.9, "CNY", "页面售价")),
        (
            {
                "@type": "https://schema.org/AggregateOffer",
                "lowPrice": 40,
                "highPrice": 70,
                "priceCurrency": "USD",
            },
            (40.0, "USD", "起售价"),
        ),
    ],
)
async def test_product_offer_reference_price_survives_import_without_changing_paid_price(
    suite, network, offer, expected
):
    product = {"@type": "Product", "name": "棉衬衫", "image": "/shirt.png", "offers": offer}
    page(network, '<script type="application/ld+json">' + json.dumps(product) + "</script>")
    image(network)
    result = await preview(suite)
    reference = result["reference_price"]
    assert (reference["amount"], reference["currency"], reference["label"]) == expected
    assert datetime.fromisoformat(reference["observed_at"].replace("Z", "+00:00")).utcoffset() is not None
    assert reference["source_url"] == result["source_url"]
    response = await suite.client.post("/api/import/items", json=selection(result))
    item = response.json()["items"][0]
    assert item["reference_price"] == reference and item["price"] is None
    response = await suite.client.patch("/api/items/" + item["id"], json={"price": 35, "currency": "EUR"})
    assert response.status_code == 200
    assert response.json()["price"] == "35.00" and response.json()["currency"] == "EUR"
    assert response.json()["reference_price"] == reference


@pytest.mark.parametrize(
    "offer",
    [
        {"price": "399"},
        {"price": "399", "priceCurrency": "¥"},
        {"price": "399", "priceCurrency": "ZZZ"},
        {"price": True, "priceCurrency": "CNY"},
        {"price": -1, "priceCurrency": "CNY"},
        {"price": 100000001, "priceCurrency": "CNY"},
        {"price": float("nan"), "priceCurrency": "CNY"},
        {"price": float("inf"), "priceCurrency": "CNY"},
        {"price": "¥399", "priceCurrency": "CNY"},
        {"@type": "AggregateOffer", "highPrice": 399, "priceCurrency": "CNY"},
        [{"price": 30, "priceCurrency": "CNY"}, {"price": 40, "priceCurrency": "CNY"}],
    ],
)
async def test_ambiguous_or_invalid_product_offers_do_not_create_reference_prices(offer):
    data = json.dumps({"@type": "Product", "offers": offer})
    _, _, reference = links._page_metadata(
        ('<script type="application/ld+json">' + data + "</script>").encode(),
        "text/html",
        "https://shop.example/product",
    )
    assert reference is None


@pytest.mark.parametrize(
    "extra,expected",
    [
        (
            '<meta property="product:price:amount" content="0"><meta property="product:price:currency" content="JPY">',
            (0.0, "JPY"),
        ),
        (
            '<meta property="product:price:amount" content="120.50"><meta property="product:price:currency" content="hkd">',
            (120.5, "HKD"),
        ),
        ('<meta property="product:price:amount" content="399">', None),
        (
            '<meta property="product:price:amount" content="399"><meta property="product:price:currency" content="¥">',
            None,
        ),
        (
            '<meta property="product:price:amount" content="399"><meta property="product:price:amount" content="199"><meta property="product:price:currency" content="CNY">',
            None,
        ),
        ("<div>售价 ¥399，服务费 ¥20</div><script>window.authPrice=39900</script>", None),
    ],
)
async def test_og_reference_price_requires_one_explicit_amount_and_currency(extra, expected):
    _, _, reference = links._page_metadata(extra.encode(), "text/html", "https://shop.example/product")
    if expected is None:
        assert reference is None
    else:
        assert (reference["amount"], reference["currency"]) == expected
        assert reference["label"] == "页面售价"


async def test_multiple_products_do_not_borrow_a_related_products_price():
    products = [
        {"@type": "Product", "name": name, "offers": {"price": price, "priceCurrency": "CNY"}}
        for name, price in [("衬衫", 39), ("推荐外套", 299)]
    ]
    _, _, reference = links._page_metadata(
        ('<script type="application/ld+json">' + json.dumps(products) + "</script>").encode(),
        "text/html",
        "https://shop.example/product",
    )
    assert reference is None


@pytest.mark.parametrize(
    "rows,expected",
    [
        (
            '<div class="_item_info_44"><span class="_itemTitle_info_56">发售价格</span><span class="_itemValue_info_57">¥399</span></div>',
            399.0,
        ),
        (
            '<div class="_item_info_44"><span class="_itemTitle_info_56">原价</span><span class="_itemValue_info_57">¥399</span></div>',
            None,
        ),
        (
            '<div class="_item_info_44"><span class="_itemTitle_info_56">发售价格</span></div><div class="_item_info_44"><span class="_itemTitle_info_56">服务费</span><span class="_itemValue_info_57">¥25</span></div>',
            None,
        ),
        (
            '<div class="_item_info_44"><span class="_itemTitle_info_56">发售价格</span><span class="_itemValue_other_57">¥399</span></div>',
            None,
        ),
        (
            '<div class="_item_info_44"><span class="_itemTitle_info_56">发售价格</span><span class="_itemValue_info_57">399</span></div>',
            None,
        ),
    ],
)
async def test_dewu_release_price_is_read_from_its_exact_parameter_row(rows, expected):
    shell = '<img class="cat_image _carouselImg_pic_19" src="/shirt.jpg"><div class="_priceCon_main_6"></div><div class="_title_main_41">拼接衬衫</div>'
    data = (shell + rows).encode()
    _, _, reference = links._page_metadata(
        data, "text/html", "https://fast.dewu.com/page/productDetail?spuId=123"
    )
    if expected is None:
        assert reference is None
    else:
        assert reference["amount"] == expected and reference["currency"] == "CNY"
        assert reference["label"] == "发售价格"
        current = '<meta property="product:price:amount" content="259"><meta property="product:price:currency" content="CNY">'
        _, _, price = links._page_metadata(
            current.encode() + data, "text/html", "https://fast.dewu.com/page/productDetail?spuId=123"
        )
        assert (price["amount"], price["label"]) == (259.0, "页面售价")
        _, _, unrelated = links._page_metadata(data, "text/html", "https://shop.example/page/productDetail")
        assert unrelated is None


@pytest.mark.parametrize(
    "url",
    [
        "https://shop.example/page/productDetail",
        "https://fast.dewu.com/home",
        "https://fast.dewu.com.evil.example/page/productDetail",
    ],
)
async def test_dewu_carousel_adapter_only_reads_the_public_detail_page(url):
    title, images = links._metadata(
        b'<img class="cat_image _carouselImg_abc_19" src="https://cdn.example/picture.jpg">', "text/html", url
    )
    assert images == []


async def test_dewu_empty_desktop_page_does_not_import_banner_or_app_qr(suite, network):
    network.routes[("www.dewu.com", "/product-detail.html")] = (
        200,
        {"Content-Type": "text/html"},
        b'<img src="https://cdn.dewu.com/banner.png"><img src="https://cdn.dewu.com/qr.png">'
        b'<script id="__NEXT_DATA__" type="application/json">{"productDetail":{"detail":{}}}</script>',
    )
    response = await suite.client.post(
        "/api/import/preview", json={"text": "https://www.dewu.com/product-detail.html?spuId=123"}
    )
    assert response.status_code == 422
    assert response.json()["detail"] == links.DEWU_NO_IMAGES
    assert len(network.requests) == 1
    assert suite.store.read()["items"] == []


async def test_relative_image_urls_and_malformed_json_do_not_break_og_fallback(suite, network):
    page(
        network,
        """<script type="application/ld+json">{"@type":null}</script>
      <script type="application/ld+json">invalid</script><meta property="og:title" content="春季 &amp; 夏季">
      <meta property="og:image" content="../shirt.png">""",
        "/catalog/product",
    )
    image(network)
    result = await preview(suite, "https://shop.example/catalog/product")
    assert result["title"] == "春季 & 夏季" and len(result["images"]) == 1


async def test_broken_and_internal_candidate_images_are_skipped(suite, network):
    page(
        network,
        """<meta property="og:image" content="http://127.0.0.1/private">
      <meta property="og:image" content="/missing.png"><meta property="og:image" content="/shirt.png">""",
    )
    image(network)
    result = await preview(suite)
    assert len(result["images"]) == 1
    assert all(request.headers["host"] == "shop.example" for request in network.requests)


@pytest.mark.parametrize("provider", ["openai", "compatible", "ollama", "codex"])
async def test_link_import_reuses_background_removal_and_all_recognition_providers(
    suite, network, monkeypatch, provider
):
    image(network)
    recognized = {"name": "识别的蓝色短袖", "category": "top", "colors": ["蓝色"], "tags": ["短袖"]}
    completion = AsyncMock(return_value=json.dumps(recognized))
    describe = AsyncMock(return_value=recognized)
    monkeypatch.setattr(ai, "completion", completion)
    monkeypatch.setattr(host_vision, "describe", describe)
    monkeypatch.setattr(host_vision, "available", lambda: True)
    monkeypatch.setattr(suite.app.state.images, "_extract", lambda img: img.copy())
    if provider == "codex":
        assert (await suite.client.put("/api/ai/settings", json={"provider": provider})).status_code == 200
        suite.store.update(
            lambda state: state["assistant_sessions"].append(
                {
                    "token_hash": digest("synthetic"),
                    "provider": "codex",
                    "client_name": "Codex",
                    "expires_at": time.time() + 300,
                    "verified_at": time.time(),
                }
            )
        )
        assert (await suite.client.put("/api/ai/automatic-vision", json={"enabled": True})).status_code == 200
    else:
        response = await suite.client.put(
            "/api/ai/settings",
            json={
                "provider": provider,
                "base_url": "http://localhost:11434/v1" if provider == "ollama" else "https://ai.example/v1",
                "vision_model": "vision",
                "text_model": "text",
                "api_key": "synthetic-key",
            },
        )
        assert response.status_code == 200
    result = await preview(suite, "https://shop.example/shirt.png")
    response = await suite.client.post(
        "/api/import/items", json=selection(result, auto_analyze=True, remove_background=True)
    )
    assert response.status_code == 200
    item = suite.store.read()["items"][0]
    assert item["name"] == recognized["name"] and item["ai_status"] == "review"
    assert item["confirmed"] is False and item["background_status"] == "completed"
    assert item["image_url"] != item["original_url"] and "商品来源" in item["notes"]
    assert describe.await_count == (1 if provider == "codex" else 0)
    assert completion.await_count == (0 if provider == "codex" else 1)


async def test_background_failure_keeps_photo_and_can_retry_after_import_failure(suite, network, monkeypatch):
    image(network)
    result = await preview(suite, "https://shop.example/shirt.png")
    importer = suite.app.state.import_photo
    failed = AsyncMock(side_effect=HTTPException(422, "暂未导入"))
    monkeypatch.setattr(suite.app.state, "import_photo", failed)
    assert (await suite.client.post("/api/import/items", json=selection(result))).status_code == 422
    monkeypatch.setattr(suite.app.state, "import_photo", importer)
    response = await suite.client.post("/api/import/items", json=selection(result, remove_background=True))
    assert response.status_code == 200
    assert response.json()["warnings"] and response.json()["items"][0]["background_status"] == "failed"
    assert len(suite.store.read()["items"]) == 1


async def test_concurrent_confirm_cannot_import_same_preview_twice(suite, network, monkeypatch):
    image(network)
    result = await preview(suite, "https://shop.example/shirt.png")
    started, finish = asyncio.Event(), asyncio.Event()
    importer = suite.app.state.import_photo

    async def waiting(*args, **kwargs):
        started.set()
        await finish.wait()
        return await importer(*args, **kwargs)

    monkeypatch.setattr(suite.app.state, "import_photo", waiting)
    task = asyncio.create_task(suite.client.post("/api/import/items", json=selection(result)))
    try:
        await asyncio.wait_for(started.wait(), 3)
        assert (await suite.client.post("/api/import/items", json=selection(result))).status_code == 409
        finish.set()
        assert (await task).status_code == 200
        assert len(suite.store.read()["items"]) == 1
    finally:
        finish.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_expiry_capacity_and_exact_cached_image_selection(suite, network, monkeypatch):
    image(network)
    result = await preview(suite, "https://shop.example/shirt.png")
    assert (
        await suite.client.post("/api/import/items", json=selection(result, image_id="0" * 16))
    ).status_code == 404
    assert (
        await suite.client.post(
            "/api/import/items", json={**selection(result), "url": "https://evil.example"}
        )
    ).status_code == 422
    suite.app.state.product_previews.previews[result["preview_id"]]["expires_at"] = 0
    assert (await suite.client.get(result["images"][0]["url"])).status_code == 410
    assert (await suite.client.post("/api/import/items", json=selection(result))).status_code == 410
    monkeypatch.setattr(links, "CACHE_BYTES", 1)
    assert (
        await suite.client.post("/api/import/preview", json={"text": "https://shop.example/shirt.png"})
    ).status_code == 429
    assert suite.app.state.product_previews.previews == {}


async def test_auth_origin_and_assistant_boundaries_prevent_remote_fetch(suite, network):
    headers = {"Authorization": "Bearer synthetic-token"}
    suite.store.update(
        lambda state: state["assistant_sessions"].append(
            {"token_hash": digest("synthetic-token"), "expires_at": time.time() + 60}
        )
    )
    routes = [
        ("POST", "/api/import/preview", {"text": "https://shop.example/product"}),
        ("POST", "/api/import/items", {"preview_id": "0" * 32, "image_id": "0" * 16}),
        ("GET", "/api/import/preview/fake/images/fake", None),
    ]
    for method, path, body in routes:
        assert (await suite.client.request(method, path, json=body, headers=headers)).status_code == 403
    assert (
        await suite.client.post(
            "/api/import/preview",
            json={"text": "https://shop.example/product"},
            headers={"Origin": "https://other.example"},
        )
    ).status_code == 403
    suite.client.cookies.clear()
    assert (
        await suite.client.post("/api/import/preview", json={"text": "https://shop.example/product"})
    ).status_code == 401
    assert network.requests == []


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost/",
        "https://localhost./",
        "http://127.0.0.1/",
        "http://10.0.0.1/",
        "http://169.254.169.254/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[64:ff9b::7f00:1]/",
        "https://168.63.129.16/",
        "https://user:password@shop.example/",
        "https://shop.example\\@127.0.0.1/",
        "https://shop.example:8080/",
        "file:///etc/passwd",
        "https://shop.example/\x00",
    ],
)
async def test_unsafe_urls_are_rejected_without_network(network, url):
    with pytest.raises(HTTPException):
        await links._fetch(url, links.IMAGE_BYTES)
    assert network.requests == []


async def test_dns_rebinding_mixed_answers_and_redirects_cannot_reach_private_addresses(network):
    network.resolver.return_value.append((socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 443)))
    with pytest.raises(HTTPException):
        await links._fetch("https://shop.example/product", links.IMAGE_BYTES)
    assert network.requests == []
    network.resolver.return_value = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
    network.routes[("shop.example", "/product")] = (302, {"Location": "http://127.0.0.1/private"}, b"")
    with pytest.raises(HTTPException):
        await links._fetch("https://shop.example/product", links.IMAGE_BYTES)
    assert len(network.requests) == 1


async def test_public_redirects_pin_each_host_without_cookies_or_credentials(network):
    network.routes[("shop.example", "/product")] = (
        302,
        {"Location": "/next", "Set-Cookie": "secret=remote"},
        b"",
    )
    network.routes[("shop.example", "/next")] = (302, {"Location": "https://cdn.example/shirt.png"}, b"")
    image(network, domain="cdn.example")
    data, kind, final = await links._fetch("https://shop.example/product", links.IMAGE_BYTES)
    assert data == picture() and kind == "image/png" and final == "https://cdn.example/shirt.png"
    assert network.resolver.await_count == 3
    for request in network.requests:
        assert not any(key in request.headers for key in ("Cookie", "Authorization", "Referer"))
        assert request.headers["accept-encoding"] == "identity"
    assert all(
        client["trust_env"] is False and client["follow_redirects"] is False for client in network.clients
    )


class Chunks(httpx.AsyncByteStream):
    async def __aiter__(self):
        for _ in range(4):
            yield b"x" * 50


@pytest.mark.parametrize("mode", ["declared", "stream", "compression", "redirect_limit", "login"])
async def test_fetch_bounds_and_login_fail_with_readable_errors(network, mode):
    if mode == "declared":
        network.routes[("shop.example", "/product")] = (200, {"Content-Length": "999999999"}, b"")
    elif mode == "stream":
        network.routes[("shop.example", "/product")] = httpx.Response(200, stream=Chunks())
    elif mode == "compression":
        network.routes[("shop.example", "/product")] = (
            200,
            {"Content-Encoding": "gzip"},
            gzip.compress(b"x" * 100),
        )
    elif mode == "redirect_limit":
        network.routes[("shop.example", "/product")] = (302, {"Location": "/product"}, b"")
    else:
        network.routes[("shop.example", "/product")] = (403, {}, b"login required")
    with pytest.raises(HTTPException) as error:
        await links._fetch("https://shop.example/product", 100)
    assert error.value.status_code == 422 and "截图" in error.value.detail
    assert len(network.requests) <= 4


async def test_preview_rate_limit_and_missing_metadata(suite, network):
    page(network, "<title>请登录</title>")
    for _ in range(6):
        response = await suite.client.post(
            "/api/import/preview", json={"text": "https://shop.example/product"}
        )
        assert response.status_code == 422 and "截图" in response.json()["detail"]
    assert (
        await suite.client.post("/api/import/preview", json={"text": "https://shop.example/product"})
    ).status_code == 429
    assert suite.app.state.product_previews.active == 0


async def test_page_title_does_not_accumulate_svg_titles():
    title, _ = links._metadata(
        b"<html><head><title>Organic Cotton T-Shirt</title></head><body><svg><title>Visa</title></svg>"
        b"<svg><title>Apple Pay</title></svg></body></html>",
        "text/html",
        "https://shop.example/",
    )
    assert title == "Organic Cotton T-Shirt"


@pytest.mark.parametrize("length", ["2" * 5000, "\u00b2", "-1"], ids=["long", "non-ascii", "negative"])
async def test_invalid_content_lengths_fail_without_500(network, length):
    response = httpx.Response(200, content=b"image")
    response.headers = httpx.Headers(
        [(b"content-type", b"image/png"), (b"content-length", length.encode("latin-1"))]
    )
    network.routes[("shop.example", "/product")] = response
    with pytest.raises(HTTPException) as failure:
        await links._fetch("https://shop.example/product", 100)
    assert failure.value.status_code == 422


async def test_consumed_previews_do_not_exhaust_pending_preview_capacity():
    cache = links.PreviewCache()
    for _ in range(12):
        result = cache.save("衬衫", "https://shop.example/product", {"1" * 16: b"image"})
        cache.get(result["preview_id"], "1" * 16, consume=True)
        cache.finish(result["preview_id"], True)
    assert len(cache.previews) == 12
    assert all(not value["images"] for value in cache.previews.values())
    with pytest.raises(HTTPException) as failure:
        cache.get(result["preview_id"], "1" * 16, consume=True)
    assert failure.value.status_code == 409


async def test_cancelled_image_import_waits_for_worker_and_removes_uncommitted_files(suite, monkeypatch):
    started, finish = threading.Event(), threading.Event()
    original = suite.app.state.images.prepare

    def prepare(*args):
        result = original(*args)
        started.set()
        assert finish.wait(3)
        return result

    monkeypatch.setattr(suite.app.state.images, "prepare", prepare)
    task = asyncio.create_task(
        suite.app.state.import_photo(
            picture(),
            "衬衫",
            False,
            False,
            BackgroundTasks(),
            access="browser",
        )
    )
    try:
        assert await asyncio.to_thread(started.wait, 3)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert suite.store.read()["items"] == []
        assert list(suite.app.state.images.root.iterdir()) == []
    finally:
        finish.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def fake_rows(*addresses):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443)) for address in addresses]


def doh(network, **changes):
    def answer(request):
        kind = int(request.url.params["type"])
        body = {
            "Status": 0,
            "Question": [{"name": request.url.params["name"], "type": kind}],
            "Answer": [
                {
                    "name": "shop.example",
                    "type": kind,
                    "data": "93.184.216.34" if kind == 1 else "2606:4700::6810:1",
                }
            ],
            **changes,
        }
        return httpx.Response(200, json=body)

    network.routes[("cloudflare-dns.com", "/dns-query")] = answer


async def test_fake_ip_proxy_uses_fixed_verified_doh_then_pins_real_public_address(network):
    network.resolver.return_value = fake_rows("198.18.0.4", "198.19.1.2")
    doh(network)
    image(network)
    data, _, _ = await links._fetch("https://shop.example/shirt.png", links.IMAGE_BYTES)
    assert data == picture()
    dns_requests = [request for request in network.requests if request.url.path == "/dns-query"]
    assert len(dns_requests) == 2
    assert {request.url.params["type"] for request in dns_requests} == {"1", "28"}
    for request in dns_requests:
        assert request.url.host == "1.1.1.1" and request.url.scheme == "https"
        assert request.extensions["sni_hostname"] == "cloudflare-dns.com"
        assert request.headers["host"] == "cloudflare-dns.com"
        assert request.headers["accept"] == "application/dns-json"
        assert "cookie" not in request.headers and "authorization" not in request.headers
    assert network.requests[-1].url.host == "93.184.216.34"
    assert network.requests[-1].headers["host"] == "shop.example"


@pytest.mark.parametrize(
    "addresses",
    [[], ["10.0.0.1"], ["93.184.216.34"], ["198.18.0.1", "10.0.0.1"], ["198.18.0.1", "93.184.216.34"]],
)
async def test_public_dns_never_overrides_non_fake_or_mixed_dns_answers(network, addresses):
    rows = fake_rows(*addresses)
    assert await public_dns.resolve_fake_ip("shop.example", rows) == rows
    assert network.requests == []


@pytest.mark.parametrize(
    "body",
    [
        {"Status": 3},
        {"Question": [{"name": "different.example", "type": 1}]},
        {"Answer": [{"type": 1, "data": "127.0.0.1"}]},
        {"Answer": [{"type": 28, "data": "::ffff:169.254.169.254"}]},
        {"Answer": []},
    ],
)
async def test_doh_rejects_mismatched_empty_or_private_answers(network, body):
    doh(network, **body)
    with pytest.raises(public_dns.PublicDNSError):
        await public_dns.resolve_fake_ip("shop.example", fake_rows("198.18.0.4"))
    assert all(request.url.host == "1.1.1.1" for request in network.requests)


@pytest.mark.parametrize("failure", ["redirect", "oversized", "timeout"])
async def test_doh_limits_response_and_refuses_redirects(network, monkeypatch, failure):
    if failure == "redirect":
        network.routes[("cloudflare-dns.com", "/dns-query")] = (302, {"Location": "http://127.0.0.1/"}, b"")
    elif failure == "oversized":
        network.routes[("cloudflare-dns.com", "/dns-query")] = (
            200,
            {},
            b"x" * (public_dns.MAX_DNS_BYTES + 1),
        )
    else:

        async def timeout(*args):
            raise httpx.ReadTimeout("synthetic timeout")

        monkeypatch.setattr(public_dns, "_query", timeout)
    with pytest.raises(public_dns.PublicDNSError):
        await public_dns.resolve_fake_ip("shop.example", fake_rows("198.18.0.4"))
    assert all(request.url.host == "1.1.1.1" for request in network.requests)


@pytest.mark.parametrize(
    "host,markup",
    [
        ("pcdetail.taobao.com", '<img class="mainPic--zxTtQs0P" src="https://cdn.example/shirt.png">'),
        ("item.taobao.com", '<img id="J_ImgBooth" src="https://cdn.example/shirt.png">'),
        ("detail.tmall.com", '<img class="mainPic--zxTtQs0P" src="https://cdn.example/shirt.png">'),
        ("item.m.jd.com", '<img id="firstImg" src="https://cdn.example/shirt.png">'),
        ("item.jd.com", '<img id="spec-img" src="https://cdn.example/shirt.png">'),
        ("m.pinduoduo.com", '<img class="goods-image" src="https://cdn.example/shirt.png">'),
    ],
)
async def test_domestic_product_images_are_selected_without_store_icons_or_recommendations(
    suite, network, host, markup
):
    network.routes[(host, "/product")] = (
        200,
        {"Content-Type": "text/html"},
        (
            '<head><title>蓝色短袖</title></head><img class="shopIconImg--icon" src="/logo.png">'
            + markup
            + '<img class="cardPic--recommendation" src="/unrelated.png">'
        ).encode(),
    )
    image(network, domain="cdn.example")
    result = await preview(suite, f"https://{host}/product")
    assert result["title"] == "蓝色短袖" and len(result["images"]) == 1
    assert all(request.url.path not in {"/logo.png", "/unrelated.png"} for request in network.requests)
    _, images = links._metadata(markup.encode(), "text/html", "https://other.example/product")
    assert images == []


async def test_jd_desktop_uses_only_published_same_product_mobile_page(suite, network):
    network.routes[("item.jd.com", "/12345.html")] = (
        200,
        {"Content-Type": "text/html"},
        b"""
      <head><title>JD</title><meta http-equiv="mobile-agent" content="format=xhtml; url=//item.m.jd.com/product/12345.html"></head>""",
    )
    network.routes[("item.m.jd.com", "/product/12345.html")] = (
        200,
        {"Content-Type": "text/html"},
        '<head><title>蓝色短袖</title></head><img id="firstImg" src="https://cdn.example/shirt.png">'.encode(),
    )
    image(network, domain="cdn.example")
    result = await preview(suite, "https://item.jd.com/12345.html")
    assert result["source_url"] == "https://item.m.jd.com/product/12345.html"
    assert len(result["images"]) == 1 and result["title"] == "蓝色短袖"
    for url in (
        "http://127.0.0.1/private",
        "https://other.example/product/12345.html",
        "https://item.m.jd.com/product/999.html",
    ):
        html = f'<meta http-equiv="mobile-agent" content="format=xhtml; url={url}">'.encode()
        assert links._published_mobile_page(html, "https://item.jd.com/12345.html") is None
    assert (
        links._published_mobile_page(
            network.routes[("item.jd.com", "/12345.html")][2], "https://other.example/12345.html"
        )
        is None
    )


def capture_body(**changes):
    return {
        "version": 1,
        "title": "采集的蓝色衬衫",
        "source_url": "https://detail.tmall.com/item.htm?id=123",
        "image": "data:image/png;base64," + base64.b64encode(picture()).decode(),
        **changes,
    }


async def test_visible_browser_capture_creates_preview_and_imports_without_network(suite, network):
    response = await suite.client.post("/api/import/capture", json=capture_body())
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["title"] == "采集的蓝色衬衫" and len(result["images"]) == 1
    assert suite.store.read()["items"] == []
    visible = await suite.client.get(result["images"][0]["url"])
    assert visible.status_code == 200 and Image.open(io.BytesIO(visible.content)).format == "JPEG"
    imported = await suite.client.post("/api/import/items", json=selection(result))
    assert imported.status_code == 200 and imported.json()["items"][0]["confirmed"] is False
    item = suite.store.read()["items"][0]
    assert item["name"] == "采集的蓝色衬衫" and "detail.tmall.com/item.htm?id=123" in item["notes"]
    assert network.requests == []
    network.resolver.assert_not_awaited()
    assert (await suite.client.post("/api/import/items", json=selection(result))).status_code == 409


@pytest.mark.parametrize(
    "changes",
    [
        {"version": True},
        {"version": "1"},
        {"version": 2},
        {"title": "x" * 121},
        {"source_url": "https://127.0.0.1/private"},
        {"source_url": "http://localhost/"},
        {"source_url": "https://user:password@tmall.com/"},
        {"source_url": "https://shop.example/" + "a" * 2600},
        {"image": "data:image/svg+xml;base64,PHN2Zy8+"},
        {"image": "data:image/png;base64,not_valid%"},
        {"image": "data:image/png;base64," + base64.b64encode(b"not an image").decode()},
        {"image": "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\ncorrupt").decode()},
        {"image": "data:image/png;base64," + "A" * (4 * 1024 * 1024)},
    ],
    ids=[
        "bool-version",
        "string-version",
        "unknown-version",
        "long-title",
        "private-source",
        "localhost-source",
        "credential-source",
        "long-source",
        "svg",
        "bad-base64",
        "fake-image",
        "corrupt-image",
        "oversized-image",
    ],
)
async def test_capture_rejects_invalid_content_and_sources_without_network(suite, network, changes):
    response = await suite.client.post("/api/import/capture", json=capture_body(**changes))
    assert response.status_code == 422
    assert suite.store.read()["items"] == [] and suite.app.state.product_previews.previews == {}
    assert network.requests == []
    network.resolver.assert_not_awaited()


async def test_capture_validates_pixels_and_browser_origin(suite, network, monkeypatch):
    from server import images

    body = capture_body()
    monkeypatch.setattr(images, "MAX_PIXELS", 1)
    response = await suite.client.post("/api/import/capture", json=body)
    assert response.status_code == 422
    monkeypatch.setattr(images, "MAX_PIXELS", 25_000_000)
    suite.store.update(
        lambda state: state["assistant_sessions"].append(
            {"token_hash": digest("capture-token"), "expires_at": time.time() + 60}
        )
    )
    assert (
        await suite.client.post(
            "/api/import/capture", json=body, headers={"Authorization": "Bearer capture-token"}
        )
    ).status_code == 403
    assert (
        await suite.client.post("/api/import/capture", json=body, headers={"Origin": "https://evil.example"})
    ).status_code == 403
    suite.client.cookies.clear()
    assert (await suite.client.post("/api/import/capture", json=body)).status_code == 401
    assert network.requests == []


async def test_jd_public_mobile_url_mapping_is_limited_to_exact_host_and_numeric_sku(suite, network):
    source = "https://item.jd.com/12345.html?tracking=share"
    target = "https://item.m.jd.com/product/12345.html"
    assert links._product_page_url(source) == target
    network.routes[("item.m.jd.com", "/product/12345.html")] = (
        200,
        {"Content-Type": "text/html"},
        '<head><title>同一件衬衫</title></head><img id="firstImg" src="https://cdn.example/shirt.png">'.encode(),
    )
    image(network, domain="cdn.example")
    result = await preview(suite, source)
    assert result["source_url"] == target and result["title"] == "同一件衬衫"
    assert all(request.headers["host"] != "item.jd.com" for request in network.requests)
    for value in (
        "https://item.jd.com.evil.example/12345.html",
        "https://other.example/12345.html",
        "https://item.jd.com/not-product.html",
        "https://item.jd.com/product/12345.html",
        "https://item.jd.com/１２３.html",
    ):
        assert links._product_page_url(value) == value


async def test_capture_tool_download_contains_only_fixed_runtime_files(suite, monkeypatch, tmp_path):
    bundle = tmp_path / "capture-extension"
    bundle.mkdir()
    expected = {}
    for name in (*links.CAPTURE_RUNTIME, "README.md", "LICENSE"):
        content = (name + " synthetic runtime").encode()
        (bundle / name).write_bytes(content)
        expected["yijian-browser-capture/" + name] = content
    (bundle / ".env").write_text("private-key")
    (bundle / "tests.js").write_text("test-only")
    (bundle / "snapshot.png").write_bytes(b"private capture")
    monkeypatch.setattr(links, "CAPTURE_ROOT", bundle)
    response = await suite.client.get("/api/import/capture-extension?path=../../.env")
    assert response.status_code == 200 and response.headers["content-type"] == "application/zip"
    assert "0.1.0.zip" in response.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert set(archive.namelist()) == set(expected)
        assert all(archive.read(name) == content for name, content in expected.items())


async def test_capture_tool_download_requires_browser_and_complete_runtime(suite, monkeypatch, tmp_path):
    response = await suite.client.get("/api/import/capture-extension")
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        manifest = json.loads(archive.read("yijian-browser-capture/manifest.json"))
        assert manifest["version"] == "0.1.0" and manifest["manifest_version"] == 3
    suite.store.update(
        lambda state: state["assistant_sessions"].append(
            {
                "token_hash": digest("download-token"),
                "expires_at": time.time() + 60,
            }
        )
    )
    assert (
        await suite.client.get(
            "/api/import/capture-extension", headers={"Authorization": "Bearer download-token"}
        )
    ).status_code == 403
    monkeypatch.setattr(links, "CAPTURE_ROOT", tmp_path)
    assert (await suite.client.get("/api/import/capture-extension")).status_code == 503
    suite.client.cookies.clear()
    assert (await suite.client.get("/api/import/capture-extension")).status_code == 401
