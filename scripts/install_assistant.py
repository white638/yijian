"""Install the self-contained Yijian skill into a selected Codex project."""

import argparse
import hashlib
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

COMMAND_START = "<!-- yijian-command:start -->"
COMMAND_END = "<!-- yijian-command:end -->"


def desktop_helper() -> Path | None:
    if not getattr(sys, "frozen", False):
        return None
    directory = Path(sys.executable).resolve().parent
    helper = directory / "yijian-cli.exe"
    if helper.is_symlink() or not helper.is_file() or helper.resolve().parent != directory:
        raise ValueError("桌面助手工具不完整，请重新安装衣间后再安装技能。")
    with helper.open("rb") as handle:
        if handle.read(2) != b"MZ":
            raise ValueError("桌面助手工具无效，请重新安装衣间后再安装技能。")
    return helper


def rendered_skill(source: Path) -> bytes | None:
    helper = desktop_helper()
    if helper is None:
        return None
    text = (source / "SKILL.md").read_text(encoding="utf-8")
    if text.count(COMMAND_START) != 1 or text.count(COMMAND_END) != 1:
        raise ValueError("助手技能模板不完整，请重新安装衣间。")
    start, end = text.index(COMMAND_START), text.index(COMMAND_END)
    if end < start:
        raise ValueError("助手技能模板不完整，请重新安装衣间。")
    # A quoted PowerShell literal preserves spaces, quotes and metacharacters in the installation path.
    command = "& '" + str(helper).replace("'", "''") + "'"
    introduction = (
        "使用当前 Codex 或 Claude Code 会话的分析与视觉能力；图片美化使用当前 Codex 的内置生图能力。"
        "衣间桌面助手只读写衣橱，没有模型 API 调用。无需安装 Python。\n\n"
        f"本机工具入口：`{command}`。先运行 `{command} --help` 核对命令。"
        "以下命令使用 PowerShell 写法；以参数数组执行时，把程序路径与各参数分别传入。"
        "工具已随衣间安装，使用下面的完整路径，不要下载其他同名程序。"
    )
    text = text[:start] + introduction + text[end + len(COMMAND_END):]
    return text.replace('python "$CLI"', command).encode("utf-8")


def expected_files(source: Path) -> tuple[dict, bytes | None]:
    expected = files(source)
    rendered = rendered_skill(source)
    if rendered is not None:
        expected[Path("SKILL.md")] = hashlib.sha256(rendered).hexdigest()
    return expected, rendered


def installed_matches(source: Path, target: Path) -> bool:
    if not target.is_dir():
        return False
    expected, _ = expected_files(source)
    return files(target) == expected


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
    expected, rendered = expected_files(source)
    if target.exists():
        if expected == files(target):
            return {"path": str(target), "changed": False}
        if not replace:
            raise ValueError("目标已有不同内容。检查后使用 --replace 安装；现有内容会保留为备份。")
    target.parent.mkdir(parents=True, exist_ok=True)
    staged = target.parent / f".yijian-install-{uuid4().hex}"
    shutil.copytree(source, staged, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    if rendered is not None:
        (staged / "SKILL.md").write_bytes(rendered)
    if expected != files(staged):
        raise ValueError("复制校验失败，当前安装保持原样。")
    backup = None
    if target.exists():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        backup_name = f"{target.name}.backup-{stamp}-{uuid4().hex}"
        if target.parent.name == "skills":
            backup_root = target.parent.parent / ".yijian-skill-backups"
            backup_root.mkdir(parents=True, exist_ok=True)
            backup = backup_root / backup_name
        else:
            backup = target.with_name(backup_name)
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
