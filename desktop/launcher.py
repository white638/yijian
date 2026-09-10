from __future__ import annotations

import argparse
from http.cookiejar import CookieJar
import json
import logging
from logging.handlers import RotatingFileHandler
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import traceback
from urllib.request import HTTPCookieProcessor, ProxyHandler, build_opener

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from desktop.runtime import (
    DesktopError,
    InstanceLock,
    LocalService,
    VERSION,
    activate_existing,
    default_data_dir,
    prepare_bundled_model,
    private_json,
    read_json,
)


def bundle_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))


def show_error(message: str, *, dialog: bool) -> None:
    if sys.stderr is not None:
        print(message, file=sys.stderr, flush=True)
    if dialog and os.name == "nt":
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, "衣间", 0x10)


def record_startup_error(data: Path, error: Exception) -> None:
    try:
        directory = data / ".desktop"
        directory.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            directory / "startup.log", maxBytes=128 * 1024, backupCount=1, encoding="utf-8"
        )
        try:
            stack = "".join(traceback.format_tb(error.__traceback__))
            record = logging.LogRecord(
                "desktop", logging.ERROR, __file__, 0, type(error).__name__ + "\n" + stack, (), None
            )
            handler.emit(record)
        finally:
            handler.close()
    except OSError:
        pass


def smoke_http(service: LocalService) -> dict:
    opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))
    with opener.open(service.launch_url, timeout=5) as response:
        html = response.read(2 * 1024 * 1024).decode("utf-8")
        page_ok = response.status == 200 and 'id="root"' in html
    with opener.open(service.origin + "/api/state", timeout=5) as response:
        state = json.load(response)
        state_ok = response.status == 200 and isinstance(state.get("items"), list)
    if not page_ok or not state_ok:
        raise DesktopError("桌面自检未通过，请重新安装应用。")
    return {"ok": True, "mode": "service", "authenticated": True, "interface": True}


def run_window(service: LocalService, directory: Path, *, smoke: bool, exit_after: float | None) -> dict:
    try:
        import webview
    except ImportError:
        raise DesktopError("桌面窗口组件不完整，请使用完整的衣间安装包。") from None
    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["ALLOW_FILE_URLS"] = False
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    window = webview.create_window(
        "衣间",
        service.launch_url,
        width=1280,
        height=860,
        min_size=(900, 650),
        background_color="#faf9f7",
        text_select=True,
    )
    loaded, closed, watcher_done = threading.Event(), threading.Event(), threading.Event()
    result = {"ok": not smoke, "mode": "window"}
    window.events.loaded += loaded.set
    window.events.closed += closed.set

    def observe():
        started = time.monotonic()
        verified = False
        while not closed.wait(0.1):
            if not loaded.is_set() and time.monotonic() - started >= 45:
                result.update(
                    ok=False, error="桌面窗口加载超时，请确认 Microsoft Edge WebView2 可用后重新打开。"
                )
                window.destroy()
                return
            if service.process is not None and not service.process.is_alive():
                result.update(ok=False, error="本机服务已退出，请重新打开衣间。")
                window.destroy()
                return
            if service.activation.is_set():
                service.activation.clear()
                try:
                    window.restore()
                    window.show()
                except Exception:
                    if closed.is_set():
                        return
            if smoke and loaded.is_set() and not verified:
                try:
                    # evaluate_js wraps code in eval, which the application's CSP intentionally forbids.
                    value = window.run_js(
                        "(() => {"
                        "if (!window.__yijianDesktopCheck) {"
                        "window.__yijianDesktopCheck = 'pending';"
                        "fetch('/api/state', {credentials:'same-origin'})"
                        ".then(r => {window.__yijianDesktopCheck = r.ok ? 'ready' : 'failed';})"
                        ".catch(() => {window.__yijianDesktopCheck = 'failed';});"
                        "}"
                        "return {authenticated:window.__yijianDesktopCheck === 'ready',"
                        "interface:!!document.querySelector('#root button')};"
                        "})()"
                    )
                    if isinstance(value, dict):
                        verified = value.get("authenticated") is True and value.get("interface") is True
                        result.update(ok=verified, **value)
                except Exception:
                    result.update(ok=False, error="桌面界面未能完成加载。")
            if exit_after is not None and time.monotonic() - started >= exit_after:
                if smoke and not verified:
                    result.update(ok=False, error="桌面界面加载超时。")
                window.destroy()
                return

    def watch():
        try:
            observe()
        finally:
            watcher_done.set()

    try:
        webview.start(
            watch, gui="edgechromium", debug=False, private_mode=True, storage_path=str(directory / "webview")
        )
    except Exception:
        raise DesktopError(
            "桌面窗口无法打开。请确认已安装 Microsoft Edge WebView2，或重新运行衣间安装程序。"
        ) from None
    finally:
        closed.set()
        watcher_done.wait(2)
    if not result["ok"]:
        raise DesktopError(result.get("error", "桌面界面自检未通过。"))
    return result


