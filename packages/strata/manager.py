"""Minimal Windows lifecycle helper. Model requests never pass through this process."""
import ctypes
from ctypes import wintypes as W
import importlib.util
import json
import os
from pathlib import Path
import runpy
import socket
import struct
import subprocess
import sys
import time
from types import SimpleNamespace
import urllib.request
from urllib.parse import urlsplit
import uuid

START_SECONDS = 120
STOP_SECONDS = 5
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
iphlp = ctypes.WinDLL("iphlpapi", use_last_error=True)

def api(dll, name, args, result):
    fn = getattr(dll, name)
    fn.argtypes, fn.restype = args, result
    return fn

open_process = api(k32, "OpenProcess", [W.DWORD, W.BOOL, W.DWORD], W.HANDLE)
close = api(k32, "CloseHandle", [W.HANDLE], W.BOOL)
wait = api(k32, "WaitForSingleObject", [W.HANDLE, W.DWORD], W.DWORD)
times = api(k32, "GetProcessTimes", [W.HANDLE] + [ctypes.POINTER(W.FILETIME)] * 4, W.BOOL)
image = api(k32, "QueryFullProcessImageNameW", [W.HANDLE, W.DWORD, W.LPWSTR, ctypes.POINTER(W.DWORD)], W.BOOL)
mutex = api(k32, "CreateMutexW", [W.LPVOID, W.BOOL, W.LPCWSTR], W.HANDLE)
release_mutex = api(k32, "ReleaseMutex", [W.HANDLE], W.BOOL)
tcp_table = api(iphlp, "GetExtendedTcpTable", [W.LPVOID, ctypes.POINTER(W.DWORD), W.BOOL, W.ULONG, ctypes.c_int, W.ULONG], W.DWORD)
query_job = api(k32, "QueryInformationJobObject", [W.HANDLE, ctypes.c_int, W.LPVOID, W.DWORD, W.LPVOID], W.BOOL)
end_job = api(k32, "TerminateJobObject", [W.HANDLE, W.UINT], W.BOOL)
console_window = api(k32, "GetConsoleWindow", [], W.HWND)

class Entry(ctypes.Structure):
    _fields_ = [("size", W.DWORD), ("usage", W.DWORD), ("pid", W.DWORD),
                ("heap", ctypes.c_size_t), ("module", W.DWORD), ("threads", W.DWORD),
                ("parent", W.DWORD), ("priority", W.LONG), ("flags", W.DWORD), ("exe", W.WCHAR * 260)]

snapshot = api(k32, "CreateToolhelp32Snapshot", [W.DWORD, W.DWORD], W.HANDLE)
first = api(k32, "Process32FirstW", [W.HANDLE, ctypes.POINTER(Entry)], W.BOOL)
next_process = api(k32, "Process32NextW", [W.HANDLE, ctypes.POINTER(Entry)], W.BOOL)

class Accounting(ctypes.Structure):
    _fields_ = [(n, ctypes.c_longlong) for n in ("user", "kernel", "period_user", "period_kernel")] + [
        (n, W.DWORD) for n in ("faults", "total", "active", "terminated")]

def error():
    return ctypes.WinError(ctypes.get_last_error())

