"""Build the Windows desktop distribution from public source and pinned dependencies."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.3.0"


def run(command: list[str | Path], **kwargs) -> None:
    subprocess.run([str(part) for part in command], cwd=ROOT, check=True, **kwargs)


def write_icon(destination: Path) -> None:
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (256, 256))
    drawing = ImageDraw.Draw(image)
    drawing.rounded_rectangle((4, 4, 252, 252), 58, fill="#EEE9FA")
    drawing.rounded_rectangle((67, 43, 199, 216), 18, fill="#8572B5")
    drawing.rounded_rectangle((54, 34, 188, 207), 18, fill="#BDB0DE")
    drawing.rounded_rectangle((65, 45, 177, 196), 10, fill="#FBF9FF")
    drawing.line((121, 46, 121, 195), fill="#BDB0DE", width=6)
    drawing.rounded_rectangle((104, 108, 111, 135), 3, fill="#8572B5")
    drawing.rounded_rectangle((131, 108, 138, 135), 3, fill="#8572B5")
    drawing.polygon(
        [(194, 40), (201, 57), (219, 64), (201, 71), (194, 88), (187, 71), (169, 64), (187, 57)],
        fill="#F5BF57",
    )
    image.save(destination, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def collect_licenses(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    inventory = []
    for distribution in sorted(
        importlib.metadata.distributions(), key=lambda dist: dist.metadata["Name"].lower()
    ):
        name = distribution.metadata["Name"]
        inventory.append({"name": name, "version": distribution.version})
        for file in distribution.files or []:
            if any(
                word in str(file).lower() for word in ("license", "copying", "notice")
            ) and ".dist-info/" in str(file).replace("\\", "/"):
                source = Path(distribution.locate_file(file))
                if source.is_file() and not source.is_symlink():
                    target = destination / name / str(file).split(".dist-info/", 1)[-1]
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
    shutil.copytree(ROOT / "licenses", destination / "models", dirs_exist_ok=True)
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    if python_license.is_file():
        shutil.copyfile(python_license, destination / "Python-LICENSE.txt")
    for package in ("react", "react-dom", "scheduler", "lucide-react"):
        source = ROOT / "web/node_modules" / package / "LICENSE"
        if source.is_file():
            target = destination / package
            target.mkdir(exist_ok=True)
            shutil.copyfile(source, target / "LICENSE")
    (destination / "packages.json").write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iscc", type=Path, help="Path to the official Inno Setup compiler")
    parser.add_argument("--skip-web", action="store_true")
    parser.add_argument("--skip-freeze", action="store_true")
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("The Windows installer must be built on Windows x64.")
    build = ROOT / ".local/desktop-build"
    resources = build / "resources"
    resources.mkdir(parents=True, exist_ok=True)
    if not args.skip_web:
        npm = shutil.which("npm.cmd")
        if not npm:
            parser.error("Node.js/npm is required on the build machine.")
        run([npm, "ci", "--prefix", ROOT / "web"])
        run([npm, "run", "build", "--prefix", ROOT / "web"])
    if not (ROOT / "web/dist/index.html").is_file():
        parser.error("Build the local web interface first.")
    if not args.skip_freeze:
        run(
            [
                sys.executable,
                ROOT / "scripts/prepare_images.py",
                "--cache",
                resources / "models",
                "--no-install",
            ]
        )
        write_icon(resources / "yijian.ico")
        collect_licenses(resources / "licenses")
        run(
            [
                sys.executable,
                "-m",
                "PyInstaller",
                "--noconfirm",
                "--distpath",
                build / "dist",
                "--workpath",
                build / "freeze",
                ROOT / "desktop/yijian.spec",
            ],
            env={**os.environ, "YIJIAN_BUILD_RESOURCES": str(resources)},
        )
    app = build / "dist/Yijian"
    shutil.copyfile(build / "dist/yijian-cli.exe", app / "yijian-cli.exe")
    release = build / "release"
    release.mkdir(exist_ok=True)
    if args.iscc:
        language = args.iscc.resolve().parent / "Languages/ChineseSimplified.isl"
        shutil.copyfile(language, resources / "ChineseSimplified.isl")
        run(
            [
                args.iscc.resolve(),
                f"/DAppVersion={VERSION}",
                f"/DBuildRoot={build}",
                ROOT / "desktop/installer.iss",
            ]
        )
    archive = release / f"Yijian-{VERSION}-windows-x64.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for path in sorted(app.rglob("*")):
            if path.is_file():
                output.write(path, Path("Yijian") / path.relative_to(app))
    hashes = []
    for path in sorted(release.glob(f"Yijian-{VERSION}-*")):
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        hashes.append(f"{digest}  {path.name}")
    (release / "SHA256SUMS.txt").write_text("\n".join(hashes) + "\n", encoding="utf-8")
    print(json.dumps({"version": VERSION, "release": str(release), "files": hashes}, indent=2))


if __name__ == "__main__":
    main()
