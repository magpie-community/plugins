"""New Flow frontend image and video generation via batchexecute RPCs.

The legacy aisandbox-pa REST API and labs.google/fx/api/auth/session endpoint
were retired (HTTP 410). The Angular app at flow.google.com now uses
same-origin batchexecute RPCs:

* jHPbke — create a project
* ogiZ0b — generate an image (synchronous; returns a signed CDN URL)
* YhhmEf — start text-to-video generation (asynchronous; returns media UUID)
* fZytfe — extend an existing video (asynchronous; returns media UUID)
* jwpduf / iFxMud — poll media generation status and retrieve signed video URL

Generation RPCs require the rendered page's SNlM0e XSRF token, browser-fresh
cookies, and a reCAPTCHA Enterprise token minted in the same page context.
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
VIDEO_ASPECT_ENUM = {
    "landscape": 2,
    "16:9": 2,
    "square": 2,
    "1:1": 2,
    "portrait": 1,
    "9:16": 1,
}
RECAPTCHA_ACTION = "IMAGE_GENERATION"
VIDEO_RECAPTCHA_ACTION = "VIDEO_GENERATION"


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


def _recaptcha_token(cdp: _CDPConnection, project_id: str,
                     action: str = RECAPTCHA_ACTION) -> str:
    """Mint a reCAPTCHA token in the project page's own context.

    The Angular app loads enterprise.js only after navigating into a project;
    on the landing page grecaptcha is absent. Navigating here also keeps the
    token bound to the same source-path used by ogiZ0b / YhhmEf / fZytfe.
    """
    target_path = f"/project/{project_id}"
    cdp.send("Page.enable")
    probe = cdp.send("Runtime.evaluate", {
        "expression": "JSON.stringify({path: window.location.pathname, ready: !!(window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute), at: !!(window.WIZ_global_data && window.WIZ_global_data.SNlM0e)})",
        "returnByValue": True,
    })
    cur = json.loads(probe.get("result", {}).get("value") or "{}")
    if cur.get("path") != target_path or not (cur.get("ready") and cur.get("at")):
        cdp.send("Page.navigate", {"url": f"{ORIGIN}{target_path}"})
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
        const tok = await g.execute({json.dumps(RECAPTCHA_SITE_KEY)}, {{action: {json.dumps(action)}}});
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


def _service_tier(cookies: str, values: dict[str, Any]) -> int:
    """Read the signed-in account's Flow serviceTier (1=Free, 2=Pro, 3=Ultra)."""
    try:
        resp = _post_rpc(cookies, values, "nzlxg", [], source_path="/")
        if resp.status_code == 200:
            payload = _xssi_payload(resp.text, "nzlxg")
            if isinstance(payload, list) and len(payload) > 2 and isinstance(payload[2], int):
                return payload[2]
    except Exception:
        pass
    return 3


def resolve_video_wire_model(
    model: str,
    *,
    aspect_ratio: str = "landscape",
    seconds: int | None = None,
    tier: int = 3,
    extend: bool = False,
) -> str:
    """Resolve the active HTrJv videoModelKey for family, tier, aspect, and duration."""
    raw = (model or "veo-3.1").strip()
    lower = raw.lower()
    portrait = VIDEO_ASPECT_ENUM.get(aspect_ratio.lower(), 2) == 1

    if lower in ("veo-3.1", "veo-3.1-fast", "veo_3_1_t2v_fast_ultra", "veo_3_1_t2v_fast"):
        family = "fast"
    elif lower in ("veo-3.1-quality", "veo_3_1_t2v", "veo_3_1_t2v_portrait"):
        family = "quality"
    elif lower in ("veo-3.1-lite", "veo_3_1_t2v_lite"):
        family = "lite"
    else:
        return raw

    if extend:
        if family == "lite":
            raise NewFlowError("veo-3.1-lite does not support video extension; use veo-3.1 or veo-3.1-quality")
        if family == "quality":
            return "veo_3_1_extend_portrait" if portrait else "veo_3_1_extend_landscape"
        if portrait:
            return "veo_3_1_extend_fast_portrait_ultra" if tier == 3 else "veo_3_1_extend_fast_portrait"
        return "veo_3_1_extend_fast_landscape_ultra" if tier == 3 else "veo_3_1_extend_fast_landscape"

    if family == "lite":
        if tier == 3 and seconds in (4, 6):
            return f"veo_3_1_t2v_lite_{seconds}s"
        return "veo_3_1_t2v_lite"

    if family == "quality":
        if tier == 3 and seconds in (4, 6):
            return f"veo_3_1_t2v_quality_{seconds}s"
        return "veo_3_1_t2v_portrait" if portrait else "veo_3_1_t2v"

    if tier == 3 and seconds in (4, 6):
        return f"veo_3_1_t2v_fast_{seconds}s"
    if portrait:
        return "veo_3_1_t2v_fast_portrait_ultra" if tier == 3 else "veo_3_1_t2v_fast_portrait"
    return "veo_3_1_t2v_fast_ultra" if tier == 3 else "veo_3_1_t2v_fast"


