"""New Flow frontend image generation via batchexecute RPCs.

The legacy aisandbox-pa REST API and labs.google/fx/api/auth/session endpoint
were retired (HTTP 410). The Angular app at flow.google.com now uses
same-origin batchexecute RPCs:

* jHPbke — create a project
* ogiZ0b — generate an image (synchronous; returns a signed CDN URL)

Both require the rendered page's SNlM0e XSRF token, browser-fresh cookies,
and a reCAPTCHA Enterprise token minted in the same page context. All of
those come from the account's live Chrome via CDP, so the exit IP is the
same one the account signed in from.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests

from gflow.account_info import (
    BATCHEXECUTE,
    ORIGIN,
    _cdp_page_session,
    _proxy_for,
    _rpc_headers,
)
from gflow.auth.browser_auth import _CDPConnection, _wait_for_cdp_page, get_saved_cdp_port, gflow_home
from gflow.auth.recaptcha import RECAPTCHA_SITE_KEY
from gflow.api.models import Asset, AssetType

logger = logging.getLogger("gflow.newflow")

TOOL_ENUM = 22  # PINHOLE
MODEL_WIRE = {
    "nano-banana-pro": "GEM_PIX_2",
    "nano-banana-2.1": "BELUGA",
    "nano-banana-2-lite": "HARBOR_SEAL",
}
ASPECT_ENUM = {"landscape": 2, "portrait": 1, "square": 1}
RECAPTCHA_ACTION = "IMAGE_GENERATION"


class NewFlowError(RuntimeError):
    """The new batchexecute image flow could not complete."""


class NewFlowUnavailable(NewFlowError):
    """No live account Chrome / page session is available."""


def _xssi_payload(text: str, rpcid: str) -> Any:
    body = text.lstrip()
    if body.startswith(")]}'"):
        body = body[len(")]}'"):]
    decoder = json.JSONDecoder()
    for raw in body.splitlines():
        line = raw.strip()
        if not line.startswith("["):
            continue
        try:
            decoded, _ = decoder.raw_decode(line)
        except ValueError:
            continue
        if not isinstance(decoded, list):
            continue
        for item in decoded:
            if not isinstance(item, list) or len(item) < 3 or item[0] != "wrb.fr" or item[1] != rpcid:
                continue
            value = item[2]
            if isinstance(value, str):
                try:
                    return json.loads(value)
                except ValueError:
                    return None
            return value
    return None


def _rpc_error(text: str, rpcid: str) -> str:
    """Extract a Google error code from a batchexecute error frame."""
    if "UNUSUAL_ACTIVITY" in text:
        return "UNUSUAL_ACTIVITY"
    if "RECAPTCHA" in text.upper():
        return "RECAPTCHA_FAILED"
    payload = _xssi_payload(text, rpcid)
    if payload is not None:
        return f"unexpected {rpcid} payload"
    return f"{rpcid} returned no payload"


def _post_rpc(cookies: str, values: dict[str, Any], rpcid: str, arg: Any,
              source_path: str = "/", reqid: int | None = None) -> requests.Response:
    query = {
        "rpcids": rpcid,
        "source-path": source_path,
        "bl": values.get("bl") or values.get("cfb2h"),
        "f.sid": values.get("fsid") or values.get("FdrFJe"),
        "hl": "en",
        "_reqid": str(reqid or (int(time.time() * 1000) % 900000 + 100000)),
        "rt": "c",
    }
    query = {k: v for k, v in query.items() if v is not None}
    body = urlencode({
        "f.req": json.dumps([[[rpcid, json.dumps(arg), None, "generic"]]]),
        "at": values["at"],
    })
    return requests.post(
        f"{BATCHEXECUTE}?{urlencode(query)}",
        data=body,
        headers=_rpc_headers(cookies),
        timeout=180,
        allow_redirects=False,
        proxies=_proxy_for(),
    )


def _project_id(cookies: str, values: dict[str, Any]) -> str:
    cache = gflow_home() / "newflow-project.txt"
    try:
        cached = cache.read_text().strip()
        if len(cached) == 36 and "-" in cached:
            return cached
    except OSError:
        pass
    resp = _post_rpc(cookies, values, "jHPbke",
                     ["projects/*", [None, ["gflow magpie"]], [None, TOOL_ENUM]])
    if resp.status_code != 200:
        raise NewFlowError(f"jHPbke returned HTTP {resp.status_code}")
    payload = _xssi_payload(resp.text, "jHPbke")
    pid = payload[0] if isinstance(payload, list) and payload else None
    if not isinstance(pid, str) or len(pid) != 36:
        raise NewFlowError(f"jHPbke did not return a projectId: {_rpc_error(resp.text, 'jHPbke')}")
    try:
        cache.write_text(pid)
    except OSError:
        pass
    return pid


def _page_ws_url() -> str:
    port = get_saved_cdp_port()
    if not port:
        raise NewFlowUnavailable("no live account Chrome CDP port")
    try:
        return _wait_for_cdp_page(port, timeout=5)
    except Exception as exc:
        raise NewFlowUnavailable(f"account Chrome has no usable Flow tab: {exc}") from exc


def _recaptcha_token(cdp: _CDPConnection, project_id: str) -> str:
    """Mint a reCAPTCHA token in the project page's own context.

    The Angular app loads enterprise.js only after navigating into a project;
    on the landing page grecaptcha is absent. Navigating here also keeps the
    token bound to the same source-path used by ogiZ0b.
    """
    cdp.send("Page.enable")
    cdp.send("Page.navigate", {"url": f"{ORIGIN}/project/{project_id}"})
    deadline = time.time() + 20
    while time.time() < deadline:
        result = cdp.send("Runtime.evaluate", {
            "expression": "JSON.stringify({ready: !!(window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute), at: !!(window.WIZ_global_data && window.WIZ_global_data.SNlM0e)})",
            "returnByValue": True,
        })
        state = json.loads(result.get("result", {}).get("value") or "{}")
        if state.get("ready") and state.get("at"):
            break
        time.sleep(0.5)
    else:
        raise NewFlowUnavailable("reCAPTCHA Enterprise did not load on the Flow project page")

    # Light interaction: reCAPTCHA scores are tied to real page activity.
    for x, y in ((300, 300), (420, 360), (510, 410), (380, 480)):
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
        time.sleep(0.2)

    expression = f"""
    (async () => {{
      const g = window.grecaptcha && window.grecaptcha.enterprise;
      if (!g || typeof g.execute !== 'function') return JSON.stringify({{ok:false, err:'no execute'}});
      await new Promise(res => {{ const t = setTimeout(res, 6000); try {{ g.ready(() => {{ clearTimeout(t); res(); }}); }} catch (e) {{ clearTimeout(t); res(); }} }});
      try {{
        const tok = await g.execute({json.dumps(RECAPTCHA_SITE_KEY)}, {{action: {json.dumps(RECAPTCHA_ACTION)}}});
        return JSON.stringify({{ok: true, token: tok}});
      }} catch (e) {{ return JSON.stringify({{ok:false, err:String(e)}}); }}
    }})()
    """
    result = cdp.send("Runtime.evaluate", {
        "expression": expression,
        "awaitPromise": True,
        "returnByValue": True,
    })
    raw = result.get("result", {}).get("value")
    if not isinstance(raw, str):
        raise NewFlowUnavailable("reCAPTCHA evaluation returned no value")
    out = json.loads(raw)
    if not out.get("ok") or not out.get("token"):
        raise NewFlowError(f"reCAPTCHA token failed: {out.get('err', 'unknown')}")
    return out["token"]


def _find_image_url(node: Any) -> str | None:
    if isinstance(node, str):
        if node.startswith("https://flow-content.google/image/") or node.startswith("https://storage.googleapis.com/"):
            return node
        return None
    if isinstance(node, list):
        for item in node:
            found = _find_image_url(item)
            if found:
                return found
    return None


def _asset_from_payload(payload: Any, prompt: str, model: str, seed: int) -> Asset:
    if not isinstance(payload, list):
        raise NewFlowError(f"ogiZ0b returned no media: {_rpc_error(json.dumps(payload), 'ogiZ0b')}")
    try:
        group = payload[0]
        rec = group[0]
    except (TypeError, IndexError, KeyError) as exc:
        raise NewFlowError(f"unrecognized ogiZ0b payload: {json.dumps(payload)[:200]}") from exc
    if not isinstance(rec, list) or not rec or not isinstance(rec[0], str):
        raise NewFlowError(f"unrecognized ogiZ0b media record: {json.dumps(rec)[:200]}")
    url = _find_image_url(rec)
    if not url:
        raise NewFlowError("ogiZ0b media record has no image URL")
    dims = group[-1] if isinstance(group, list) and isinstance(group[-1], list) and len(group[-1]) == 2 else [0, 0]
    return Asset(
        id=rec[0],
        name=rec[0],
        asset_type=AssetType.IMAGE,
        prompt=prompt,
        url=url,
        width=int(dims[0]) if isinstance(dims[0], (int, float)) else 0,
        height=int(dims[1]) if isinstance(dims[1], (int, float)) else 0,
        model=model,
        raw={"fifeUrl": url, "prompt": prompt, "seed": seed,
             "mediaGenerationId": rec[0], "source": "ogiZ0b"},
    )


def generate_images(*, model: str, prompt: str, aspect_ratio: str,
                    num_images: int = 1, seed: int | None = None,
                    debug: bool = False) -> list[Asset]:
    """Generate images through the new frontend RPCs, using the live Chrome."""
    wire = MODEL_WIRE.get(model)
    if not wire:
        raise NewFlowError(f"unknown Flow image model {model!r}")
    fresh = _cdp_page_session()
    if not fresh:
        raise NewFlowUnavailable("no live Flow page session; sign in to gflow again")
    cookies, values = fresh
    if not values.get("at"):
        raise NewFlowUnavailable("Flow page has no SNlM0e token")
    project_id = _project_id(cookies, values)
    ws_url = _page_ws_url()
    cdp = _CDPConnection(ws_url)
    try:
        token = _recaptcha_token(cdp, project_id)
    finally:
        cdp.close()

    # Re-read the page session: navigating to the project page refreshes
    # WIZ values (f.sid / at), and ogiZ0b must use the current ones.
    fresh = _cdp_page_session()
    if fresh:
        cookies, values = fresh
    aspect = ASPECT_ENUM.get(aspect_ratio.lower(), 2)
    assets: list[Asset] = []
    base_seed = seed if seed is not None else int(time.time() * 1000) % 900000 + 100000
    for i in range(num_images):
        if i:
            time.sleep(0.3)
        ctx = [None, TOOL_ENUM, None, None, None, project_id, None, None, None, None, [token, 1]]
        image_seed = base_seed + i
        rec = [None, None, None, image_seed, aspect, wire, None, ctx,
               [[[prompt]]], None, None, None, str(uuid.uuid4()), str(uuid.uuid4())]
        arg = [None, [rec], 1, ctx, [str(uuid.uuid4())]]
        resp = _post_rpc(cookies, values, "ogiZ0b", arg,
                         source_path=f"/project/{project_id}")
        if resp.status_code != 200:
            raise NewFlowError(f"ogiZ0b returned HTTP {resp.status_code}")
        if "UNUSUAL_ACTIVITY" in resp.text:
            raise NewFlowError("ogiZ0b rejected the reCAPTCHA score (UNUSUAL_ACTIVITY); use the account Chrome briefly and retry")
        payload = _xssi_payload(resp.text, "ogiZ0b")
        if payload is None:
            raise NewFlowError(f"ogiZ0b returned no payload: {_rpc_error(resp.text, 'ogiZ0b')}")
        assets.append(_asset_from_payload(payload, prompt, wire, image_seed))
        if debug:
            logger.info("ogiZ0b image %d/%d: %s", i + 1, num_images, assets[-1].url[:80])
    return assets
