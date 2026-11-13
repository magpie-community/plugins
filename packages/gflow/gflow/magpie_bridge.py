"""Non-interactive JSON bridge between the magpie provider plugin and Flow.

The bridge is deliberately stateless for requests: magpie owns accounts in
``plugin-auth.json`` and passes one account's cookies on stdin.  A fresh
``GFLOW_HOME`` isolates that account's CDP port, Chrome profile and proxy
configuration from the terminal CLI's ``~/.gflow`` state.  The browser-login
commands are the one exception: they launch a real Chrome window for that
account so its cookies and reCAPTCHA session can be captured.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from gflow.account_info import (AccountInfoError, CreditsUnavailable,
                                read_account_info, read_identity)
from gflow.api.client import IMAGE_MODELS, FlowClient
from gflow.api.models import (Asset, ExtendVideoRequest, GenerateImageRequest,
                              GenerateVideoRequest)
from gflow.auth import browser_auth


class BridgeError(Exception):
    """An error safe to report to magpie without account secrets."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


ASPECTS = {
    "square": "square",
    "1:1": "square",
    "portrait": "portrait",
    "9:16": "portrait",
    "landscape": "landscape",
    "16:9": "landscape",
    "4:3": "landscape",
    "1792x1024": "landscape",
    "1024x1792": "portrait",
    "1024x1024": "square",
}


def configure_account(request: dict[str, Any]) -> None:
    """Point all gflow home paths at an account-scoped, private directory.

    Imported gflow modules read these paths at call time, so setting the
    environment before constructing ``FlowClient`` keeps one bridge process
    from reading or writing another account's browser/browser-proxy state.
    """
    account = str(request.get("account") or "default")
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in account)[:48]
    digest = hashlib.sha256(account.encode("utf-8")).hexdigest()[:12]
    safe = f"{safe}_{digest}" if safe else digest
    home = str(request.get("home") or "").strip()
    base = str(request.get("state_dir") or "").strip()
    state_root = Path(home).expanduser() if home else (
        Path(base).expanduser() if base else Path.home() / ".gflow-magpie"
    )
    root = state_root / "accounts" / safe
    os.environ["GFLOW_HOME"] = str(root)
    os.environ["GFLOW_NONINTERACTIVE"] = "1"
    os.environ["GFLOW_NO_BROWSER"] = "1"
    root.mkdir(parents=True, exist_ok=True)
    try:
        root.chmod(0o700)
    except OSError:
        pass


def cookies_from(request: dict[str, Any]) -> str:
    """Read cookies from the request header, never from argv or logs."""
    headers = request.get("headers") or {}
    if not isinstance(headers, dict):
        raise BridgeError("headers must be an object")
    value = ""
    for k, v in headers.items():
        if isinstance(k, str) and k.lower() == "x-gflow-cookies":
            value = str(v or "")
            break
    value = value.strip()
    if not value:
        raise BridgeError("missing account cookies; sign in to gflow in magpie first", 401)
    if "=" not in value or "\n" in value or "\r" in value:
        raise BridgeError("invalid account cookies; paste a single Cookie header value")
    return value


def _account_info(cookies: str, credits_required: bool = False) -> dict[str, Any]:
    try:
        return read_account_info(cookies, credits_required=credits_required)
    except (AccountInfoError, CreditsUnavailable) as exc:
        raise BridgeError(str(exc), 502) from exc


def validate(request: dict[str, Any]) -> dict[str, Any]:
    """Validate an account and return the identity magpie should display."""
    info = _account_info(cookies_from(request))
    return {
        "authenticated": True,
        "email": str(info.get("email") or ""),
        "name": str(info.get("name") or ""),
        "credits": info.get("credits"),
        "warning": str(info.get("error") or ""),
    }


def identity(request: dict[str, Any]) -> dict[str, Any]:
    """Return best-effort identity without spending a quota RPC."""
    info = _account_info(cookies_from(request))
    return {
        "authenticated": True,
        "email": str(info.get("email") or ""),
        "name": str(info.get("name") or ""),
    }


def usage(request: dict[str, Any]) -> dict[str, Any]:
    """Return the current Flow credit balance for magpie's auth.usage hook."""
    info = _account_info(cookies_from(request), credits_required=True)
    return {
        "authenticated": True,
        "email": str(info.get("email") or ""),
        "credits": int(info["credits"]),
    }