def _find_video_url(node: Any) -> str | None:
    if isinstance(node, str):
        if (
            node.startswith("https://flow-content.google/")
            or node.startswith("https://storage.googleapis.com/")
            or (node.startswith("https://") and ".googleusercontent.com/" in node)
        ):
            if not node.startswith("https://flow-content.google/image/"):
                return node
        return None
    if isinstance(node, list):
        for item in node:
            found = _find_video_url(item)
            if found:
                return found
    return None


def _media_status_dict(rec: Any) -> dict[str, Any]:
    """Convert an Rz protobuf-JSON media array into FlowClient's canonical media dict."""
    if not isinstance(rec, list) or not rec or not isinstance(rec[0], str):
        return {}
    media_id = rec[0]
    workflow_id = rec[1] if len(rec) > 1 and isinstance(rec[1], str) else ""
    status_enum = None
    err_msg = ""
    pz = rec[5] if len(rec) > 5 and isinstance(rec[5], list) else None
    lv = pz[8] if pz and len(pz) > 8 and isinstance(pz[8], list) else None
    if lv:
        if isinstance(lv[0], int):
            status_enum = lv[0]
        if len(lv) > 1 and isinstance(lv[1], list) and len(lv[1]) > 1 and isinstance(lv[1][1], str):
            err_msg = lv[1][1]
        elif len(lv) > 2 and isinstance(lv[2], list) and lv[2] and isinstance(lv[2][0], str):
            err_msg = lv[2][0]

    if status_enum == 3:
        status_str = "MEDIA_GENERATION_STATUS_SUCCESSFUL"
    elif status_enum in (4, 5, 7):
        status_str = "MEDIA_GENERATION_STATUS_FAILED"
    elif status_enum in (1, 2):
        status_str = "MEDIA_GENERATION_STATUS_ACTIVE"
    else:
        status_str = "MEDIA_GENERATION_STATUS_PENDING"

    video_node = rec[7] if len(rec) > 7 else rec
    video_url = _find_video_url(video_node) or ""
    media_status: dict[str, Any] = {"mediaGenerationStatus": status_str}
    if err_msg:
        media_status["errorMessage"] = err_msg
    return {
        "name": media_id,
        "workflowId": workflow_id,
        "mediaMetadata": {"mediaStatus": media_status},
        "video": {"generatedVideo": {"fifeUrl": video_url}},
    }


def _video_assets_from_payload(
    payload: Any,
    rpcid: str,
    fallback_media_id: str,
    project_id: str,
    workflow_id: str | None,
    prompt: str,
    wire: str,
) -> list[Asset]:
    if not isinstance(payload, list):
        raise NewFlowError(f"{rpcid} returned unrecognized payload: {json.dumps(payload)[:200]}")
    records = payload[3] if len(payload) > 3 and isinstance(payload[3], list) else []
    rec = records[0] if records and isinstance(records[0], list) else None
    media_id = rec[0] if rec and isinstance(rec[0], str) else fallback_media_id
    wf_id = workflow_id or ""
    if rec and len(rec) > 1 and isinstance(rec[1], str):
        wf_id = rec[1]
    elif len(payload) > 2 and isinstance(payload[2], list) and payload[2]:
        first_wf = payload[2][0]
        if isinstance(first_wf, list) and first_wf and isinstance(first_wf[0], str):
            wf_id = first_wf[0]
    parsed = _media_status_dict(rec) if rec else {}
    status_str = (
        parsed.get("mediaMetadata", {}).get("mediaStatus", {}).get("mediaGenerationStatus")
        or "MEDIA_GENERATION_STATUS_PENDING"
    )
    if status_str == "MEDIA_GENERATION_STATUS_FAILED":
        err = parsed.get("mediaMetadata", {}).get("mediaStatus", {}).get("errorMessage") or "video generation rejected"
        raise NewFlowError(f"{rpcid} failed: {err}")
    return [Asset(
        id=media_id,
        name=f"video-{media_id[:8]}",
        asset_type=AssetType.VIDEO,
        prompt=prompt,
        url=parsed.get("video", {}).get("generatedVideo", {}).get("fifeUrl", ""),
        model=wire,
        raw={"mediaGenerationId": media_id, "workflowId": wf_id, "projectId": project_id, "source": rpcid},
    )]