def identity(pid, handle=None):
    own = handle is None
    handle = handle or open_process(0x1000 | 0x100000, False, pid)
    if not handle:
        if ctypes.get_last_error() == 87:
            return None
        raise error()
    try:
        if wait(handle, 0) == 0:
            return None
        created, exited, kernel, user = (W.FILETIME() for _ in range(4))
        if not times(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
            raise error()
        name, size = ctypes.create_unicode_buffer(32768), W.DWORD(32768)
        if not image(handle, 0, name, ctypes.byref(size)):
            raise error()
        return {"pid": pid, "created": str((created.dwHighDateTime << 32) | created.dwLowDateTime),
                "image": os.path.normcase(name.value)}
    finally:
        if own:
            close(handle)

def confirmed(record):
    current = identity(record["pid"])
    if current is not None and current != record:
        raise RuntimeError("Recorded process identity changed; preserving the unconfirmed process")
    return current is not None

def listener(port):
    size = W.DWORD()
    result = tcp_table(None, ctypes.byref(size), False, 2, 3, 0)
    if result not in (0, 122):
        raise OSError(result, "Cannot read Windows TCP ownership")
    for _ in range(3):
        buffer = ctypes.create_string_buffer(size.value)
        result = tcp_table(buffer, ctypes.byref(size), False, 2, 3, 0)
        if result != 122:
            break
    if result:
        raise OSError(result, "Cannot read Windows TCP ownership")
    count = struct.unpack_from("=I", buffer.raw)[0]
    pids = set()
    for i in range(count):
        _, addr, local_port, _, _, pid = struct.unpack_from("=6I", buffer.raw, 4 + 24 * i)
        host = socket.inet_ntoa(struct.pack("=I", addr))
        if socket.ntohs(local_port & 65535) == port and host in ("127.0.0.1", "0.0.0.0"):
            pids.add(pid)
    if len(pids) > 1:
        raise RuntimeError("Multiple local listeners: cannot confirm ownership")
    return identity(pids.pop()) if pids else None

def descendant(pid, root):
    handle = snapshot(2, 0)
    if handle == ctypes.c_void_p(-1).value:
        raise error()
    parents = {}
    try:
        entry = Entry()
        entry.size = ctypes.sizeof(entry)
        ok = first(handle, ctypes.byref(entry))
        while ok:
            parents[entry.pid] = entry.parent
            ok = next_process(handle, ctypes.byref(entry))
    finally:
        close(handle)
    visited = set()
    while pid and pid not in visited:
        if pid == root:
            return True
        visited.add(pid)
        pid = parents.get(pid)
    return False

def read(file):
    try:
        return json.loads(file.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None

def save(file, body):
    tmp = file.with_name(file.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        tmp.write_text(json.dumps(body), encoding="utf-8")
        for attempt in range(50):
            try:
                os.replace(tmp, file)
                return
            except PermissionError:
                if attempt == 49:
                    raise
                time.sleep(0.01)
    finally:
        tmp.unlink(missing_ok=True)

def diagnostic(message):
    try:
        print(message, file=sys.stderr, flush=True)
    except OSError:
        pass

def local_json(port, path):
    # Local checks must not be routed through a system HTTP proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:" + str(port) + path, timeout=1) as response:
        return json.load(response)

def healthy(port):
    try:
        body = local_json(port, "/health")
        return isinstance(body, dict) and body.get("service") == "strata" and body.get("status") == "ok"
    except (OSError, ValueError):
        return False

def saved_policy(file, target):
    try:
        all_auth = read(file)
        if not isinstance(all_auth, dict):
            return None
        values = []
        for key, auth in all_auth.items():
            if key != "strata" and not key.startswith("strata#"):
                continue
            if not isinstance(auth, dict) or auth.get("type") != "api" or not isinstance(auth.get("key"), str):
                continue
            metadata = auth.get("metadata")
            if (not isinstance(metadata, dict) or type(metadata.get("autoStop")) is not bool
                    or not isinstance(metadata.get("baseURL"), str)):
                continue
            url = urlsplit(metadata.get("baseURL", ""))
            if (url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost")
                    and not url.username and not url.password and not url.query and not url.fragment
                    and url.path.rstrip("/") == "/v1" and (url.port or 80) == target):
                gateway_port, gateway_revision = metadata.get("gatewayPort"), metadata.get("gatewayRevision")
                values.append({"autoStop": metadata["autoStop"], "gatewayPort": gateway_port,
                               "gatewayRevision": gateway_revision})
        # Ambiguous old records cannot replace the last confirmed policy.
        return values[0] if values and all(v == values[0] for v in values) else None
    except (OSError, ValueError, TypeError):
        return None

def winjob(root):
    spec = importlib.util.spec_from_file_location("strata_winjob", str(Path(root) / "serve" / "winjob.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def stop(job):
    if not end_job(job, 1):
        raise error()
    end = time.monotonic() + STOP_SECONDS
    while time.monotonic() < end:
        info = Accounting()
        if not query_job(job, 1, ctypes.byref(info), ctypes.sizeof(info), None):
            raise error()
        if info.active == 0:
            return
        time.sleep(0.05)
    raise RuntimeError("Owned Strata processes did not exit within 5 seconds")

def service():
    _, _, root, config, port = sys.argv
    if sys.stdin.readline().strip() != "start":
        return
    sys.path.insert(0, root)
    sys.argv = [str(Path(root) / "serve" / "server.py"), "--engine", "strata",
                "--config", config, "--host", "127.0.0.1", "--port", port]
    runpy.run_path(sys.argv[0], run_name="__main__")

def manage(directory, cfg, port):
    state_file, request_file = directory / "state.json", directory / "request.json"
    previous = read(state_file)
    owner = identity(os.getpid())
    state = {"manager": owner, "console": bool(console_window()), "status": "starting", "updated": time.time()}
    module, proc, handle, gateway_handle = None, None, None, None
    root_record, listening, gateway_port = None, None, None
    auto_stop = previous.get("autoStop") if previous and type(previous.get("autoStop")) is bool else None
    revision, gateway_uncertain = None, False
    policy, running, dirty = None, False, False
    pending_saved_gateway = False

    def report(status, reason=None):
        nonlocal dirty
        state.update(status=status, updated=time.time())
        if reason:
            state["error"] = reason
        else:
            state.pop("error", None)
        try:
            save(state_file, state)
            dirty = False
        except OSError as exc:
            if not running:
                raise
            # Diagnostics cannot revoke an already recorded, running service's ownership.
            dirty = True
            diagnostic("Strata manager state write failed; retaining the running service: " + str(exc))

    def attach_gateway(request):
        nonlocal gateway_handle, gateway_port
        target = request["gatewayPort"]
        if type(target) is not int or not 1 <= target <= 65535:
            raise RuntimeError("Invalid local Magpie gateway port")
        current = listener(target)
        if current is None:
            raise RuntimeError("Cannot confirm the actual Magpie gateway listener; preserving Strata")
        body = local_json(target, "/")
        if not isinstance(body, dict) or body.get("name") != "magpie":
            raise RuntimeError("The gateway listener does not identify as Magpie; preserving Strata")
        if listener(target) != current:
            raise RuntimeError("Magpie gateway listener changed during HTTP confirmation")
        held = open_process(0x1000 | 0x100000, False, current["pid"])
        if not held:
            raise error()
        if identity(current["pid"], held) != current:
            close(held)
            raise RuntimeError("Magpie gateway identity changed during confirmation")
        if gateway_handle:
            close(gateway_handle)
        gateway_handle, gateway_port = held, target
        state.update(gateway=current, gatewayPort=target)

    def sync_policy():
        nonlocal auto_stop, policy, revision, gateway_uncertain, pending_saved_gateway
        if dirty:
            report(state["status"], state.get("error"))
        saved = saved_policy(directory.parent.parent / "plugin-auth.json", port)
        if saved is not None and saved != policy:
            policy, auto_stop = saved, saved["autoStop"]
            state["autoStop"] = auto_stop
            gateway_uncertain, pending_saved_gateway = True, True
        if pending_saved_gateway:
            try:
                # A saved option is cached even if confirming its current gateway must be retried.
                attach_gateway({"gatewayPort": policy["gatewayPort"] if policy["gatewayPort"] is not None else gateway_port})
                gateway_uncertain, pending_saved_gateway = False, False
                report("starting" if state["status"] == "starting" else "ready")
            except (OSError, ValueError, RuntimeError, KeyError) as exc:
                gateway_uncertain = True
                report("uncertain", str(exc))
                diagnostic("Strata manager: " + str(exc))
        try:
            request = read(request_file)
        except (OSError, ValueError):
            return
        if not isinstance(request, dict) or request.get("revision") == revision:
            return
        revision = request.get("revision")
        state.update(requestPort=request.get("gatewayPort"), requestRevision=revision)
        pending_saved_gateway = False
        try:
            attach_gateway(request)
            gateway_uncertain = False
            report("starting" if state["status"] == "starting" else "ready")
        except (OSError, ValueError, RuntimeError, KeyError) as exc:
            gateway_uncertain = True
            report("uncertain", str(exc))
            diagnostic("Strata manager: " + str(exc))

    def gateway_exited():
        return not gateway_uncertain and gateway_handle and wait(gateway_handle, 0) == 0 and auto_stop is True

    try:
        policy = saved_policy(directory.parent.parent / "plugin-auth.json", port)
        if policy is not None:
            auto_stop = policy["autoStop"]
        if auto_stop is None:
            raise RuntimeError("Cannot confirm a saved Strata exit option; configure the provider first")
        state["autoStop"] = auto_stop
        # Startup follows the actual request; later saved configurations can reconnect without inference.
        request = read(request_file) or cfg
        attach_gateway(request)
        revision = request.get("revision")
        state.update(requestPort=request["gatewayPort"], requestRevision=revision)
        existing = listener(port)
        if previous and previous.get("service") and confirmed(previous["service"]):
            root_record = previous["service"]
            if existing is None or not descendant(existing["pid"], root_record["pid"]):
                raise RuntimeError("Retained Strata listener does not match its ownership record; preserving it")
            handle = open_process(0x1000 | 0x100000 | 1 | 0x100, False, root_record["pid"])
            if not handle or identity(root_record["pid"], handle) != root_record:
                raise RuntimeError("Cannot reopen the retained Strata process safely")
            module = winjob(cfg["root"])
            if not module.contain(SimpleNamespace(_handle=handle)):
                raise RuntimeError("Cannot contain the retained Strata tree; preserving it")
        elif existing:
            raise RuntimeError("Strata port is occupied by an existing process; no duplicate was started")
        else:
            report("starting")
            module = winjob(cfg["root"])
            tmp = directory / "tmp"
            tmp.mkdir(exist_ok=True)
            environment = {**os.environ, **cfg.get("environment", {}), "TEMP": str(tmp), "TMP": str(tmp),
                           "PYTHONDONTWRITEBYTECODE": "1"}
            proc = subprocess.Popen([cfg["python"], "-B", str(Path(__file__).resolve()), "--service",
                                     cfg["root"], cfg["config"], str(port)], cwd=cfg["root"],
                                    env=environment, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                    stderr=sys.stderr, creationflags=subprocess.CREATE_NO_WINDOW)
            root_record = identity(proc.pid, int(proc._handle))
            if not root_record:
                raise RuntimeError("Strata Python exited before startup")
            state["service"] = root_record
            report("starting")
            # The runner cannot create engines until containment has succeeded.
            if not module.contain(proc):
                proc.stdin.close()
                proc.terminate()
                proc.wait(timeout=STOP_SECONDS)
                raise RuntimeError("Strata Windows Job containment failed; startup was cancelled")
            proc.stdin.write(b"start\n")
            proc.stdin.close()
            end = time.monotonic() + START_SECONDS
            while time.monotonic() < end:
                sync_policy()
                if gateway_exited():
                    raise RuntimeError("The Magpie gateway exited during Strata startup")
                if not confirmed(root_record):
                    raise RuntimeError("Strata exited before readiness; check the manager log and existing configuration")
                listening = listener(port)
                if listening and not descendant(listening["pid"], root_record["pid"]):
                    raise RuntimeError("An unrelated listener took the Strata port; preserving that process")
                if listening and healthy(port):
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError("Strata health was not ready within 120 seconds")
        state.update(service=root_record, listener=listener(port))
        running = True
        report("uncertain" if gateway_uncertain else "ready", state.get("error") if gateway_uncertain else None)
        while True:
            sync_policy()
            if not confirmed(root_record):
                stop(module._job)
                report("stopped")
                return
            if gateway_exited():
                if state.get("listener") and not confirmed(state["listener"]):
                    # An already-ended listener cannot be confused with a new PID.
                    state["listener"] = None
                stop(module._job)
                report("stopped")
                return
            time.sleep(0.25)
    except Exception as exc:
        # Only the Job we assigned owns kill rights; a stale record is never enough.
        if module and module._job:
            try:
                stop(module._job)
            except Exception as cleanup:
                diagnostic("Strata cleanup: " + str(cleanup))
        report("error", str(exc))
        diagnostic("Strata manager: " + str(exc))
        return 1
    finally:
        if gateway_handle:
            close(gateway_handle)
        if handle:
            close(handle)

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--service":
        service()
        return 0
    directory = Path(sys.argv[1])
    cfg = json.loads(sys.stdin.read())
    port = int(__import__("urllib.parse", fromlist=["urlparse"]).urlparse(cfg["baseURL"]).port or 80)
    lock = mutex(None, False, "Local\\MagpieStrata-127.0.0.1-" + str(port))
    if not lock:
        raise error()
    owned = False
    try:
        result = wait(lock, 0)
        if result == 258:
            prior = read(directory / "state.json")
            if not prior or prior.get("status") not in ("error", "stopped"):
                return 0
            # A terminal state can be published just before its owner releases the mutex.
            result = wait(lock, int((STOP_SECONDS + 2) * 1000))
        if result not in (0, 0x80):
            return 1
        owned = True
        return manage(directory, cfg, port) or 0
    finally:
        if owned:
            release_mutex(lock)
        close(lock)

if __name__ == "__main__":
    sys.exit(main())
