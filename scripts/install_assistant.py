"""Install the self-contained Yijian skill into a selected Codex project."""

import argparse
import hashlib
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def files(directory):
    return {
        path.relative_to(directory): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in directory.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts
    }


def install(source, target, replace=False):
    source, target = source.resolve(), target.resolve()
    if target == source or source in target.parents or target in source.parents:
        raise ValueError("安装位置不能覆盖插件源目录。")
    if target.exists():
        if files(source) == files(target):
            return {"path": str(target), "changed": False}
        if not replace:
            raise ValueError("目标已有不同内容。检查后使用 --replace 安装；现有内容会保留为备份。")
    target.parent.mkdir(parents=True, exist_ok=True)
    staged = target.parent / f".yijian-install-{uuid4().hex}"
    shutil.copytree(source, staged, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    if files(source) != files(staged):
        raise ValueError("复制校验失败，当前安装保持原样。")
    backup = None
    if target.exists():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        backup = target.with_name(f"{target.name}.backup-{stamp}-{uuid4().hex[:6]}")
        target.rename(backup)
    try:
        staged.rename(target)
    except OSError:
        if backup is not None:
            backup.rename(target)
        raise
    return {
        "path": str(target),
        "changed": True,
        "backup": str(backup) if backup else None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--project", type=Path, default=Path.cwd())
    selection.add_argument("--target", type=Path, help="Exact destination skill folder")
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / "integrations/yijian/skills/yijian"
    target = args.target or (args.project / ".agents/skills/yijian")
    try:
        result = install(source, target, args.replace)
        print(f"衣橱 skill 已就绪：{result['path']}")
        if result.get("backup"):
            print(f"原内容备份：{result['backup']}")
        return 0
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