def run(arguments) -> dict:
    temporary = (
        tempfile.TemporaryDirectory(prefix="yijian-desktop-check-")
        if arguments.smoke_test and arguments.data is None
        else None
    )
    data = Path(temporary.name if temporary else arguments.data or default_data_dir()).resolve()
    lock, service = None, None
    try:
        data.mkdir(parents=True, exist_ok=True)
        lock = InstanceLock(data)
        if not lock.acquire():
            if not arguments.smoke_test and activate_existing(lock.directory):
                return {"ok": True, "state": "existing_window"}
            raise DesktopError("衣间正在启动或退出，请稍后重新打开。")
        root = bundle_root()
        if not (root / "web/dist/index.html").is_file():
            raise DesktopError("衣间界面资源不完整，请重新安装应用。")
        model_ready = prepare_bundled_model(root, data)
        preferred = 0
        try:
            value = read_json(lock.directory / "config.json").get("port", 0)
            if type(value) is int and 1024 <= value <= 65535:
                preferred = value
        except (OSError, ValueError, DesktopError):
            pass
        service = LocalService(data, preferred)
        service.start()
        private_json(lock.directory / "instance.json", service.descriptor())
        private_json(lock.directory / "config.json", {"port": service.port})
        if arguments.smoke_test and not arguments.window:
            result = smoke_http(service)
        elif arguments.no_window:
            deadline = time.monotonic() + arguments.exit_after if arguments.exit_after else None
            while service.process.is_alive() and (deadline is None or time.monotonic() < deadline):
                time.sleep(0.1)
            result = {"ok": service.process.is_alive(), "mode": "service"}
        else:
            duration = arguments.exit_after or (30 if arguments.smoke_test else None)
            result = run_window(service, lock.directory, smoke=arguments.smoke_test, exit_after=duration)
        result.update(version=VERSION, model_ready=model_ready)
        return result
    finally:
        try:
            if service is not None:
                stopped = service.stop()
                if not stopped:
                    raise DesktopError("本机服务未能退出，请在任务管理器中关闭衣间后重试。")
        finally:
            if lock is not None:
                if lock.held:
                    (lock.directory / "instance.json").unlink(missing_ok=True)
                lock.close()
            if temporary is not None:
                temporary.cleanup()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="衣间桌面应用")
    parser.add_argument("--data", type=Path, help="使用指定的独立数据目录")
    parser.add_argument("--smoke-test", action="store_true", help="自检并退出；默认使用临时数据目录")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--window", action="store_true", help="自检时也打开真实桌面窗口")
    mode.add_argument("--no-window", action="store_true", help="只运行本机服务，供自动化验收使用")
    parser.add_argument("--exit-after", type=float, help="在指定秒数后关闭，供桌面验收使用")
    parser.add_argument("--result", type=Path, help="将不含凭据的自检结果保存为 JSON")
    arguments = parser.parse_args(argv)
    if arguments.exit_after is not None and not 1 <= arguments.exit_after <= 3600:
        parser.error("退出时间必须介于 1 与 3600 秒之间。")
    try:
        result = run(arguments)
        exit_code = 0
    except KeyboardInterrupt:
        result, exit_code = {"ok": True, "state": "closed"}, 0
    except Exception as error:
        if not arguments.smoke_test or arguments.data is not None:
            record_startup_error(Path(arguments.data or default_data_dir()).resolve(), error)
        message = (
            str(error)
            if isinstance(error, DesktopError)
            else "衣间启动未完成，请检查数据目录权限和磁盘空间后重试。"
        )
        show_error(message, dialog=not arguments.no_window and not arguments.smoke_test)
        result, exit_code = {"ok": False, "error": message}, 1
    if arguments.result:
        arguments.result.parent.mkdir(parents=True, exist_ok=True)
        private_json(arguments.result, result)
    if sys.stdout is not None:
        print(json.dumps(result, ensure_ascii=False), flush=True)
    return exit_code


if __name__ == "__main__":
    multiprocessing.freeze_support()
    raise SystemExit(main())
