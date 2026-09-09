from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from scripts.install_assistant import files, install

from .auth import require_access

Provider = Literal["codex", "claude-code"]
router = APIRouter(prefix="/api/ai/assistant")
SOURCE = Path(__file__).resolve().parents[1] / "integrations/yijian/skills/yijian"
_install_lock = threading.Lock()


class InstallInput(BaseModel):
    provider: Provider


def target_for(provider: Provider) -> Path:
    directory = ".agents" if provider == "codex" else ".claude"
    return Path.home() / directory / "skills" / "yijian"


def browser_only(access: str = Depends(require_access)):
    if access != "browser":
        raise HTTPException(403, "请在衣间页面安装助手技能。")


def installation(provider: Provider) -> dict:
    target = target_for(provider)
    installed = target.is_dir() and files(SOURCE) == files(target)
    return {"installed": installed, "provider": provider, "path": str(target)}


@router.get("/installation", dependencies=[Depends(browser_only)])
def inspect_installation(provider: Provider):
    try:
        return installation(provider)
    except OSError:
        raise HTTPException(409, "无法检查技能目录，请确认衣间由当前系统用户启动。") from None


@router.post("/install", dependencies=[Depends(browser_only)])
async def install_skill(body: InstallInput, request: Request):
    selected = request.app.state.store.read().get("ai", {}).get("configuration", {}).get("provider")
    if selected != body.provider:
        raise HTTPException(409, "请先保存对应的助手方式，再安装技能。")

    def perform():
        with _install_lock:
            target = target_for(body.provider)
            if target.is_symlink() or (hasattr(target, "is_junction") and target.is_junction()):
                raise ValueError("技能安装位置是目录链接，请使用安装脚本选择独立目录。")
            result = install(SOURCE, target, replace=True)
            return {
                **installation(body.provider),
                "changed": result["changed"],
                "backup": result.get("backup"),
            }

    try:
        return await asyncio.to_thread(perform)
    except (OSError, ValueError):
        raise HTTPException(
            409, "技能安装未完成，请确认当前用户可写入个人技能目录，或使用备用安装方式。"
        ) from None
