"""Launch system tools without inheriting the frozen application's DLL directory."""

import asyncio
import ctypes
import os
from pathlib import Path
import sys
import threading
import weakref

_loop_locks = weakref.WeakKeyDictionary()
_dll_lock = threading.RLock()


def _dll_api():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetDllDirectoryW.argtypes = [ctypes.c_uint32, ctypes.c_wchar_p]
    kernel.GetDllDirectoryW.restype = ctypes.c_uint32
    kernel.SetDllDirectoryW.argtypes = [ctypes.c_wchar_p]
    kernel.SetDllDirectoryW.restype = ctypes.c_int
    return kernel


def _current_directory(kernel):
    ctypes.set_last_error(0)
    size = kernel.GetDllDirectoryW(0, None)
    if size == 0:
        if ctypes.get_last_error():
            raise OSError("无法读取系统工具运行环境。")
        return None
    buffer = ctypes.create_unicode_buffer(size + 1)
    ctypes.set_last_error(0)
    read = kernel.GetDllDirectoryW(len(buffer), buffer)
    if read == 0 and ctypes.get_last_error():
        raise OSError("无法读取系统工具运行环境。")
    if read >= len(buffer):
        raise OSError("系统工具运行环境已变化，请重试。")
    return buffer.value or None


def _external_environment(source):
    environment = dict(source)
    bundle = getattr(sys, "_MEIPASS", None)
    if not bundle or "PATH" not in environment:
        return environment
    root = Path(bundle).resolve()

    def bundled(value):
        if not value:
            return False
        try:
            return Path(value.strip('"')).resolve().is_relative_to(root)
        except (OSError, ValueError):
            return False

    environment["PATH"] = os.pathsep.join(
        value for value in environment["PATH"].split(os.pathsep) if not bundled(value)
    )
    return environment


async def create_external_process(*command, **options):
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return await asyncio.create_subprocess_exec(*command, **options)
    loop = asyncio.get_running_loop()
    lock = _loop_locks.setdefault(loop, asyncio.Lock())
    async with lock:
        # DLL search state is process-wide, so frozen launches share a lock and always restore it.
        with _dll_lock:
            kernel = _dll_api()
            previous = _current_directory(kernel)
            if not kernel.SetDllDirectoryW(None):
                raise OSError("无法准备系统工具运行环境。")
            process = None
            try:
                source = options.get("env")
                options["env"] = _external_environment(os.environ if source is None else source)
                process = await asyncio.create_subprocess_exec(*command, **options)
                return process
            finally:
                if not kernel.SetDllDirectoryW(previous):
                    if process is not None and process.returncode is None:
                        try:
                            process.kill()
                        except ProcessLookupError:
                            pass
                        await process.wait()
                    raise OSError("无法恢复应用运行环境，请重新启动衣间。")
