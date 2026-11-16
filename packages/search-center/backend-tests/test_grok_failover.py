import os
import unittest
from unittest.mock import patch

import httpx

from grok_search.config import Config, GrokTarget
from grok_search.providers.grok import GrokSearchProvider


class ConfigTests(unittest.TestCase):
    def setUp(self):
        Config._instance = None

    def test_multiline_keys_and_fallback_target(self):
        env = {
            "GROK_API_URL": "https://api.x.ai",
            "GROK_API_KEYS": "xai-first\nxai-second",
            "GROK_FALLBACK_API_URL": "https://fallback.example.com",
            "GROK_FALLBACK_API_KEY": "fallback-key",
        }
        with patch.dict(os.environ, env, clear=False):
            config = Config()
            targets = config.grok_targets

        self.assertEqual([target.api_key for target in targets], ["xai-first", "xai-second", "fallback-key"])
        self.assertEqual(targets[0].api_url, "https://api.x.ai/v1")
        self.assertEqual(targets[-1].api_url, "https://fallback.example.com/v1")
        self.assertEqual(targets[-1].source, "fallback")

    def test_model_list_prefers_env_order(self):
        env = {
            "GROK_API_URL": "https://api.x.ai",
            "GROK_API_KEY": "xai-first",
            "GROK_MODELS": "grok-4.20-multi-agent,grok-4.20-reasoning,grok-4.3,grok-4.20-fast",
        }
        with patch.dict(os.environ, env, clear=False):
            config = Config()
            self.assertEqual(
                config.grok_models,
                [
                    "grok-4.20-multi-agent",
                    "grok-4.20-reasoning",
                    "grok-4.3",
                    "grok-4.20-fast",
                ],
            )
            self.assertEqual(config.grok_model, "grok-4.20-multi-agent")


class GrokProviderFailoverTests(unittest.IsolatedAsyncioTestCase):
    async def test_switches_to_next_key_after_rate_limit(self):
        provider = GrokSearchProvider(
            [
                GrokTarget("https://api.x.ai/v1", "xai-first", "primary", "primary-1"),
                GrokTarget("https://api.x.ai/v1", "xai-second", "primary", "primary-2"),
            ],
            model="grok-4.20-beta",
        )
        calls = []

        async def fake_execute(api_url, headers, payload, ctx=None):
            calls.append(headers["Authorization"])
            if headers["Authorization"].endswith("xai-first"):
                request = httpx.Request("POST", f"{api_url}/chat/completions")
                response = httpx.Response(429, request=request, text="rate limit")
                raise httpx.HTTPStatusError("rate limited", request=request, response=response)
            return "ok"

        provider._execute_stream_once = fake_execute

        result = await provider.search("ping")
        sticky_result = await provider.search("ping again")

        self.assertEqual(result, "ok")
        self.assertEqual(sticky_result, "ok")
        self.assertEqual(
            calls,
            [
                "Bearer xai-first",
                "Bearer xai-second",
                "Bearer xai-second",
            ],
        )

    async def test_uses_fallback_endpoint_after_all_primary_keys_fail(self):
        provider = GrokSearchProvider(
            [
                GrokTarget("https://api.x.ai/v1", "xai-first", "primary", "primary-1"),
                GrokTarget("https://api.x.ai/v1", "xai-second", "primary", "primary-2"),
                GrokTarget("https://fallback.example.com/v1", "fallback-key", "fallback", "fallback"),
            ],
            model="grok-4.20-beta",
        )
        calls = []

        async def fake_execute(api_url, headers, payload, ctx=None):
            calls.append((api_url, headers["Authorization"]))
            if "fallback.example.com" in api_url:
                return "fallback-ok"
            request = httpx.Request("POST", f"{api_url}/chat/completions")
            response = httpx.Response(403, request=request, text="forbidden")
            raise httpx.HTTPStatusError("forbidden", request=request, response=response)

        provider._execute_stream_once = fake_execute

        result = await provider.fetch("https://example.com")

        self.assertEqual(result, "fallback-ok")
        self.assertEqual(
            calls,
            [
                ("https://api.x.ai/v1", "Bearer xai-first"),
                ("https://api.x.ai/v1", "Bearer xai-second"),
                ("https://fallback.example.com/v1", "Bearer fallback-key"),
            ],
        )

    async def test_switches_to_next_model_when_primary_model_is_unavailable(self):
        provider = GrokSearchProvider(
            [
                GrokTarget("https://api.x.ai/v1", "xai-first", "primary", "primary-1"),
            ],
            model="grok-4.20-multi-agent",
            fallback_models=["grok-4.20-reasoning", "grok-4.3"],
        )
        calls = []

        async def fake_execute(api_url, headers, payload, ctx=None):
            calls.append(payload["model"])
            if payload["model"] == "grok-4.20-multi-agent":
                request = httpx.Request("POST", f"{api_url}/chat/completions")
                response = httpx.Response(
                    429,
                    request=request,
                    text="No available accounts for this model tier",
                )
                raise httpx.HTTPStatusError("rate limited", request=request, response=response)
            return "ok"

        provider._execute_stream_once = fake_execute

        result = await provider.search("ping")

        self.assertEqual(result, "ok")
        self.assertEqual(provider.model, "grok-4.20-reasoning")
        self.assertEqual(
            calls,
            [
                "grok-4.20-multi-agent",
                "grok-4.20-reasoning",
            ],
        )


if __name__ == "__main__":
    unittest.main()
