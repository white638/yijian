from __future__ import annotations

import asyncio
from collections.abc import Callable
import copy
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import weakref

from .ai_network import ModelConnectionError

TIMEOUT_SECONDS = 120
MAX_RESULT_BYTES = 64 * 1024
_locks = weakref.WeakKeyDictionary()


def executable() -> list[str] | None:
    path = shutil.which("codex")
    if not path:
        return None
    candidate = Path(path).resolve()
    if os.name == "nt" and candidate.suffix.lower() in {".cmd", ".bat", ".ps1"}:
        entry = candidate.parent / "node_modules/@openai/codex/bin/codex.js"
        node = shutil.which("node")
        return [node, str(entry)] if node and entry.is_file() else None
    return [str(candidate)] if candidate.is_file() else None


def available() -> bool:
    return executable() is not None


def strict_schema(schema: dict) -> dict:
    result = copy.deepcopy(schema)

    def visit(value):
        if isinstance(value, dict):
            value.pop("default", None)
            if value.get("type") == "object":
                value["additionalProperties"] = False
                value["required"] = list(value.get("properties", {}))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(result)
    return result


def arguments(command: list[str], root: Path) -> list[str]:
    result = [
        *command,
        "exec",
        "--ignore-user-config",
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--output-schema",
        str(root / "schema.json"),
        "--output-last-message",
        str(root / "result.json"),
        "--image",
        str(root / "garment.jpg"),
        "-c",
        "web_search=disabled",
        "-c",
        "project_doc_max_bytes=0",
    ]
    for feature in (
        "shell_tool",
        "unified_exec",
        "code_mode_host",
        "apps",
        "plugins",
        "browser_use",
        "computer_use",
        "view_image",
        "image_generation",
        "multi_agent",
        "skill_search",
    ):
        result.extend(["--disable", feature])
    result.extend(["--enable", "skip_host_skill_discovery", "-"])
    return result


async def stop_process(process) -> None:
    if process.returncode is not None:
        return
    if os.name == "nt":

        def terminate_tree():
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )

        try:
            await asyncio.to_thread(terminate_tree)
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    await process.wait()


async def stderr_tail(stream) -> str:
    tail = b""
    while chunk := await stream.read(4096):
        tail = (tail + chunk)[-16384:]
    return tail.decode("utf-8", errors="replace")


async def exchange(process, reader, prompt: str) -> str:
    process.stdin.write((prompt + "\n只分析附图并输出所需 JSON，不使用任何工具。\n").encode("utf-8"))
    await process.stdin.drain()
    process.stdin.close()
    await process.wait()
    return await asyncio.shield(reader)


def failure_message(stderr: str) -> str:
    message = stderr.lower()
    if any(word in message for word in ("unauthorized", "not logged in", "401", "authentication")):
        return "本机 Codex 尚未登录或登录已失效，请登录 Codex 后重新识别。"
    if any(word in message for word in ("usage limit", "rate limit", "rate_limit", "quota", "429")):
        return "Codex 当前额度不足或请求受限，请稍后重试，也可以先手动填写。"
    if "unexpected argument" in message or "unknown feature" in message:
        return "当前 Codex 版本不支持自动识别，请更新 Codex 后重试。"
    return "Codex 这次未完成识别，请检查其登录和可用状态后重试。"


async def describe(
    image_path: Path, schema: dict, prompt: str, *, before_start: Callable[[], None] | None = None
) -> dict:
    command = executable()
    if command is None:
        raise ModelConnectionError("没有找到本机 Codex，请安装 Codex 并登录后重新启动衣间。")
    loop = asyncio.get_running_loop()
    lock = _locks.setdefault(loop, asyncio.Lock())
    async with lock:
        if before_start is not None:
            before_start()
        with tempfile.TemporaryDirectory(prefix="yijian-vision-") as temporary:
            root = Path(temporary)
            shutil.copyfile(image_path, root / "garment.jpg")
            (root / "schema.json").write_text(json.dumps(strict_schema(schema)), encoding="utf-8")
            options = (
                {"creationflags": subprocess.CREATE_NO_WINDOW}
                if os.name == "nt"
                else {"start_new_session": True}
            )
            process = None
            reader = None
            try:
                process = await asyncio.create_subprocess_exec(
                    *arguments(command, root),
                    cwd=root,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                    **options,
                )
                reader = asyncio.create_task(stderr_tail(process.stderr))
                stderr = await asyncio.wait_for(exchange(process, reader, prompt), timeout=TIMEOUT_SECONDS)
                if process.returncode != 0:
                    raise ModelConnectionError(failure_message(stderr))
                output = root / "result.json"
                if not output.is_file() or output.stat().st_size > MAX_RESULT_BYTES:
                    raise ModelConnectionError("Codex 没有返回可用的衣物信息，请重试。")
                try:
                    result = json.loads(output.read_text(encoding="utf-8"))
                    if not isinstance(result, dict):
                        raise ValueError
                except (ValueError, UnicodeError):
                    raise ModelConnectionError("Codex 返回的衣物信息格式不正确，请重试。") from None
                return result
            except TimeoutError:
                raise ModelConnectionError("Codex 识别超时，可以重试或先手动填写衣物信息。") from None
            except OSError:
                raise ModelConnectionError(
                    "无法启动本机 Codex，请确认衣间与 Codex 使用同一系统账户。"
                ) from None
            finally:
                if process is not None:
                    await stop_process(process)
                if reader is not None:
                    if not reader.done():
                        await asyncio.wait({reader}, timeout=2)
                    if not reader.done():
                        reader.cancel()
                    await asyncio.gather(reader, return_exceptions=True)
