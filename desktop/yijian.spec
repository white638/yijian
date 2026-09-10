from pathlib import Path
import os

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules, copy_metadata

root = Path(SPECPATH).parent
resources = Path(os.environ['YIJIAN_BUILD_RESOURCES'])
datas = [
    (str(root / 'web/dist'), 'web/dist'),
    (str(root / 'integrations/yijian/skills/yijian'), 'integrations/yijian/skills/yijian'),
    (str(root / 'integrations/browser-capture'), 'integrations/browser-capture'),
    (str(resources / 'models'), 'models'),
    (str(resources / 'licenses'), 'licenses'),
    (str(root / 'LICENSE'), '.'),
    (str(root / 'THIRD_PARTY_NOTICES.md'), '.'),
]
binaries = []
hiddenimports = collect_submodules('server') + collect_submodules('uvicorn')
hiddenimports += ['scripts.install_assistant', 'webview.platforms.winforms', 'webview.platforms.edgechromium', 'clr']
for package in ('webview', 'pythonnet', 'clr_loader', 'rembg'):
    package_data, package_binaries, package_imports = collect_all(package)
    datas += package_data
    binaries += package_binaries
    hiddenimports += package_imports
datas += collect_data_files('certifi')
for package in ('rembg', 'pywebview', 'onnxruntime', 'pymatting', 'numba'):
    datas += copy_metadata(package)
for dll in ('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'concrt140.dll'):
    path = Path(os.environ['SystemRoot']) / 'System32' / dll
    if path.is_file():
        binaries.append((str(path), '.'))

a = Analysis(
    [str(root / 'desktop/launcher.py')], pathex=[str(root)],
    binaries=binaries, datas=datas, hiddenimports=hiddenimports,
    excludes=['PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'cefpython3', 'tkinter', 'pytest', 'IPython', 'matplotlib'],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [], exclude_binaries=True, name='Yijian',
    console=False, upx=False, icon=str(resources / 'yijian.ico'),
)
app = COLLECT(exe, a.binaries, a.datas, name='Yijian', strip=False, upx=False)

cli_analysis = Analysis(
    [str(root / 'integrations/yijian/skills/yijian/scripts/yijian.py')],
    pathex=[str(root)], binaries=[], datas=[], hiddenimports=[],
    runtime_hooks=[str(root / 'desktop/cli_utf8.py')],
    excludes=['webview', 'rembg', 'numpy', 'scipy', 'PIL', 'cryptography'],
)
cli_pyz = PYZ(cli_analysis.pure)
cli = EXE(
    cli_pyz, cli_analysis.scripts, cli_analysis.binaries, cli_analysis.datas, [],
    name='yijian-cli', console=True, upx=False, icon=str(resources / 'yijian.ico'),
)
