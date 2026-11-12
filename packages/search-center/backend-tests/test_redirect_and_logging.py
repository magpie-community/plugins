import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

import grok_search.channels as channels
import grok_search.server as server
from grok_search.config import Config, GrokTarget
from grok_search.providers.grok import GrokSearchProvider


class RedirectAndLoggingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        Config._instance = None
        server._ENDPOINT_CACHE.clear()
        server._AVAILABLE_MODELS_CACHE.clear()

    async def test_p1_server_candidates_never_follow_redirects_or_duplicate_auth_headers(self):
        secret = "synthetic-provider-key-0000"
        env = {
            "TAVILY_ENABLED": "true",
            "TAVILY_API_URL": "https://api.tavily.com",
            "TAVILY_API_KEY": secret,
            "FIRECRAWL_API_URL": "https://api.firecrawl.dev",
            "FIRECRAWL_API_KEY": secret,
            "EXA_ENABLED": "true",
            "EXA_API_URL": "https://api.exa.ai",
            "EXA_API_KEY": secret,
        }
        with patch.dict(os.environ, env, clear=False):
            cfg = Config()
            with patch.object(server, "config", cfg):
                for name, invoke in [
                    ("tavily", lambda t: server._call_tavily_search("test", 2, transport=t)),
                    ("firecrawl", lambda t: server._call_firecrawl_search("test", 2, transport=t)),
                    ("exa", lambda t: server._call_exa_search("test", 2, transport=t)),
                    ("grok_models", lambda t: server._fetch_available_models("https://api.x.ai/v1", secret, transport=t)),
                ]:
                    with self.subTest(provider=name):
                        collector_hits = []
                        seen_headers = []

                        def handler(request: httpx.Request) -> httpx.Response:
                            if request.url.host == "collector.invalid":
                                collector_hits.append(dict(request.headers))
                                return httpx.Response(200, json={"results": []})
                            seen_headers.append(request.headers)
                            return httpx.Response(302, headers={"Location": "https://collector.invalid/x"})

                        with self.assertRaises(RuntimeError) as ctx:
                            await invoke(httpx.MockTransport(handler))
                        self.assertEqual(collector_hits, [])
                        self.assertNotIn(secret, str(ctx.exception))
                        for hdrs in seen_headers:
                            self.assertEqual(hdrs.get_list("authorization"), [f"Bearer {secret}"])
                            self.assertEqual(hdrs.get_list("x-api-key"), [])

    async def test_b9_channels_never_follow_cross_host_redirects(self):
        secret = "synthetic-channel-key-0000"
        fake_env = {
            "YOU_API_KEY": secret,
            "BRAVE_API_KEY": secret,
            "PARALLEL_API_KEY": secret,
            "PERPLEXITY_API_KEY": secret,
            "BOCHA_API_KEY": secret,
            "SERPER_API_KEY": secret,
            "GITHUB_SEARCH_TOKEN": secret,
            **{f"{name.upper()}_ENABLED": "true" for name in channels.CATALOG},
        }
        with patch.dict(os.environ, fake_env, clear=False):
            for name in ("you", "brave", "parallel", "perplexity", "bocha", "serper", "github"):
                with self.subTest(channel=name):
                    collector_hits = []

                    def handler(request: httpx.Request) -> httpx.Response:
                        if request.url.host == "collector.invalid":
                            collector_hits.append(dict(request.headers))
                            return httpx.Response(200, json={"results": []})
                        return httpx.Response(302, headers={"Location": "https://collector.invalid/x"})

                    with self.assertRaises(httpx.HTTPStatusError) as ctx:
                        await channels.search(name, "query", 2, transport=httpx.MockTransport(handler))
                    self.assertEqual(ctx.exception.response.status_code, 302)
                    self.assertEqual(collector_hits, [])

    async def test_b10_grok_provider_never_follows_redirects_on_search_or_fetch(self):
        secret = "synthetic-grok-key-0000"
        collector_hits = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "collector.invalid":
                collector_hits.append(dict(request.headers))
                return httpx.Response(200, text="data: [DONE]\n\n")
            return httpx.Response(302, headers={"Location": "https://collector.invalid/x"})

        provider = GrokSearchProvider(
            [GrokTarget("https://api.x.ai/v1", secret, "primary", "primary-1")],
            model="grok-4.20-beta",
            transport=httpx.MockTransport(handler),
        )
        with self.assertRaises(httpx.HTTPStatusError) as search_err:
            await provider.search("query")
        self.assertEqual(search_err.exception.response.status_code, 302)

        with self.assertRaises(httpx.HTTPStatusError) as fetch_err:
            await provider.fetch("https://example.com")
        self.assertEqual(fetch_err.exception.response.status_code, 302)
        self.assertEqual(collector_hits, [])

    async def test_p2_no_stray_logs_in_home_or_cwd_and_corrupt_config_raises(self):
        with tempfile.TemporaryDirectory() as fake_home, tempfile.TemporaryDirectory() as fake_cwd:
            old_cwd = os.getcwd()
            os.chdir(fake_cwd)
            try:
                env = {
                    "HOME": fake_home,
                    "USERPROFILE": fake_home,
                    "TAVILY_ENABLED": "true",
                    "TAVILY_API_URL": "https://api.tavily.com",
                    "TAVILY_API_KEY": "synthetic-key",
                }
                with patch.dict(os.environ, env, clear=False):
                    os.environ.pop("GROK_LOG_DIR", None)
                    os.environ.pop("GROK_CONFIG_DIR", None)
                    os.environ.pop("SEARCH_CENTER_DATA_DIR", None)
                    Config._instance = None
                    cfg = Config()
                    with patch.object(server, "config", cfg):
                        results = await server._call_tavily_search(
                            "query",
                            1,
                            transport=httpx.MockTransport(
                                lambda req: httpx.Response(
                                    200,
                                    json={"results": [{"url": "https://example.org", "title": "Example"}]},
                                )
                            ),
                        )
                        self.assertEqual(len(results), 1)
                    self.assertEqual(list(Path(fake_home).iterdir()), [])
                    self.assertEqual(list(Path(fake_cwd).iterdir()), [])

                    bad_dir = Path(fake_home) / "cfg"
                    bad_dir.mkdir()
                    (bad_dir / "config.json").write_text("{corrupt", encoding="utf-8")
                    with patch.dict(os.environ, {"GROK_CONFIG_DIR": str(bad_dir), "GROK_API_URL": "https://api.x.ai"}, clear=False):
                        Config._instance = None
                        corrupt_cfg = Config()
                        with self.assertRaises(json.JSONDecodeError):
                            _ = corrupt_cfg.grok_models
            finally:
                os.chdir(old_cwd)

    def test_removed_project_mutating_tools_and_agent_prompts_are_absent(self):
        self.assertFalse(hasattr(server, "toggle_builtin_tools"))
        self.assertFalse(hasattr(server, "switch_model"))
        self.assertFalse(hasattr(server, "mcp"))
        source = Path(server.__file__).read_text(encoding="utf-8")
        self.assertNotIn("Please evaluate the above candidates", source)
        self.assertNotIn(".claude", source)
