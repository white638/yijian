"""Prepare and run a personal Yijian workspace."""

import argparse
import hashlib
import hmac
import os
from pathlib import Path
import shutil
import secrets
import subprocess
import sys
import time
import venv
import webbrowser
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]


def run(arguments, **kwargs):
    subprocess.run([str(value) for value in arguments], check=True, cwd=ROOT, **kwargs)


def main():
    parser = argparse.ArgumentParser(description="启动衣间个人衣橱")
    parser.add_argument("--port", type=int, default=3110)
    parser.add_argument("--data", type=Path, default=ROOT / ".local/data")
    parser.add_argument("--no-setup", action="store_true", help="使用当前已安装的 Python 环境和已构建网页")
    parser.add_argument("--no-browser", action="store_true", help="只显示本机入口，不自动打开浏览器")
    parser.add_argument(
        "--skip-image-setup", action="store_true", help="暂时使用原图，稍后重新启动以准备图片组件"
    )
    arguments = parser.parse_args()
    if not 1024 <= arguments.port <= 65535:
        parser.error("端口必须介于 1024 与 65535 之间")
    if sys.version_info < (3, 11):
        parser.error("需要 Python 3.11 或更新版本")
    data = arguments.data.resolve()
    data.mkdir(parents=True, exist_ok=True)
    python = Path(sys.executable)
    if not arguments.no_setup:
        environment = ROOT / ".venv"
        python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if not python.exists():
            print("正在准备应用运行环境…", flush=True)
            venv.EnvBuilder(with_pip=True).create(environment)
        fingerprint = hashlib.sha256((ROOT / "requirements.txt").read_bytes()).hexdigest()
        receipt = environment / ".wardrobe-dependencies"
        if not receipt.exists() or receipt.read_text().strip() != fingerprint:
            run([python, "-m", "pip", "install", "-r", ROOT / "requirements.txt"])
            receipt.write_text(fingerprint)
        build = ROOT / "web/dist/index.html"
        sources = [path for path in (ROOT / "web/src").rglob("*") if path.is_file()]
        sources.extend(
            ROOT / "web" / name
            for name in ("package.json", "package-lock.json", "index.html", "vite.config.ts")
        )
        if not build.exists() or any(
            path.exists() and path.stat().st_mtime > build.stat().st_mtime for path in sources
        ):
            npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
            if not npm:
                parser.error("请安装 Node.js 后重新运行；网页构建完成后启动只需要 Python。")
            print("正在准备衣间界面…", flush=True)
            run([npm, "ci", "--prefix", ROOT / "web"])
            run([npm, "run", "build", "--prefix", ROOT / "web"])
    if not (ROOT / "web/dist/index.html").is_file():
        parser.error("网页尚未构建，请先完成安装。")
    cache = Path(os.environ.get("YIJIAN_MODEL_CACHE", data / "models")).resolve()
    if not arguments.skip_image_setup:
        print("正在准备自动去背景组件…", flush=True)
        try:
            run([python, ROOT / "scripts/prepare_images.py", "--cache", cache])
        except subprocess.CalledProcessError:
            print("图片组件暂未就绪，仍可上传原图和使用衣橱。下次启动会再次准备。", flush=True)
    environment = {
        **os.environ,
        "YIJIAN_DATA": str(data),
        "YIJIAN_MODEL_CACHE": str(cache),
        "PYTHONUTF8": "1",
        "YIJIAN_LAUNCH_NONCE": secrets.token_urlsafe(32),
    }
    instance = hashlib.sha256(environment["YIJIAN_LAUNCH_NONCE"].encode()).hexdigest()
    opener = build_opener(ProxyHandler({}))
    process = None
    try:
        process = subprocess.Popen(
            [
                str(python),
                "-m",
                "uvicorn",
                "server.main:create_app",
                "--factory",
                "--host",
                "127.0.0.1",
                "--port",
                str(arguments.port),
            ],
            env=environment,
            cwd=ROOT,
        )
        for _ in range(100):
            if process.poll() is not None:
                parser.error("服务未能启动，请检查端口是否被占用。")
            try:
                with opener.open(f"http://127.0.0.1:{arguments.port}/api/health", timeout=1) as health:
                    if health.status == 200:
                        reported = health.headers.get("X-Yijian-Instance", "")
                        if not hmac.compare_digest(reported.encode(), instance.encode()):
                            parser.error("端口已被其他服务占用，请更换端口后重新启动。")
                        if process.poll() is not None:
                            parser.error("服务未能启动，请检查终端中的提示。")
                        break
            except OSError:
                time.sleep(0.2)
        else:
            parser.error("服务启动超时，请检查终端中的提示。")
        command = "from server.store import Store; from server.auth import bootstrap_key; import os; print(bootstrap_key(Store(os.environ['YIJIAN_DATA'])))"
        code = subprocess.check_output(
            [str(python), "-c", command], cwd=ROOT, env=environment, text=True
        ).strip()
        url = f"http://127.0.0.1:{arguments.port}/#open={code}"
        print(f"衣间本机入口：{url}", flush=True)
        if not arguments.no_browser:
            webbrowser.open(url)
        while process.poll() is None:
            time.sleep(0.2)
        if process.wait() != 0:
            parser.error("服务异常退出，请检查终端中的提示。")
    except KeyboardInterrupt:
        pass
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    main()
