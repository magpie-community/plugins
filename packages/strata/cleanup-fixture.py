"""Test-only cleanup using the manager's process identity and an owned handle."""
import ctypes
import json
import sys
from ctypes import wintypes as W
import manager

record = json.loads(sys.stdin.read())
handle = manager.open_process(0x1000 | 0x100000 | 1, False, record["pid"])
if not handle:
    if ctypes.get_last_error() == 87:
        sys.exit(0)
    raise manager.error()
try:
    current = manager.identity(record["pid"], handle)
    if current is None:
        sys.exit(0)
    if current != record:
        raise RuntimeError("Fixture process identity changed; preserving the unconfirmed process")
    terminate = manager.api(manager.k32, "TerminateProcess", [W.HANDLE, W.UINT], W.BOOL)
    if not terminate(handle, 1):
        raise manager.error()
    if manager.wait(handle, 5000) != 0:
        raise RuntimeError("Owned fixture manager did not exit")
finally:
    manager.close(handle)
