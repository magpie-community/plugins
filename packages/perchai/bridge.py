"""A Chrome-fingerprinted HTTPS hop for Perch's sign-in.

Supabase's edge answers a browser and drops much else with a bare TCP reset, so
a Node or Bun client can fail to reach it even though the service is up. This
reads one JSON request on stdin and writes one JSON response on stdout, speaking
to Supabase through curl_cffi's browser profiles and retrying, because on a
filtered network a single handshake only sometimes survives.

    {"method":"POST","url":"…","headers":{…},"body":"…"}
 -> {"status":200,"headers":{…},"body":"…"}  or  {"error":"…"}

Used only when a direct request fails; a machine that can reach Supabase never
runs it. Needs python with curl_cffi (`pip install curl_cffi`).
"""

import json
import sys
import time

TIMEOUT = 30
ATTEMPTS = 12
# chrome survives the filter most often; the others cover the rest.
PROFILES = ("chrome", "chrome131", "chrome133a", "chrome124", "chrome136")


def main() -> int:
    try:
        req = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001 - the answer is the error
        print(json.dumps({"error": f"unreadable request: {e}"}))
        return 0

    url = req.get("url") or ""
    if not url.startswith("https://"):
        print(json.dumps({"error": "only https:// is bridged"}))
        return 0

    try:
        from curl_cffi import requests
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"curl_cffi is not installed: {e}"}))
        return 0

    method = (req.get("method") or "GET").upper()
    headers = req.get("headers") or {}
    body = req.get("body")
    data = body.encode() if isinstance(body, str) else body

    last = ""
    for i in range(ATTEMPTS):
        profile = req.get("impersonate") or PROFILES[i % len(PROFILES)]
        try:
            r = requests.request(
                method,
                url,
                headers=headers,
                data=data,
                impersonate=profile,
                timeout=TIMEOUT,
                allow_redirects=False,
            )
        except Exception as e:  # noqa: BLE001 - a reset here is the filter, not the answer
            last = f"{type(e).__name__}: {e}"
            time.sleep(0.25)
            continue
        out_headers = {}
        for k, v in r.headers.items():
            if k.lower() in ("content-type", "content-length", "location"):
                out_headers[k] = v
        print(json.dumps({"status": r.status_code, "headers": out_headers, "body": r.text}))
        return 0

    print(json.dumps({"error": f"{ATTEMPTS} attempts, last: {last}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