def image_bytes(asset: Asset, client: FlowClient) -> bytes:
    encoded = asset.raw.get("encodedImage") if isinstance(asset.raw, dict) else None
    if encoded:
        try:
            return base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise BridgeError(f"Flow returned invalid image base64: {exc}", 502) from exc

    import tempfile

    with tempfile.TemporaryDirectory(prefix="gflow-bridge-") as tmp:
        target = Path(tmp) / "image.bin"
        try:
            client.save_image(asset, target)
        except Exception as exc:  # FlowClient wraps HTTP/CDN errors in several types
            raise BridgeError(f"could not download Flow image: {sanitize_error(exc)}", 502) from exc
        return target.read_bytes()


def media_type_of(content: bytes) -> str:
    """Flow's CDN serves JPEG for generated images regardless of requested size."""
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"

def sanitize_error(exc: BaseException) -> str:
    """Keep errors short; upstream bodies can contain tokens or cookie echoes."""
    return str(exc).replace("\n", " ")[:300] or exc.__class__.__name__


def aspect_of(request: dict[str, Any]) -> str:
    size = str(request.get("size") or "").strip().lower()
    if size and size not in ASPECTS:
        raise BridgeError(f"unsupported size {size!r}; use 1024x1024, 1024x1792, 1792x1024 or an aspect ratio")
    return ASPECTS.get(size, "landscape")


def model_of(request: dict[str, Any]) -> str:
    """Resolve magpie's model field to a registered Flow menu model.

    magpie sends either a bare model id or a ``provider/model`` qualified id.
    Unknown ids fail loudly: silently falling back to another model would make
    an agent's explicit choice meaningless.
    """
    raw = request.get("model")
    if raw is None:
        return "nano-banana-2.1"
    value = str(raw).strip()
    model = value.split("/", 1)[1] if value.startswith("gflow/") else value
    if model not in IMAGE_MODELS:
        raise BridgeError(f"unknown Flow image model {value!r}; expected one of {sorted(IMAGE_MODELS)}")
    return model

def image(request: dict[str, Any]) -> dict[str, Any]:
    cookies = cookies_from(request)
    prompt = str(request.get("prompt") or "").strip()
    if not prompt:
        raise BridgeError("prompt is required")
    model = model_of(request)
    n = request.get("n", 1)
    if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= 8:
        raise BridgeError("n must be an integer between 1 and 8")
    seed = request.get("seed")
    if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool)):
        raise BridgeError("seed must be an integer")

    with FlowClient(cookies, debug=False, interactive_auth=False) as client:
        assets = client.generate_image(
            GenerateImageRequest(
                prompt=prompt,
                model=model,
                aspect_ratio=aspect_of(request),
                seed=seed,
                num_images=n,
            )
        )
        if not assets:
            raise BridgeError("Flow returned no images", 502)
        data = []
        revised = ""
        for asset in assets:
            raw = asset.raw if isinstance(asset.raw, dict) else {}
            if not revised and raw.get("prompt"):
                revised = str(raw["prompt"])
            content = image_bytes(asset, client)
            data.append({
                "b64_json": base64.b64encode(content).decode("ascii"),
                "revised_prompt": str(raw.get("prompt") or prompt),
                "media_type": media_type_of(content),
            })
        return {"created": int(request.get("created") or time.time()), "data": data,
                **({"revised_prompt": revised} if revised else {})}


VIDEO_ASPECTS = frozenset({"square", "portrait", "landscape", "16:9", "9:16", "1:1"})
VIDEO_STATE_VERSION = 1


def _seed_of(request: dict[str, Any]) -> int | None:
    seed = request.get("seed")
    if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool)):
        raise BridgeError("seed must be an integer")
    return seed


def _video_state_path(account: str) -> Path:
    digest = hashlib.sha256(account.encode("utf-8")).hexdigest()[:16]
    return Path(os.environ["GFLOW_HOME"]) / f"video-state-{digest}.json"


