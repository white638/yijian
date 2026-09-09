"""Install the built-in photo processor and verify its app-local resources."""

import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from urllib.request import urlopen
from uuid import uuid4

MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx"
MODEL_SHA256 = "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"
MODEL_MAX_BYTES = 16 * 1024 * 1024


def valid(path: Path) -> bool:
    if not path.is_file() or path.is_symlink():
        return False
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest() == MODEL_SHA256


def prepare(cache: Path, install: bool = True) -> Path:
    if any(importlib.util.find_spec(name) is None for name in ("rembg", "onnxruntime")):
        if not install:
            raise RuntimeError("图片处理依赖尚未安装")
        subprocess.run([sys.executable, "-m", "pip", "install", "rembg[cpu]==2.0.81"], check=True)
    cache = cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    for existing in (cache / "u2netp.onnx", cache / "models/u2netp/u2netp.onnx"):
        if valid(existing):
            return existing
    target = cache / "u2netp.onnx"
    temporary = cache / f".prepare-{uuid4().hex}.tmp"
    try:
        with urlopen(MODEL_URL, timeout=120) as response, temporary.open("xb") as output:
            if not response.geturl().startswith("https://"):
                raise RuntimeError("图片处理资源地址无效")
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > MODEL_MAX_BYTES:
                    raise RuntimeError("图片处理资源超出大小限制")
                output.write(chunk)
        if not valid(temporary):
            raise RuntimeError("图片处理资源校验失败")
        os.replace(temporary, target)
        return target
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    default_cache = (
        os.environ.get("YIJIAN_MODEL_CACHE")
        or os.environ.get("U2NET_HOME")
        or os.environ.get("REMBG_HOME")
        or str(Path(__file__).resolve().parents[1] / ".local/data/models")
    )
    parser.add_argument("--cache", type=Path, default=Path(default_cache))
    parser.add_argument("--no-install", action="store_true")
    args = parser.parse_args()
    try:
        prepare(args.cache, not args.no_install)
        print("内置图片处理已就绪。")
        return 0
    except Exception as error:
        print(f"图片处理准备未完成：{error}。仍可上传并保留原图。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