def generate_video(
    *,
    prompt: str,
    aspect_ratio: str = "landscape",
    model: str = "veo-3.1",
    seed: int | None = None,
    seconds: int | None = None,
    workflow_id: str | None = None,
    debug: bool = False,
) -> list[Asset]:
    """Start async text-to-video generation through Flow's YhhmEf batchexecute RPC."""
    del seed  # YhhmEf assigns generation seeds server-side unless structured metadata is set
    fresh = _cdp_page_session()
    if not fresh:
        raise NewFlowUnavailable("no live Flow page session; sign in to gflow again")
    cookies, values = fresh
    if not values.get("at"):
        raise NewFlowUnavailable("Flow page has no SNlM0e token")
    project_id = _project_id(cookies, values)
    tier = _service_tier(cookies, values)
    wire = resolve_video_wire_model(
        model, aspect_ratio=aspect_ratio, seconds=seconds, tier=tier, extend=False
    )
    aspect = VIDEO_ASPECT_ENUM.get(aspect_ratio.lower(), 2)

    ws_url = _page_ws_url()
    cdp = _CDPConnection(ws_url)
    try:
        token = _recaptcha_token(cdp, project_id, action=VIDEO_RECAPTCHA_ACTION)
    finally:
        cdp.close()

    fresh = _cdp_page_session()
    if fresh:
        cookies, values = fresh

    media_id = str(uuid.uuid4())
    dest = (
        [None, workflow_id, None, None, media_id]
        if workflow_id
        else [None, None, None, None, media_id, str(uuid.uuid4())]
    )
    ctx = [None, TOOL_ENUM, None, None, None, project_id, None, None, None, None, [token, 1]]
    prompt_in = [None, None, [[[prompt]]]]
    item = [prompt_in, wire, aspect, None, dest, None, None, None]
    arg = [[item], ctx, [str(uuid.uuid4())]]
    resp = _post_rpc(cookies, values, "YhhmEf", arg, source_path=f"/project/{project_id}")
    if resp.status_code != 200:
        raise NewFlowError(f"YhhmEf returned HTTP {resp.status_code}")
    if "UNUSUAL_ACTIVITY" in resp.text:
        raise NewFlowError(
            "YhhmEf rejected the reCAPTCHA score (UNUSUAL_ACTIVITY); use the account Chrome briefly and retry"
        )
    payload = _xssi_payload(resp.text, "YhhmEf")
    if payload is None:
        raise NewFlowError(f"YhhmEf returned no payload: {_rpc_error(resp.text, 'YhhmEf')}")
    if debug:
        logger.info("YhhmEf started media %s (wire=%s)", media_id, wire)
    return _video_assets_from_payload(payload, "YhhmEf", media_id, project_id, workflow_id, prompt, wire)