def _read_video_state(account: str) -> dict[str, Any]:
    try:
        raw = Path(_video_state_path(account)).read_text(encoding="utf-8")
        state = json.loads(raw)
        if not isinstance(state, dict) or state.get("account") != account:
            return {}
        return state
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_video_state(client: FlowClient, account: str, state: dict[str, Any]) -> None:
    # The bridge is a new process for every request; continuity must survive
    # process boundaries without writing cookies or raw API responses to disk.
    state["account"] = account
    state["version"] = VIDEO_STATE_VERSION
    state["updated_at"] = time.time()
    if getattr(client, "_workflow_id", ""):
        state["workflow_id"] = str(client._workflow_id)
    if getattr(client, "_primary_media_id", ""):
        state["primary_media_id"] = str(client._primary_media_id)
    path = _video_state_path(account)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    try:
        temp.chmod(0o600)
    except OSError:
        pass
    os.replace(temp, path)


def _video_result(client: FlowClient, account: str, submitted: list[Asset],
                  request: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    if not submitted:
        raise BridgeError("Flow returned no video operation", 502)
    wait = request.get("wait", True)
    if not isinstance(wait, bool):
        raise BridgeError("wait must be a boolean")
    timeout = request.get("timeout", 300)
    if (not isinstance(timeout, int) or isinstance(timeout, bool)
            or not 30 <= timeout <= 1800):
        raise BridgeError("timeout must be an integer between 30 and 1800")
    media_ids = [a.id for a in submitted if a.id]
    if not media_ids:
        raise BridgeError("Flow returned no media IDs for polling", 502)
    state["last_media_ids"] = media_ids
    _save_video_state(client, account, state)
    videos = client.wait_for_video(media_ids, timeout=timeout) if wait else submitted
    files: list[str] = []
    if wait:
        output = request.get("output")
        if output is not None and (not isinstance(output, str) or not output.strip()):
            raise BridgeError("output must be a non-empty file path")
        for i, asset in enumerate(videos):
            if output:
                if len(videos) != 1:
                    raise BridgeError("output can only be used when one video is returned")
                target = Path(output).expanduser()
            else:
                target = Path(os.environ["GFLOW_HOME"]) / "videos" / f"video-{i}.mp4"
            saved = client.save_video(asset, target)
            if not saved.exists() or not saved.stat().st_size:
                raise BridgeError("Flow downloaded an empty video file", 502)
            files.append(str(saved))
    # Persist after both submission and successful downloads. If polling times
    # out, the caller can still retry using the returned/recorded media ids.
    _save_video_state(client, account, state)
    return {
        "videos": [a.model_dump(mode="json", exclude={"raw"}) for a in videos],
        "operations": media_ids,
        "new_media_ids": [a.id for a in videos if a.id] if wait else media_ids,
        "media_ids": media_ids,
        "saved_files": files,
        "waited": wait,
        "workflow_id": str(getattr(client, "_workflow_id", "") or ""),
    }


def video(request: dict[str, Any], extend: bool = False) -> dict[str, Any]:
    cookies = cookies_from(request)
    prompt = str(request.get("prompt") or "").strip()
    if not prompt:
        raise BridgeError("prompt is required")
    aspect = str(request.get("aspect_ratio") or "landscape").strip().lower()
    if aspect not in VIDEO_ASPECTS:
        raise BridgeError(f"unsupported aspect_ratio {aspect!r}; use {', '.join(sorted(VIDEO_ASPECTS))}")
    account = str(request.get("account") or "default")
    state = _read_video_state(account)
    with FlowClient(cookies, debug=False, interactive_auth=False) as client:
        client._workflow_id = str(state.get("workflow_id") or "")
        client._primary_media_id = str(state.get("primary_media_id") or "")
        if extend:
            media_id = str(request.get("media_id") or "").strip()
            if not media_id:
                raise BridgeError("media_id is required for video extension")
            submitted = client.extend_video(ExtendVideoRequest(
                prompt=prompt, media_id=media_id, aspect_ratio=aspect,
                workflow_id=str(request.get("workflow_id") or ""),
                seed=_seed_of(request),
            ))
        else:
            submitted = client.generate_video(GenerateVideoRequest(
                prompt=prompt, aspect_ratio=aspect, seed=_seed_of(request),
            ))
        return _video_result(client, account, submitted, request, state)


FLOW_URLS = (
    "https://flow.google.com/",
    "https://labs.google/fx/tools/flow",
)
GOOGLE_AUTH_COOKIES = frozenset({"SID", "HSID", "SSID", "__Secure-1PSID", "SAPISID"})


def _cdp_browser_state(cdp: Any) -> tuple[list[dict], list[dict]]:
    """Read cookies and page targets through a browser-level CDP connection."""
    cookies = cdp.send("Storage.getCookies").get("cookies", [])
    targets = cdp.send("Target.getTargets").get("targetInfos", [])
    pages = [t for t in targets if t.get("type") == "page"]
    return cookies, pages


def _auth_cookie_header(cookies: list[dict]) -> str:
    """Serialize Google-domain cookies in CDP's order without duplicates.

    Browser-level ``Storage.getCookies`` returns every profile cookie.  Sending
    unrelated domains to ``flow.google.com`` can change Google's routing, so
    only cookies whose domain is Google-owned are put in the account header.
    """
    seen: set[str] = set()
    parts: list[str] = []
    for cookie in cookies:
        name = str(cookie.get("name") or "")
        value = str(cookie.get("value") or "")
        domain = str(cookie.get("domain") or "").lower().lstrip(".")
        if not name or "=" in name or ";" in name or name in seen:
            continue
        if domain and not (domain == "google.com" or domain.endswith(".google.com")):
            continue
        seen.add(name)
        parts.append(f"{name}={value}")
    return "; ".join(parts)


def _flow_error_page(page: dict) -> bool:
    """Return true for Chrome's sign-in/error target placeholders."""
    url = str(page.get("url") or "")
    title = str(page.get("title") or "")
    location = f"{url} {title}".lower()
    return (url.startswith("chrome-error://") or url.startswith("about:blank")
            or "connection failed" in location or "(-100)" in location)


def _flow_page_ready(pages: list[dict]) -> bool:
    """Return true when at least one page is a loaded Flow app, not an error."""
    for page in pages:
        url = str(page.get("url") or "")
        title = str(page.get("title") or "")
        location = f"{url} {title}".lower()
        on_flow = (url.startswith(FLOW_URLS[0].rstrip("/"))
                   or url.startswith("https://labs.google/fx/"))
        bad_marker = ("accounts.google." in location or "signin" in location
                      or "connection failed" in location or "(-100)" in location)
        if on_flow and not bad_marker and not _flow_error_page(page):
            return True
    return False


def _cdp_shell_emails(cdp: Any, pages: list[dict]) -> list[str]:
    """Read the signed-in email from the live Flow page when shell GET misses it.

    This uses page-level CDP Runtime.evaluate only on Flow targets.  A failed
    or unavailable evaluation returns no email; it never blocks cookie saving.
    """
    import secrets

    token = secrets.token_hex(8)
    expression = (
        "(function(){var t='" + token + "',v=window.WIZ_global_data||{},"
        "out=[];function put(x){if(typeof x==='string'&&/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(x)&&out.indexOf(x)<0)out.push(x)};"
        "['oPEP7c','o30O0e','email','userEmail'].forEach(function(k){put(v[k])});"
        "var d=document.documentElement&&document.documentElement.innerHTML||'';"
        "var m=d.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g)||[];"
        "m.slice(0,40).forEach(put);return JSON.stringify({t:t,emails:out})})()"
    )
    emails: list[str] = []
    for page in pages:
        url = str(page.get("url") or "")
        target_id = str(page.get("targetId") or "")
        if not target_id or not (url.startswith("https://flow.google.com/")
                                 or url.startswith("https://labs.google/fx/")):
            continue
        try:
            attached = cdp.send("Target.attachToTarget", {
                "targetId": target_id,
                "flatten": True,
            })
            session_id = str(attached.get("sessionId") or "")
            if not session_id:
                continue
            result = cdp.send("Runtime.evaluate", {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": False,
            }, session_id=session_id)
            raw = result.get("result", {}).get("value", "") if isinstance(result, dict) else ""
            parsed = json.loads(raw) if isinstance(raw, str) else {}
            if isinstance(parsed, dict) and str(parsed.get("t") or "") == token:
                for value in parsed.get("emails") or []:
                    if isinstance(value, str) and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
                        emails.append(value)
        except Exception:
            continue
    return emails


def browser_login_start(request: dict[str, Any]) -> dict[str, Any]:
    """Open an account-scoped Chrome and verify ownership before using its CDP port.

    Chrome treats ``--remote-debugging-port=0`` as an automation launch. Use a
    nonzero port and a unique startup-page marker: the marker prevents attaching
    to an unrelated listener if Chrome hands off to an existing profile.
    """
    del request
    import platform
    import subprocess
    import uuid

    # A previous unfinished sign-in for this account used the same GFLOW_HOME;
    # close it and wait for the profile lock before replacing the port.
    browser_auth.kill_auth_browser()
    browser_auth.clear_cdp_port()

    chrome_path = browser_auth._get_chrome_path()
    profile_dir = browser_auth.env_dir() / "chrome-profile"
    profile = str(profile_dir)
    try:
        profile_dir.mkdir(parents=True, exist_ok=True)
        (profile_dir / browser_auth.DEVTOOLS_ACTIVE_PORT).unlink()
    except OSError:
        pass

    port = browser_auth._find_free_port()
    startup_url = f"data:text/html,gflow-login-{uuid.uuid4().hex}"
    args = [
        chrome_path,
        f"--remote-debugging-port={port}",
        "--remote-allow-origins=*",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=ChromeWhatsNewUI",
        startup_url,
    ]
    try:
        from gflow.auth.proxy_ext import get_chrome_proxy_args
        args[1:1] = get_chrome_proxy_args()
    except Exception:
        pass

    creation_flags = 0
    if platform.system() == "Windows":
        creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creation_flags,
            start_new_session=(platform.system() != "Windows"),
        )
    except Exception as exc:
        raise BridgeError(f"could not open Chrome for Google Flow: {sanitize_error(exc)}", 502) from exc

    try:
        ws_url = browser_auth._wait_for_cdp_page(port, timeout=20, target_url=startup_url)
        cdp = browser_auth._CDPConnection(ws_url)
        try:
            navigation = cdp.send("Page.navigate", {"url": FLOW_URLS[0]})
            if navigation.get("errorText"):
                raise browser_auth.AuthError("Flow login page navigation failed")
        finally:
            cdp.close()
    except Exception as exc:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
        raise BridgeError(
            "Chrome did not expose a debugging port for this account; close any "
            "open Flow login window and click the button again", 502) from exc

    browser_auth.save_cdp_port(port)
    return {"url": FLOW_URLS[0], "cdp_port": port, "opened": True}


