"""Read-only provider quota snapshots. Never return upstream bodies or secrets."""
import math
from datetime import datetime, timezone
from urllib.parse import urlsplit


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 1e12 else None


def remaining(limit, used):
    return max(0, limit - used) if limit is not None and used is not None else None


def normalize(channel, body):
    if not isinstance(body, dict):
        raise ValueError("Invalid quota")
    if channel == "tavily" and body.get("scope") == "enabled_pool":
        if body.get("service") != "tavily" or body.get("unit") != "credits":
            raise ValueError("Invalid pool quota")
        stamp = body.get("last_synced_at")
        try:
            stamp = datetime.fromisoformat(stamp.replace("Z", "+00:00")).isoformat() if isinstance(stamp, str) else None
        except ValueError:
            stamp = None
        return {"scope": "pool", "unit": "credits", "remaining": number(body.get("remaining")),
                "used": number(body.get("used")), "limit": number(body.get("limit")),
                "syncedKeys": number(body.get("synced_keys")), "totalKeys": number(body.get("total_keys")),
                "errorKeys": number(body.get("error_keys")), "sourceUpdatedAt": stamp,
                "stale": body.get("stale") is not False, "estimate": True}
    if channel == "tavily":
        account = body.get("account") or {}
        key = body.get("key") or {}
        if not isinstance(account, dict) or not isinstance(key, dict):
            raise ValueError("Invalid quota")
        used, limit = number(account.get("plan_usage")), number(account.get("plan_limit"))
        ku, kl = number(key.get("usage")), number(key.get("limit"))
        if all(v is None for v in (used, limit, ku, kl)):
            raise ValueError("Unknown quota response")
        return {"scope": "account", "unit": "credits", "remaining": remaining(limit, used), "used": used,
                "limit": limit, "keyUsed": ku, "keyLimit": kl, "keyRemaining": remaining(kl, ku),
                "stale": False, "estimate": False}
    if channel == "firecrawl":
        data = body.get("data") or {}
        balance = number(data.get("remainingCredits")) if isinstance(data, dict) else None
        if balance is None:
            raise ValueError("Unknown quota response")
        return {"scope": "team", "unit": "credits", "remaining": balance, "used": None,
                "limit": None, "stale": False, "estimate": False}
    raise ValueError("Unsupported quota")


async def query(channel, base, key):
    import httpx
    if channel not in ("tavily", "firecrawl"):
        return {"status": "unsupported"}
    base = base or ("https://api.tavily.com" if channel == "tavily" else "https://api.firecrawl.dev")
    parsed = urlsplit(base)
    if parsed.scheme not in ("https", "http") or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return {"status": "error", "code": "INVALID_ENDPOINT"}
    base = base.rstrip("/")
    if channel == "tavily":
        candidates = [base + "/usage"]
    else:
        candidates = [base + ("" if base.endswith(("/v1", "/v2")) else "/v2") + "/team/credit-usage"]
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=False) as client:
            async with client.stream("GET", candidates[0], headers={"Authorization": "Bearer " + key}) as response:
                if response.status_code != 200:
                    return {"status": "error", "code": "QUOTA_HTTP", "httpStatus": response.status_code}
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 128 * 1024:
                        return {"status": "error", "code": "RESPONSE_LIMIT"}
        import json
        return {"status": "ok", **normalize(channel, json.loads(raw)), "queriedAt": datetime.now(timezone.utc).isoformat()}
    except Exception:
        return {"status": "error", "code": "QUOTA_UNAVAILABLE"}