def extend_video(
    *,
    media_id: str,
    prompt: str,
    aspect_ratio: str = "landscape",
    model: str = "veo-3.1",
    workflow_id: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    debug: bool = False,
) -> list[Asset]:
    """Start async video extension through Flow's fZytfe batchexecute RPC."""
    fresh = _cdp_page_session()
    if not fresh:
        raise NewFlowUnavailable("no live Flow page session; sign in to gflow again")
    cookies, values = fresh
    if not values.get("at"):
        raise NewFlowUnavailable("Flow page has no SNlM0e token")
    project_id = _project_id(cookies, values)
    tier = _service_tier(cookies, values)
    wire = resolve_video_wire_model(
        model, aspect_ratio=aspect_ratio, seconds=8, tier=tier, extend=True
    )
    aspect = VIDEO_ASPECT_ENUM.get(aspect_ratio.lower(), 2)

    ws_url = _page_ws_url()
    cdp = _CDPConnection(ws_url)
    try:
        token = _recaptcha_token(cdp, project_id, action=VIDEO_RECAPTCHA_ACTION)
    finally:
        cdp.close()

    fresh = _cdp_page_session()
    if fresh:
        cookies, values = fresh

    next_media_id = str(uuid.uuid4())
    dest = (
        [None, workflow_id, None, None, next_media_id]
        if workflow_id
        else [None, None, None, None, next_media_id, str(uuid.uuid4())]
    )
    ctx = [None, TOOL_ENUM, None, None, None, project_id, None, None, None, None, [token, 1]]
    qr = [None, media_id, start_sec, end_sec]
    prompt_in = [None, None, [[[prompt]]]]
    item = [qr, prompt_in, wire, aspect, None, dest]
    arg = [[item], ctx, [str(uuid.uuid4())]]
    resp = _post_rpc(cookies, values, "fZytfe", arg, source_path=f"/project/{project_id}")
    if resp.status_code != 200:
        raise NewFlowError(f"fZytfe returned HTTP {resp.status_code}")
    if "UNUSUAL_ACTIVITY" in resp.text:
        raise NewFlowError(
            "fZytfe rejected the reCAPTCHA score (UNUSUAL_ACTIVITY); use the account Chrome briefly and retry"
        )
    payload = _xssi_payload(resp.text, "fZytfe")
    if payload is None:
        raise NewFlowError(f"fZytfe returned no payload: {_rpc_error(resp.text, 'fZytfe')}")
    if debug:
        logger.info("fZytfe started extended media %s from %s (wire=%s)", next_media_id, media_id, wire)
    return _video_assets_from_payload(payload, "fZytfe", next_media_id, project_id, workflow_id, prompt, wire)


def check_video_status(
    operation_names: list[str],
    *,
    project_id: str | None = None,
    debug: bool = False,
) -> dict[str, Any]:
    """Poll video generation status through Flow's jwpduf batchexecute RPC."""
    fresh = _cdp_page_session()
    if not fresh:
        raise NewFlowUnavailable("no live Flow page session; sign in to gflow again")
    cookies, values = fresh
    if not values.get("at"):
        raise NewFlowUnavailable("Flow page has no SNlM0e token")
    pid = project_id or _project_id(cookies, values)
    arg = [None, None, [[name] for name in operation_names]]
    resp = _post_rpc(cookies, values, "jwpduf", arg, source_path=f"/project/{pid}")
    if resp.status_code != 200:
        raise NewFlowError(f"jwpduf returned HTTP {resp.status_code}")
    payload = _xssi_payload(resp.text, "jwpduf")
    if not isinstance(payload, list):
        raise NewFlowError(f"jwpduf returned no payload: {_rpc_error(resp.text, 'jwpduf')}")
    records = payload[2] if len(payload) > 2 and isinstance(payload[2], list) else []
    media = [m for m in (_media_status_dict(rec) for rec in records) if m]
    if debug:
        logger.info("jwpduf polled %d media records", len(media))
    return {"media": media, "credits": payload[1] if len(payload) > 1 else None, "projectId": pid}


def get_flow_media(media_name: str, *, project_id: str | None = None) -> dict[str, Any]:
    """Fetch a single Flow media record (including signed video URL) via iFxMud / jwpduf."""
    fresh = _cdp_page_session()
    if not fresh:
        raise NewFlowUnavailable("no live Flow page session; sign in to gflow again")
    cookies, values = fresh
    if not values.get("at"):
        raise NewFlowUnavailable("Flow page has no SNlM0e token")
    pid = project_id or _project_id(cookies, values)
    resp = _post_rpc(cookies, values, "iFxMud", [[media_name]], source_path=f"/project/{pid}")
    if resp.status_code == 200:
        payload = _xssi_payload(resp.text, "iFxMud")
        records = payload[0] if isinstance(payload, list) and payload and isinstance(payload[0], list) else []
        if records:
            parsed = _media_status_dict(records[0])
            if parsed.get("video", {}).get("generatedVideo", {}).get("fifeUrl"):
                return parsed
    polled = check_video_status([media_name], project_id=pid)
    media = polled.get("media") or []
    if media:
        return media[0]
    raise NewFlowError(f"iFxMud returned no media record for {media_name}")

