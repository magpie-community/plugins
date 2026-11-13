"""Read Flow account identity and credit balance from the signed-in app shell.

A GET of ``flow.google.com/`` with the account's Cookie header returns WIZ
bootstrap values; one ``nzlxg`` batchexecute call returns the credit balance
the Flow account menu shows.  Identity and quota are separate capabilities:
a shell without ``SNlM0e`` can still name the signed-in account, and a 200
shell without either is reported as a signed-out shell rather than a hard
account error.  Browser login never depends on this quota read succeeding.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlencode

import requests

ORIGIN = "https://flow.google.com"
BATCHEXECUTE = f"{ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute"
CREDITS_RPC = "nzlxg"
SHELL_TIMEOUT = 30
RPC_TIMEOUT = 30
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

_WIZ_STRING = re.compile(r'"([A-Za-z0-9_]+)"\s*:\s*"((?:\\.|[^"\\])*)"')
_XSSI_PREFIX = ")]}'"
_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class AccountInfoError(Exception):
    """Safe, bounded error for magpie's account/usage hooks."""


class CreditsUnavailable(AccountInfoError):
    """The identity is known, but the current shell cannot read credits."""


def _wiz_values(html: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for key, raw in _WIZ_STRING.findall(html):
        try:
            value = json.loads(f'"{raw}"')
        except (ValueError, TypeError):
            continue
        if isinstance(value, str):
            values.setdefault(key, value)
    return values


def _email_from_shell(html: str) -> str:
    """Extract the signed-in account email without logging the shell."""
    values = _wiz_values(html)
    for key in ("oPEP7c", "o30O0e", "email", "userEmail"):
        value = values.get(key, "").strip()
        if _EMAIL.fullmatch(value):
            return value
    # Google can put the signed-in address in a non-WIZ bootstrap string.
    # Only values that look exactly like one email address are accepted.
    for match in re.findall(r'"([^"\\]+@[^"\\]+)"', html):
        if _EMAIL.fullmatch(match.strip()):
            return match.strip()
    return ""


def _proxy_for() -> dict[str, str] | None:
    try:
        from gflow.api.client import get_active_proxy
    except Exception:
        return None
    proxy_url = get_active_proxy()
    return {"https": proxy_url, "http": proxy_url} if proxy_url else None


def _shell_headers(cookies: str) -> dict[str, str]:
    # Match a real top-level navigation.  Google can return a 200 consent or
    # signed-out shell for narrower fetch-style headers even with valid cookies.
    return {
        "Cookie": cookies,
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
    }


def _shell(cookies: str) -> tuple[str, dict[str, str]]:
    headers = _shell_headers(cookies)
    try:
        response = requests.get(f"{ORIGIN}/", headers=headers, timeout=SHELL_TIMEOUT,
                                allow_redirects=False, proxies=_proxy_for())
    except requests.RequestException as exc:
        raise AccountInfoError(f"could not load Flow account shell: {type(exc).__name__}") from exc
    if response.status_code in (401, 403):
        raise AccountInfoError("Flow account cookies are no longer signed in")
    if response.status_code in (301, 302, 303, 307, 308):
        raise AccountInfoError("Flow redirected the account shell to sign-in; sign in to gflow again")
    if response.status_code != 200:
        raise AccountInfoError(f"Flow account shell returned HTTP {response.status_code}")
    return response.text, headers


def _wrb_payloads(text: str) -> list[Any]:
    body = text.lstrip()
    if body.startswith(_XSSI_PREFIX):
        body = body[len(_XSSI_PREFIX):]
    decoder = json.JSONDecoder()
    payloads: list[Any] = []
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
            if not isinstance(item, list) or len(item) < 3 or item[0] != "wrb.fr" or item[1] != CREDITS_RPC:
                continue
            value = item[2]
            if not isinstance(value, str):
                continue
            try:
                payloads.append(json.loads(value))
            except ValueError:
                continue
    return payloads


def _credits_from_reply(text: str) -> int:
    for payload in _wrb_payloads(text):
        if isinstance(payload, list) and payload:
            value = payload[0]
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                return value
    raise AccountInfoError("Flow credit balance was not present in the nzlxg reply")


def read_identity(cookies: str) -> dict[str, Any]:
    """Return the best-effort signed-in identity; never fail for a quota miss."""
    if not cookies or "=" not in cookies or "\n" in cookies or "\r" in cookies:
        raise AccountInfoError("missing account cookies; sign in to gflow in magpie first")
    html, headers = _shell(cookies)
    email = _email_from_shell(html)
    values = _wiz_values(html)
    return {
        "email": email,
        "name": "",
        "html": html,
        "cookies": cookies,
        "headers": headers,
        "values": values,
    }


def _rpc_headers(cookies: str) -> dict[str, str]:
    # batchexecute is a same-origin XHR, not a top-level document navigation.
    return {
        "Cookie": cookies,
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "Origin": ORIGIN,
        "Referer": f"{ORIGIN}/",
        "X-Same-Domain": "1",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    }


def _cdp_page_session() -> tuple[str, dict[str, Any]] | None:
    """Fresh cookies + WIZ values from the account's live Flow page, if any.

    The Angular shell stopped embedding ``SNlM0e`` in its static HTML; only
    the rendered page carries it. When the browser-login Chrome for this
    account is still running, read both the token and browser-fresh cookies
    from it (the plugin keeps that Chrome alive exactly for reCAPTCHA/CDP).
    """
    try:
        from gflow.auth.browser_auth import get_saved_cdp_port
        from gflow.auth.browser_auth import _CDPConnection, _wait_for_cdp_page, _browser_cdp_ws_url
    except Exception:
        return None
    port = get_saved_cdp_port()
    if not port:
        return None
    try:
        ws_url = _wait_for_cdp_page(port, timeout=0.5)
    except Exception:
        # On macOS Chrome can outlive its last tab; the token needs a page.
        browser = None
        try:
            browser = _CDPConnection(_browser_cdp_ws_url(port))
            browser.send("Target.createTarget", {"url": f"{ORIGIN}/", "background": True})
            ws_url = _wait_for_cdp_page(port, timeout=3, target_url=f"{ORIGIN}/")
        except Exception:
            return None
        finally:
            if browser is not None:
                browser.close()
    cdp = None
    try:
        cdp = _CDPConnection(ws_url)
        page = cdp.send("Runtime.evaluate", {
            "expression": "(async()=>{const end=Date.now()+2000;"
                          "while(!window.WIZ_global_data?.SNlM0e && Date.now()<end)"
                          " await new Promise(r=>setTimeout(r,50));"
                          "const w=window.WIZ_global_data||{};"
                          f"if(location.origin!=={json.dumps(ORIGIN)}) return JSON.stringify({{}});"
                          "return JSON.stringify({at:w.SNlM0e,bl:w.cfb2h,fsid:w.FdrFJe});})()",
            "awaitPromise": True,
            "returnByValue": True,
        })
        page_values = json.loads(page.get("result", {}).get("value") or "{}")
        # Keep both key spellings: read_credits() queries WIZ names, while the
        # CDP-based image path uses the short names.
        values = {
            "SNlM0e": page_values.get("at"),
            "cfb2h": page_values.get("bl"),
            "FdrFJe": page_values.get("fsid"),
            "at": page_values.get("at"),
            "bl": page_values.get("bl"),
            "fsid": page_values.get("fsid"),
        }
        if not values.get("at"):
            return None
        cdp.send("Network.enable")
        cookies = cdp.send("Network.getCookies", {"urls": [f"{ORIGIN}/"]}).get("cookies", [])
        if not cookies:
            return None
        cookie_str = "; ".join(f'{c["name"]}={c["value"]}' for c in cookies)
        return cookie_str, values
    except Exception:
        return None
    finally:
        if cdp is not None:
            cdp.close()

def read_credits(identity: dict[str, Any], cookies: str = "") -> int:
    """Read credits using WIZ tokens from a previously loaded shell."""
    values = identity.get("values") if isinstance(identity, dict) else None
    if not isinstance(values, dict):
        raise CreditsUnavailable("Flow account shell did not include WIZ session values")
    at = str(values.get("SNlM0e") or "")
    if not at:
        # The Angular shell no longer embeds the XSRF token in static HTML.
        # Fall back to the account's live Flow page before giving up.
        fresh = _cdp_page_session()
        if fresh is None:
            raise CreditsUnavailable("Flow account shell did not include an authenticated session token")
        cookies, values = fresh
        identity = {**identity, "values": values}
        at = str(values.get("at") or "")
        if not at:
            raise CreditsUnavailable("Flow page did not include an authenticated session token")
    query = {
        "rpcids": CREDITS_RPC,
        "source-path": "/",
        "bl": values.get("cfb2h"),
        "f.sid": values.get("FdrFJe"),
        "hl": "en",
        "rt": "c",
    }
    query = {key: value for key, value in query.items() if value is not None}
    body = urlencode({"f.req": json.dumps([[[CREDITS_RPC, "[]", None, "generic"]]]), "at": at})

    def _post(cookie_header: str):
        return requests.post(f"{BATCHEXECUTE}?{urlencode(query)}", data=body,
                             headers=_rpc_headers(cookie_header or str(identity.get("cookies") or "")),
                             timeout=RPC_TIMEOUT, allow_redirects=False, proxies=_proxy_for())

    try:
        response = _post(cookies)
        if response.status_code in (401, 403):
            # magpie's saved cookie set can fall behind the browser's. Retry
            # once with browser-fresh cookies + the live page token.
            fresh = _cdp_page_session()
            if fresh:
                fresh_cookies, fresh_values = fresh
                body = urlencode({"f.req": json.dumps([[[CREDITS_RPC, "[]", None, "generic"]]]),
                                  "at": str(fresh_values.get("at") or at)})
                response = _post(fresh_cookies)
    except requests.RequestException as exc:
        raise AccountInfoError(f"could not read Flow credit balance: {type(exc).__name__}") from exc
    if response.status_code in (401, 403):
        raise AccountInfoError("Flow rejected the credit balance read; sign in to gflow again")
    if response.status_code in (429, 503):
        raise CreditsUnavailable("Flow is throttling credit balance reads; try again in a minute")
    if response.status_code != 200:
        raise AccountInfoError(f"Flow credit balance read returned HTTP {response.status_code}")
    return _credits_from_reply(response.text)


def read_account_info(cookies: str, credits_required: bool = False) -> dict[str, Any]:
    """Return signed-in email and, when available, the credit balance.

    ``credits`` is ``None`` for identity-only reads.  Set ``credits_required``
    when the caller cannot proceed without a balance (the magpie Usage hook).
    Errors carry status classes but never response bodies, cookies or tokens.
    """
    identity = read_identity(cookies)
    result: dict[str, Any] = {
        "email": str(identity.get("email") or ""),
        "name": str(identity.get("name") or ""),
        "credits": None,
    }
    if not credits_required:
        return result
    result["credits"] = read_credits(identity)
    return result
