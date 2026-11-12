import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from grok_search import channels


FIXTURES = {
    "you": {"results": {"web": [{"title": "You", "url": "https://example.org/you", "snippets": ["A", "B"]}], "news": []}},
    "brave": {"web": {"results": [{"title": "Brave", "url": "https://example.org/brave", "description": "A <b>snippet</b>"}]}},
    "parallel": {"results": [{"title": "Parallel", "url": "https://example.org/parallel", "excerpts": ["A", "B"]}]},
    "perplexity": {"results": [{"title": "Perplexity", "url": "https://example.org/perplexity", "snippet": "Text", "date": "2026-01-01"}]},
    "bocha": {"code": 200, "data": {"webPages": {"value": [{"name": "博查", "url": "https://example.org/bocha", "summary": "中文摘要"}]}}},
    "serper": {"organic": [{"title": "Google result", "link": "https://example.org/serper", "snippet": "Snippet"}]},
    "searxng": {"results": [{"title": "SearXNG", "url": "https://example.org/searxng", "content": "Snippet"}]},
    "github": {"items": [{"full_name": "owner/project", "html_url": "https://github.com/owner/project", "description": "A repository"}]},
    "crossref": {"status": "ok", "message": {"items": [{"title": ["Paper"], "URL": "https://doi.org/10.1234/example", "DOI": "10.1234/example", "published": {"date-parts": [[2026, 1, 2]]}}]}},
    "arxiv": '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1234.5678</id><title> Paper title </title><summary> Abstract text </summary><published>2026-01-01</published><link rel="alternate" href="https://arxiv.org/abs/1234.5678"/></entry></feed>',
}


class ChannelTests(unittest.IsolatedAsyncioTestCase):
    def test_all_channel_shapes_normalize(self):
        for name, fixture in FIXTURES.items():
            with self.subTest(channel=name):
                result = channels.normalize(name, fixture, 1)
                self.assertEqual(len(result), 1)
                self.assertEqual(result[0]["provider"], name)
                self.assertTrue(result[0]["url"].startswith("https://"))
                self.assertTrue(result[0]["title"])
        self.assertEqual(channels.normalize("bocha", FIXTURES["bocha"], 1)[0]["description"], "中文摘要")

    def test_api_errors_do_not_become_success(self):
        for name, bad in [("bocha", {"code": 401}), ("brave", {"type": "ErrorResponse"}),
                          ("serper", {"message": "bad key"}), ("crossref", {"status": "failed"})]:
            with self.subTest(channel=name), self.assertRaises(ValueError):
                channels.normalize(name, bad, 3)

    def test_limits_deduplication_and_bad_urls(self):
        fixture = {"results": [
            {"url": "javascript:alert(1)", "title": "Bad"},
            {"url": "https://[invalid", "title": "Bad"},
            {"url": "https://example.org/a", "title": "A"},
            {"url": "https://example.org/a", "title": "Duplicate"},
            {"url": "https://example.org/b", "title": "B"},
        ]}
        self.assertEqual(len(channels.normalize("searxng", fixture, 1)), 1)
        self.assertEqual(len(channels.normalize("searxng", fixture, 10)), 2)

    def test_missing_secrets_are_reported_by_name_without_values(self):
        with patch.dict(os.environ, {"BRAVE_API_KEY": ""}, clear=False):
            info = channels.availability("brave")
            self.assertFalse(info["configured"])
            self.assertEqual(info["missing_env"], ["BRAVE_API_KEY"])
        with patch.dict(os.environ, {"BRAVE_API_KEY": "test-secret", "BRAVE_ENABLED": "false"}, clear=False):
            info = channels.availability("brave")
            self.assertFalse(info["configured"])
            self.assertNotIn("test-secret", json.dumps(info))

    async def test_each_http_contract_and_auth_location(self):
        fake_env = {
            "BRAVE_API_KEY": "test-secret", "PARALLEL_API_KEY": "test-secret",
            "PERPLEXITY_API_KEY": "test-secret", "BOCHA_API_KEY": "test-secret",
            "SERPER_API_KEY": "test-secret", "SEARXNG_URL": "http://localhost:8888",
            "YOU_API_KEY": "", "GITHUB_SEARCH_TOKEN": "",
            **{f"{name.upper()}_ENABLED": "true" for name in channels.CATALOG},
        }
        with patch.dict(os.environ, fake_env, clear=False):
            for name, fixture in FIXTURES.items():
                with self.subTest(channel=name):
                    requests = []

                    def handler(request):
                        requests.append(request)
                        self.assertNotIn("test-secret", str(request.url))
                        if name == "arxiv":
                            return httpx.Response(200, text=fixture)
                        return httpx.Response(200, json=fixture)

                    result = await channels.search(name, "test query", 2, transport=httpx.MockTransport(handler))
                    self.assertEqual(len(result), 1)
                    request = requests[0]
                    if name == "parallel":
                        self.assertEqual(request.url.path, "/v1/search")
                        self.assertEqual(json.loads(request.content)["mode"], "turbo")
                    if name == "perplexity":
                        self.assertEqual(request.url.path, "/search")
                        self.assertNotIn("model", json.loads(request.content))
                        self.assertEqual(json.loads(request.content)["search_type"], "fast")
                    if name == "github":
                        self.assertEqual(request.url.path, "/search/repositories")
                        self.assertNotIn("authorization", request.headers)
                    if name == "you":
                        self.assertEqual(request.url.path, "/v1/agents/search")
                    if name == "brave":
                        self.assertEqual(request.headers["X-Subscription-Token"], "test-secret")
                    if name == "searxng":
                        self.assertEqual(request.url.params["format"], "json")

    async def test_you_key_uses_paid_endpoint_without_falling_back(self):
        requests = []

        def handler(request):
            requests.append(request)
            return httpx.Response(401, json={"error": "bad key"})

        with patch.dict(os.environ, {"YOU_API_KEY": "test-secret"}, clear=False):
            with self.assertRaises(httpx.HTTPStatusError):
                await channels.search("you", "query", 2, transport=httpx.MockTransport(handler))
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].url.host, "ydc-index.io")
        self.assertEqual(requests[0].headers["X-API-Key"], "test-secret")

    async def test_missing_config_never_calls_network(self):
        with patch.dict(os.environ, {"BRAVE_API_KEY": ""}, clear=False):
            with self.assertRaises(ValueError):
                await channels.search("brave", "query", 2,
                    transport=httpx.MockTransport(lambda request: self.fail("Network must not be called")))

    def test_plugin_channel_catalog_matches_backend(self):
        import re
        from grok_search.routing import CHANNELS
        plugin = (Path(__file__).resolve().parents[1] / "adapter.mjs").read_text(encoding="utf-8")
        block = plugin.split("export const CHANNEL_NAMES = {", 1)[1].split("};", 1)[0]
        ids = re.findall(r"\b([a-z]+):\s*['\"]", block)
        self.assertEqual(set(ids), set(CHANNELS))
