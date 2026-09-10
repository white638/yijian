import ctypes
from ctypes import wintypes
import os
import subprocess
import sys

import pytest


@pytest.mark.skipif(os.name != "nt", reason="Windows process lifetime behavior")
def test_closing_job_kills_its_descendants_and_preserves_unrelated_process():
    from desktop.windows_job import WindowsJob

    flags = subprocess.CREATE_NO_WINDOW
    unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], creationflags=flags)
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import subprocess,sys,time; sys.stdin.readline(); child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); print(child.pid,flush=True); time.sleep(60)",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        creationflags=flags,
    )
    job = WindowsJob()
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    api.OpenProcess.restype = wintypes.HANDLE
    api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    api.WaitForSingleObject.restype = wintypes.DWORD
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    grandchild = None
    try:
        job.attach(child.pid)
        child.stdin.write("start\n")
        child.stdin.flush()
        grandchild_pid = int(child.stdout.readline().strip())
        grandchild = api.OpenProcess(0x00100000, False, grandchild_pid)
        assert grandchild
        assert api.WaitForSingleObject(grandchild, 0) == 258
        job.close()
        child.wait(timeout=5)
        assert api.WaitForSingleObject(grandchild, 5000) == 0
        assert unrelated.poll() is None
    finally:
        job.close()
        if grandchild:
            api.CloseHandle(grandchild)
        for process in (child, unrelated):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
        child.stdin.close()
        child.stdout.close()
