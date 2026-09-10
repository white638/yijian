"""Local photo assets with immutable originals and optional foreground extraction."""

import hashlib
import importlib.util
from io import BytesIO
import logging
import os
from pathlib import Path
import re
import threading
from uuid import uuid4

from PIL import Image, ImageOps, UnidentifiedImageError

logger = logging.getLogger(__name__)
MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 25_000_000
MAX_SIDE = 2400
MODEL_SHA256 = "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"
_NAME = re.compile(r"[a-f0-9]{32}-(?:original|cutout|beautified)\.jpg\Z")
_INFERENCE = threading.Lock()
_SESSIONS = {}


def model_cache(default: Path) -> Path:
    return Path(
        os.environ.get("YIJIAN_MODEL_CACHE")
        or os.environ.get("U2NET_HOME")
        or os.environ.get("REMBG_HOME")
        or default
    ).resolve()


def model_file(cache: Path) -> Path | None:
    for path in (cache / "u2netp.onnx", cache / "models/u2netp/u2netp.onnx"):
        try:
            if path.is_file() and not path.is_symlink() and verified_model(path):
                return path
        except OSError:
            continue
    return None


def verified_model(path: Path | None) -> bool:
    if path is None:
        return False
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest() == MODEL_SHA256


def _local_session(path: Path):
    if not verified_model(path):
        raise RuntimeError("图片处理资源尚未就绪")
    key = str(path.resolve())
    if key not in _SESSIONS:
        import onnxruntime
        from rembg.sessions.u2netp import U2netpSession

        # A pinned local loader prevents the dependency from downloading during a request.
        class InstalledSession(U2netpSession):
            @classmethod
            def download_models(cls, *args, **kwargs):
                return str(path)

        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        _SESSIONS[key] = InstalledSession("u2netp", options, providers=["CPUExecutionProvider"])
    return _SESSIONS[key]


class ImagePipeline:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.cache = model_cache(self.root.parent / "models")

    def resolve(self, filename: str) -> Path:
        if not isinstance(filename, str) or not _NAME.fullmatch(filename):
            raise ValueError("图片名称无效")
        path = self.root / filename
        if path.is_symlink() or path.resolve().parent != self.root:
            raise ValueError("图片路径无效")
        return path

    def _original(self, url: str) -> Path:
        prefix = "/api/images/"
        if not isinstance(url, str) or not url.startswith(prefix):
            raise ValueError("原图地址无效")
        path = self.resolve(url.removeprefix(prefix))
        if not path.name.endswith("-original.jpg") or not path.is_file():
            raise ValueError("原图不存在")
        return path

    def features(self) -> dict:
        available = all(importlib.util.find_spec(name) is not None for name in ("rembg", "onnxruntime"))
        try:
            ready = available and verified_model(model_file(self.cache))
        except OSError:
            ready = False
        return {"background_removal": available, "background_removal_ready": ready}

    @staticmethod
    def _decode(content: bytes) -> Image.Image:
        if not content or len(content) > MAX_BYTES:
            raise ValueError("请选择不超过20MB的图片")
        try:
            with Image.open(BytesIO(content)) as source:
                if source.format not in {"JPEG", "PNG", "WEBP"}:
                    raise ValueError("支持JPEG、PNG和WebP图片")
                if source.width * source.height > MAX_PIXELS:
                    raise ValueError("图片分辨率过大，请先缩小图片")
                normalized = ImageOps.exif_transpose(source)
                normalized.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
                transparent = normalized.convert("RGBA")
                white = Image.new("RGBA", transparent.size, "white")
                return Image.alpha_composite(white, transparent).convert("RGB")
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
            raise ValueError("无法读取图片，请尝试其他图片文件") from error

    def _write(self, image: Image.Image, role: str) -> str:
        filename = f"{uuid4().hex}-{role}.jpg"
        target = self.resolve(filename)
        pending = self.root / f".{uuid4().hex}.tmp"
        try:
            with pending.open("xb") as handle:
                image.save(handle, format="JPEG", quality=93, optimize=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(pending, target)
        finally:
            pending.unlink(missing_ok=True)
        return "/api/images/" + filename

    def prepare(self, content: bytes, remove_background: bool = True) -> dict:
        image = self._decode(content)
        original_url = self._write(image, "original")
        result = {
            "image_url": original_url,
            "original_url": original_url,
            "background_status": "skipped",
            "width": image.width,
            "height": image.height,
        }
        if remove_background:
            result.update(self.cutout(original_url))
        return result

    def beautify(self, content: bytes) -> dict:
        image = self._decode(content)
        return {
            "beautified_url": self._write(image, "beautified"),
            "width": image.width,
            "height": image.height,
        }

    def _extract(self, image: Image.Image) -> Image.Image:
        from rembg import remove

        path = model_file(self.cache)
        if path is None:
            raise RuntimeError("图片处理组件暂不可用")
        with _INFERENCE:
            session = _local_session(path)
            foreground = remove(image, session=session).convert("RGBA")
        canvas = Image.new("RGBA", foreground.size, "white")
        return Image.alpha_composite(canvas, foreground).convert("RGB")

    def cutout(self, original_url: str) -> dict:
        original = self._original(original_url)
        with Image.open(original) as source:
            image = source.convert("RGB")
        result = {
            "image_url": original_url,
            "original_url": original_url,
            "background_status": "failed",
            "width": image.width,
            "height": image.height,
        }
        try:
            processed = self._extract(image)
            result["image_url"] = self._write(processed, "cutout")
            result["background_status"] = "completed"
        except Exception:
            logger.warning("图片背景处理未完成，已保留原图", exc_info=True)
        return result

    def restore(self, original_url: str) -> dict:
        path = self._original(original_url)
        with Image.open(path) as image:
            width, height = image.size
        return {
            "image_url": original_url,
            "original_url": original_url,
            "background_status": "skipped",
            "width": width,
            "height": height,
        }
