"""Desktop skill installation keeps the helper independent of a system Python."""

import shutil
from pathlib import Path

import pytest

from scripts import install_assistant as installer
from server import assistant_setup


SOURCE = Path(__file__).resolve().parents[1] / "integrations/yijian/skills/yijian"


@pytest.fixture
def frozen_install(tmp_path, monkeypatch):
    source = tmp_path / "bundle/integrations/yijian/skills/yijian"
    shutil.copytree(SOURCE, source)
    application = tmp_path / "衣间 App's $Desktop/Yijian.exe"
    application.parent.mkdir()
    application.write_bytes(b"MZ-main-fixture")
    helper = application.with_name("yijian-cli.exe")
    helper.write_bytes(b"MZ-helper-fixture")
    monkeypatch.setattr(installer.sys, "frozen", True, raising=False)
    monkeypatch.setattr(installer.sys, "executable", str(application))
    return source, tmp_path / "profile/.agents/skills/yijian", helper


def test_source_install_preserves_python_document_and_files(tmp_path, monkeypatch):
    monkeypatch.setattr(installer.sys, "frozen", False, raising=False)
    target = tmp_path / "skills/yijian"
    assert installer.install(SOURCE, target)["changed"] is True
    assert installer.files(SOURCE) == installer.files(target)
    assert 'python "$CLI"' in (target / "SKILL.md").read_text(encoding="utf-8")
    assert installer.installed_matches(SOURCE, target)


def test_desktop_skill_uses_quoted_console_helper_for_every_command(frozen_install):
    source, target, helper = frozen_install
    original = installer.files(source)
    assert installer.install(source, target)["changed"] is True
    text = (target / "SKILL.md").read_text(encoding="utf-8")
    command = "& '" + str(helper).replace("'", "''") + "'"
    for arguments in (
        "--help",
        "connect --client codex",
        "connect --client claude-code",
        "status",
        "beautify-list",
    ):
        assert f"{command} {arguments}" in text
    assert 'python "$CLI"' not in text
    assert "$CLI" not in text
    assert "无需安装 Python" in text
    assert installer.COMMAND_START not in text
    assert installer.files(source) == original
    assert (target / "scripts/yijian.py").read_bytes() == (source / "scripts/yijian.py").read_bytes()
    assert installer.installed_matches(source, target)


def test_repeated_desktop_install_is_unchanged(frozen_install):
    source, target, _ = frozen_install
    installer.install(source, target)
    previous = {p.relative_to(target): p.stat().st_mtime_ns for p in target.rglob("*") if p.is_file()}
    assert installer.install(source, target) == {"path": str(target), "changed": False}
    assert previous == {p.relative_to(target): p.stat().st_mtime_ns for p in target.rglob("*") if p.is_file()}


def test_server_installation_recognizes_rendered_skill(frozen_install, monkeypatch):
    source, target, _ = frozen_install
    monkeypatch.setattr(assistant_setup, "SOURCE", source)
    monkeypatch.setattr(assistant_setup, "target_for", lambda provider: target)
    assert assistant_setup.installation("codex")["installed"] is False
    installer.install(source, target)
    assert assistant_setup.installation("codex") == {
        "installed": True,
        "provider": "codex",
        "path": str(target),
    }
    (target / "SKILL.md").write_text("Personal instructions", encoding="utf-8")
    assert assistant_setup.installation("codex")["installed"] is False


def test_personal_desktop_skill_is_backed_up_before_rendered_replacement(frozen_install):
    source, target, _ = frozen_install
    installer.install(source, target)
    (target / "SKILL.md").write_text("Personal instructions", encoding="utf-8")
    (target / "notes.txt").write_text("Keep my notes", encoding="utf-8")
    previous = installer.files(target)
    assert not installer.installed_matches(source, target)
    with pytest.raises(ValueError, match="目标已有不同内容"):
        installer.install(source, target)
    result = installer.install(source, target, replace=True)
    assert installer.files(Path(result["backup"])) == previous
    assert installer.installed_matches(source, target)


@pytest.mark.parametrize("invalid", ["missing", "directory", "not-executable"])
def test_invalid_helper_preserves_previous_installation(frozen_install, invalid):
    source, target, helper = frozen_install
    installer.install(source, target)
    previous = installer.files(target)
    helper.unlink()
    if invalid == "directory":
        helper.mkdir()
    elif invalid == "not-executable":
        helper.write_text("not an executable", encoding="utf-8")
    with pytest.raises(ValueError, match="桌面助手工具"):
        installer.install(source, target, replace=True)
    assert installer.files(target) == previous
    assert not list(target.parent.glob(".yijian-install-*"))


def test_helper_symlink_is_rejected_before_skill_write(frozen_install, monkeypatch):
    source, target, helper = frozen_install
    original = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda path: path == helper or original(path))
    with pytest.raises(ValueError, match="桌面助手工具"):
        installer.install(source, target)
    assert not target.exists()


def test_relocated_desktop_install_updates_command_with_backup(frozen_install, monkeypatch):
    source, target, helper = frozen_install
    installer.install(source, target)
    previous = installer.files(target)
    other = helper.parent.parent / "New install/Yijian.exe"
    other.parent.mkdir()
    other.write_bytes(b"MZ-main-fixture")
    other.with_name("yijian-cli.exe").write_bytes(b"MZ-helper-fixture")
    monkeypatch.setattr(installer.sys, "executable", str(other))
    assert not installer.installed_matches(source, target)
    result = installer.install(source, target, replace=True)
    assert installer.files(Path(result["backup"])) == previous
    assert installer.installed_matches(source, target)
    assert str(other.with_name("yijian-cli.exe")) in (target / "SKILL.md").read_text(encoding="utf-8")


@pytest.mark.parametrize("broken", ["no marker", "duplicate marker", "reversed markers"])
def test_broken_template_does_not_replace_existing_skill(frozen_install, broken):
    source, target, _ = frozen_install
    installer.install(source, target)
    previous = installer.files(target)
    text = (source / "SKILL.md").read_text(encoding="utf-8")
    if broken == "no marker":
        text = text.replace(installer.COMMAND_START, "")
    elif broken == "duplicate marker":
        text += installer.COMMAND_START
    else:
        text = installer.COMMAND_END + installer.COMMAND_START
    (source / "SKILL.md").write_text(text, encoding="utf-8")
    with pytest.raises(ValueError, match="模板不完整"):
        installer.install(source, target, replace=True)
    assert installer.files(target) == previous


def test_desktop_install_rename_failure_restores_existing_skill(frozen_install, monkeypatch):
    source, target, _ = frozen_install
    installer.install(source, target)
    (target / "SKILL.md").write_text("Keep me", encoding="utf-8")
    previous = installer.files(target)
    original = Path.rename

    def fail_commit(path, destination):
        if path.name.startswith(".yijian-install-") and destination == target:
            raise OSError("fixture failure")
        return original(path, destination)

    monkeypatch.setattr(Path, "rename", fail_commit)
    with pytest.raises(OSError, match="fixture failure"):
        installer.install(source, target, replace=True)
    assert installer.files(target) == previous
