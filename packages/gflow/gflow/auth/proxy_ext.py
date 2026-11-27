"""
Generate a tiny Chrome extension that handles proxy authentication.

Chrome's --proxy-server flag doesn't support user:pass authentication.
This module creates a minimal Manifest V3 extension that:
1. Sets Chrome to use the configured proxy via chrome.proxy API
2. Handles the 407 auth challenge automatically via onAuthRequired

The extension is written to ~/.gflow/proxy-ext/ and loaded via
--load-extension when Chrome launches.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger("gflow.auth.proxy")


def gflow_home() -> Path:
    override = os.environ.get("GFLOW_HOME", "").strip()
    return Path(override).expanduser() if override else Path.home() / ".gflow"


def ext_dir() -> Path:
    return gflow_home() / "proxy-ext"


EXT_DIR = ext_dir()  # Backward-compatible constant; resolve GFLOW_HOME at call time.


def create_proxy_extension(host: str, port: int, username: str, password: str,
                           scheme: str = "http") -> str:
    """Create a Chrome proxy auth extension and return its path.

    Args:
        host: Proxy hostname
        port: Proxy port
        username: Proxy username
        password: Proxy password
        scheme: Proxy scheme (http or socks5)

    Returns:
        Path to the extension directory (for --load-extension)
    """
    target = ext_dir()
    target.mkdir(parents=True, exist_ok=True)

    # Manifest V3
    manifest = {
        "version": "1.0.0",
        "manifest_version": 3,
        "name": "Proxy Auth",
        "permissions": ["proxy", "webRequest", "webRequestAuthProvider"],
        "host_permissions": ["<all_urls>"],
        "background": {
            "service_worker": "background.js"
        }
    }

    # Background service worker
    background_js = f"""
// Set proxy configuration
chrome.proxy.settings.set({{
    value: {{
        mode: "fixed_servers",
        rules: {{
            singleProxy: {{
                scheme: "{scheme}",
                host: "{host}",
                port: {port}
            }},
            bypassList: ["localhost", "127.0.0.1"]
        }}
    }},
    scope: "regular"
}});

// Handle proxy authentication
chrome.webRequest.onAuthRequired.addListener(
    function(details) {{
        return {{
            authCredentials: {{
                username: "{username}",
                password: "{password}"
            }}
        }};
    }},
    {{ urls: ["<all_urls>"] }},
    ["blocking"]
);
"""

    (target / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (target / "background.js").write_text(background_js)

    logger.info("Proxy extension created at %s (-> %s:%d)", target, host, port)
    return str(target)


def get_chrome_proxy_args() -> list[str]:
    """Return Chrome CLI args to route all traffic through the residential proxy.

    Returns empty list if no proxy is configured.
    Uses the first proxy from ~/.gflow/proxies.txt (sticky session).
    """
    try:
        from gflow.api.client import get_active_proxy, parse_proxy_url
    except ImportError:
        return []

    proxy_url = get_active_proxy()
    if not proxy_url:
        return []

    info = parse_proxy_url(proxy_url)
    if not info["host"]:
        return []

    # Create proxy auth extension
    ext_path = create_proxy_extension(
        host=info["host"],
        port=info["port"],
        username=info["username"],
        password=info["password"],
        scheme=info["scheme"],
    )

    return [f"--load-extension={ext_path}"]