def _verified_cookie_header(first_header: str, cdp: Any, deadline: float,
                            last_error: list[str]) -> str | None:
    """Return a cookie header whose Flow shell carries the session token.

    Google rotates session cookies (``__Secure-*PSIDTS``, ``SIDCC`` …) right
    after sign-in completes, and the rotated-out values then serve a reduced
    shell without ``SNlM0e`` or the profile email.  Re-read the live cookies
    from CDP and require the shell to verify before returning; loop until the
    deadline so a rotation still in flight is captured on a later read.
    """
    header = first_header
    while time.monotonic() < deadline:
        shell = None
        try:
            shell = read_identity(header)
        except AccountInfoError as exc:
            last_error.clear()
            last_error.append(str(exc))
        if shell and shell.get("values", {}).get("SNlM0e"):
            return header
        # Rotated-out or not yet upgraded: re-read what Chrome holds now.
        time.sleep(2)
        try:
            cookies, _pages = _cdp_browser_state(cdp)
            fresh = _auth_cookie_header(cookies)
            if fresh:
                header = fresh
        except Exception as exc:
            last_error.clear()
            last_error.append(browser_auth.sanitize_cdp_error(exc))
    return None


def browser_login_wait(request: dict[str, Any]) -> dict[str, Any]:
    """Wait for the login Chrome to hold a valid Flow session, then return it.

    The callback runs in a separate bridge process, so it reads the CDP port
    persisted by ``browser_login_start``.  Cookies go to magpie only through
    this process's stdout; Chrome remains open for later reCAPTCHA tokens.
    """
    port = browser_auth.read_saved_cdp_port()
    if not port:
        raise BridgeError("login browser is not running; click the button again", 401)
    timeout = int(request.get("timeout_seconds") or 300)
    timeout = max(10, min(timeout, 900))
    try:
        ws_url = browser_auth._wait_for_browser_cdp(port, timeout=min(30, timeout))
    except Exception as exc:
        raise BridgeError(f"could not connect to the login browser: {browser_auth.sanitize_cdp_error(exc)}", 502) from exc

    cdp = browser_auth._CDPConnection(ws_url)
    try:
        deadline = time.monotonic() + timeout
        last_error = ""
        recovery_attempted = False
        while time.monotonic() < deadline:
            try:
                cookies, pages = _cdp_browser_state(cdp)
                names = {str(c.get("name") or "") for c in cookies}
                if not names.intersection(GOOGLE_AUTH_COOKIES):
                    last_error = "Google sign-in cookies are not available yet"
                    time.sleep(2)
                    continue
                if not _flow_page_ready(pages):
                    # Google's sign-in redirects can leave zero page targets
                    # or only chrome-error://chromewebdata.  Reopen the Flow
                    # app through the browser-level target so the callback
                    # can finish without depending on a stale page WebSocket.
                    if not recovery_attempted and (not pages or all(_flow_error_page(p) for p in pages)):
                        recovery_attempted = True
                        try:
                            cdp.send("Target.createTarget", {"url": FLOW_URLS[0]})
                        except Exception as exc:  # CDP may be mid-navigation
                            last_error = browser_auth.sanitize_cdp_error(exc)
                    last_error = last_error or f"waiting for a live Google Flow tab (targets: {len(pages)})"
                    time.sleep(2)
                    continue
            except Exception as exc:  # page navigation can temporarily break a CDP call
                last_error = browser_auth.sanitize_cdp_error(exc)
                time.sleep(2)
                continue
            last_error = ""

            cookie_header = _auth_cookie_header(cookies)
            if not cookie_header:
                last_error = "Google sign-in cookies could not be serialized"
                time.sleep(2)
                continue
            # Google rotates session cookies right after sign-in completes.
            # Saving the first header verbatim produced accounts whose shell
            # no longer carried SNlM0e, so email and credits both failed.
            # Verify the shell through the (possibly re-read) header first.
            errors: list[str] = []
            verified = _verified_cookie_header(cookie_header, cdp, deadline, errors)
            if verified:
                cookie_header = verified
            else:
                if errors and errors[0]:
                    last_error = errors[0]
                # Fall through with the freshest header we saw: magpie's
                # callback treats any authenticated cookies as success, and
                # usage refreshes identity later.
                try:
                    cookies, pages = _cdp_browser_state(cdp)
                    fresh = _auth_cookie_header(cookies)
                    if fresh:
                        cookie_header = fresh
                except Exception:
                    pass
            # The old /fx/api/auth/session endpoint answers 410 even for a
            # good browser session. Identity and quota are best-effort: valid
            # Google cookies must still be saved by magpie, otherwise host
            # callback() treats the whole sign-in as incomplete.
            identity = {"email": "", "name": ""}
            try:
                shell_identity = read_identity(cookie_header)
                identity = {
                    "email": str(shell_identity.get("email") or ""),
                    "name": str(shell_identity.get("name") or ""),
                }
            except AccountInfoError as exc:
                last_error = str(exc)
            if not identity["email"]:
                for email in _cdp_shell_emails(cdp, pages):
                    identity["email"] = email
                    last_error = ""
                    break
            # Keep the CDP port persisted; generation uses the same live Chrome.
            return {"authenticated": True, "cookies": cookie_header,
                    "email": identity["email"], "name": identity["name"]}
        raise BridgeError(last_error or "timed out waiting for Google Flow login", 408)
    finally:
        cdp.close()


