"""Hold the startup mutex briefly after publishing a terminal state."""
import json
import sys
import time
from pathlib import Path
import manager

lock = manager.mutex(None, False, "Local\\MagpieStrata-127.0.0.1-" + sys.argv[2])
assert lock and manager.wait(lock, 0) in (0, 0x80)
try:
    manager.save(Path(sys.argv[1]) / "state.json", {"status": "stopped", "updated": time.time(),
                 "manager": manager.identity(__import__("os").getpid())})
    time.sleep(0.8)
finally:
    manager.release_mutex(lock)
    manager.close(lock)
