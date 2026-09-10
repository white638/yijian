"""Exercise a frozen desktop installation using disposable wardrobe data."""

from __future__ import annotations

import argparse
from contextlib import ExitStack
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import zipfile

import httpx
from PIL import Image, ImageDraw


def stop(process):
    if process.poll() is None:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                timeout=10,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        else:
            process.terminate()
        process.wait(timeout=10)


def launch(executable: Path, data: Path, duration: int = 180):
    process = subprocess.Popen(
        [str(executable), "--data", str(data), "--no-window", "--exit-after", str(duration)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        cwd=executable.parent,
    )
    descriptor = data / ".desktop/instance.json"
    for _ in range(200):
        if process.poll() is not None:
            raise RuntimeError("Installed service failed to start")
        if descriptor.is_file():
            try:
                port = json.loads(descriptor.read_text(encoding="utf-8"))["port"]
                client = httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=90)
                code = (data / ".browser-key").read_text().strip()
                response = client.post("/api/session", json={"code": code})
                response.raise_for_status()
                return process, client
            except (OSError, ValueError, KeyError, httpx.HTTPError):
                pass
        time.sleep(0.1)
    process.terminate()
    process.wait(timeout=10)
    raise RuntimeError("Installed service startup timed out")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("--result", type=Path, required=True)
    args = parser.parse_args()
    executable = args.executable.resolve()
    processes, clients = [], []
    checks = {}
    try:
        with (
            tempfile.TemporaryDirectory(prefix="yijian-package-check-") as temporary,
            ExitStack() as teardown,
        ):
            data = Path(temporary) / "wardrobe"
            process, client = launch(executable, data, duration=75)
            processes.append(process)
            teardown.callback(stop, process)
            clients.append(client)
            state = client.get("/api/state").json()
            assert state["features"]["background_removal_ready"] is True
            checks["bundled_model"] = True
            image = Image.new("RGB", (480, 480), "#ded8cf")
            drawing = ImageDraw.Draw(image)
            drawing.polygon(
                [
                    (150, 70),
                    (90, 130),
                    (130, 200),
                    (155, 180),
                    (155, 390),
                    (325, 390),
                    (325, 180),
                    (350, 200),
                    (390, 130),
                    (330, 70),
                    (280, 85),
                    (200, 85),
                ],
                fill="#254981",
            )
            content = BytesIO()
            image.save(content, format="JPEG")
            response = client.post(
                "/api/items/upload",
                files={"files": ("fixture-shirt.jpg", content.getvalue(), "image/jpeg")},
                data={"remove_background": "true", "auto_analyze": "false"},
            )
            response.raise_for_status()
            uploaded = response.json()
            item = uploaded["items"][0]
            if uploaded["warnings"]:
                log = data / ".desktop/service.log"
                if log.is_file():
                    print(log.read_text(encoding="utf-8")[-10000:])
            assert not uploaded["warnings"], uploaded["warnings"]
            assert item["background_status"] == "completed", item["background_status"]
            assert item["image_url"] != item["original_url"]
            assert client.get(item["image_url"]).status_code == 200
            checks["upload_and_real_background_removal"] = True
            response = client.patch(
                "/api/items/" + item["id"],
                json={"name": "安装包验收上衣", "category": "top", "confirmed": True},
            )
            response.raise_for_status()
            checks["edit_and_save"] = response.json()["name"] == "安装包验收上衣"
            response = client.get("/api/backup")
            response.raise_for_status()
            archive = response.content
            with zipfile.ZipFile(BytesIO(archive)) as bundle:
                assert len(bundle.namelist()) >= 3
                assert not any(".browser-key" in name or "api_key" in name for name in bundle.namelist())
            checks["backup_with_images"] = True
            process2, client2 = launch(executable, Path(temporary) / "restored", duration=10)
            processes.append(process2)
            teardown.callback(stop, process2)
            clients.append(client2)
            response = client2.post(
                "/api/restore", files={"file": ("wardrobe.zip", archive, "application/zip")}
            )
            response.raise_for_status()
            restored = client2.get("/api/state").json()["items"]
            assert len(restored) == 1 and restored[0]["name"] == "安装包验收上衣"
            assert client2.get(restored[0]["image_url"]).content == client.get(item["image_url"]).content
            checks["restore_with_identical_images"] = True
            port2 = client2.base_url.port
            client2.close()
            process2.wait(timeout=30)
            assert not (Path(temporary) / "restored/.desktop/instance.json").exists()
            checks["graceful_service_exit"] = process2.returncode == 0
            process3, client3 = launch(executable, Path(temporary) / "restored", duration=5)
            processes.append(process3)
            teardown.callback(stop, process3)
            clients.append(client3)
            assert client3.base_url.port == port2
            assert client3.get("/api/state").json()["items"][0]["name"] == "安装包验收上衣"
            checks["restart_persistence_and_stable_port"] = True
            process3.wait(timeout=20)
            client.close()
            process.wait(timeout=90)
            checks["service_cleanup"] = process.returncode == 0 and process3.returncode == 0
    finally:
        for client in clients:
            client.close()
        for process in processes:
            stop(process)
        args.result.parent.mkdir(parents=True, exist_ok=True)
        args.result.write_text(
            json.dumps({"ok": len(checks) == 8 and all(checks.values()), "checks": checks}, indent=2) + "\n",
            encoding="utf-8",
        )
    if len(checks) != 8 or not all(checks.values()):
        raise RuntimeError("Installed application verification failed; see the result report")
    print(json.dumps(checks, ensure_ascii=False))


if __name__ == "__main__":
    main()