def run(request: dict[str, Any]) -> dict[str, Any]:
    configure_account(request)
    command = str(request.get("command") or "").strip()
    if command == "validate":
        return validate(request)
    if command == "identity":
        return identity(request)
    if command == "usage":
        return usage(request)
    if command == "image":
        return image(request)
    if command == "video":
        return video(request)
    if command == "extend_video":
        return video(request, extend=True)
    if command == "browser_login_start":
        return browser_login_start(request)
    if command == "browser_login_wait":
        return browser_login_wait(request)
    raise BridgeError(f"unknown bridge command: {command!r}")


def main(argv: list[str] | None = None) -> int:
    del argv  # no secrets or commands are accepted in argv
    try:
        raw = sys.stdin.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise BridgeError("request is too large")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise BridgeError("request must be a JSON object")
        result = run(request)
        sys.stdout.write(json.dumps(result, separators=(",", ":")))
        return 0
    except BridgeError as exc:
        sys.stdout.write(json.dumps({"error": {"message": str(exc), "type": "bridge_error"}},
                                   separators=(",", ":")))
        return exc.status
    except Exception as exc:
        sys.stdout.write(json.dumps({"error": {"message": sanitize_error(exc), "type": exc.__class__.__name__}},
                                   separators=(",", ":")))
        return 500


if __name__ == "__main__":
    raise SystemExit(main())
