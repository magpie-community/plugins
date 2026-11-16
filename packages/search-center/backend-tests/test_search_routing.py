import asyncio
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import grok_search.server as server
from grok_search.routing import choose_model


class RoutingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.config = SimpleNamespace(
            grok_targets=[object()], primary_grok_target=SimpleNamespace(api_url="https://example.test", api_key="fake"),
            grok_model="grok-multi", grok_models=["grok-multi"],
            grok_multi_race_models=["grok-multi", "grok-heavy"],
            debug_enabled=False, exa_enabled=False, exa_api_key=None,
            tavily_enabled=False, tavily_api_key=None, firecrawl_api_key=None,
        )
        self.stack.enter_context(patch.object(server, "config", self.config))
        self.stack.enter_context(patch.object(server, "_provider_enabled", return_value=True))
        self.catalog = self.stack.enter_context(patch.object(
            server, "_get_available_models_cached",
            AsyncMock(return_value=["grok-multi", "grok-heavy", "grok-fast-reasoning", "grok-fast-non-reasoning"]),
        ))
        self.factory = self.stack.enter_context(patch.object(server, "GrokSearchProvider"))
        self.factory.return_value.search = AsyncMock(return_value="Primary answer")
        self.providers = {}
        for name in ("exa", "tavily", "firecrawl"):
            self.providers[name] = self.stack.enter_context(patch.object(
                server, f"_call_{name}_search",
                AsyncMock(return_value=[{
                    "url": f"https://example.test/{name}", "title": name,
                    "description": f"{name} source", "provider": name,
                }]),
            ))

    async def test_quick_default_uses_one_reference_channel_without_any_model(self):
        result = await server.web_search("simple fact", profile="quick", max_results=3)
        self.assertEqual(result["routing"]["selected_channels"], ["tavily"])
        self.assertEqual(result["sources_count"], 1)
        self.factory.assert_not_called()
        self.catalog.assert_not_called()
        self.providers["exa"].assert_not_called()
        self.providers["firecrawl"].assert_not_called()

    async def test_explicit_exa_does_not_require_grok_configuration(self):
        self.stack.enter_context(patch.object(server, "_provider_enabled", side_effect=lambda name: name == "exa"))
        result = await server.web_search("query", channels=["exa"], profile="quick")
        self.assertEqual(result["routing"]["selected_channels"], ["exa"])
        self.assertEqual(result["sources_count"], 1)
        self.factory.assert_not_called()
        self.providers["tavily"].assert_not_called()

    async def test_quick_grok_uses_light_model_without_race_or_fallback(self):
        result = await server.web_search("query", channels=["grok"], profile="quick")
        self.assertEqual(result["routing"]["grok_models"], ["grok-fast-non-reasoning"])
        self.factory.assert_called_once()
        self.assertEqual(self.factory.call_args.kwargs["fallback_models"], [])
        self.assertEqual(self.factory.return_value.search.call_args.kwargs["search_mode"], "both")
        for provider in self.providers.values():
            provider.assert_not_called()

    async def test_explicit_x_mode_and_structured_citations_reach_routed_result(self):
        from grok_search.providers.responses import SearchText
        metadata = {"tools_requested": ["x_search"], "tool_calls": [{"type": "x_search", "status": "completed"}]}
        self.factory.return_value.search.return_value = SearchText("Answer", [
            {"url": "https://x.com/example/status/123", "title": "Post", "source_kind": "upstream_citation"}
        ], metadata)
        result = await server.web_search("query", channels=["grok"], profile="quick", grok_search_mode="x")
        self.assertEqual(self.factory.return_value.search.call_args.kwargs["search_mode"], "x")
        self.assertEqual(result["sources"][0]["source_kind"], "upstream_citation")
        self.assertEqual(result["routing"]["grok_search_mode"], "x")
        self.assertEqual(result["routing"]["channel_results"]["grok"]["models"][0]["search"], metadata)
        self.assertEqual(result["content"], "Answer")

    async def test_explicit_model_wins_over_deep_race(self):
        result = await server.web_search("query", channels=["grok"], profile="deep", model="grok-exact")
        self.assertEqual(result["routing"]["grok_models"], ["grok-exact"])
        self.assertEqual(self.factory.call_args.kwargs["model"], "grok-exact")
        self.factory.assert_called_once()
        self.catalog.assert_not_called()

    async def test_light_model_inline_links_are_returned_without_fabricated_page_text(self):
        self.factory.return_value.search.return_value = (
            "Official docs:\n- https://docs.python.org/3/library/asyncio-task.html#task-groups\n"
            "- https://docs.python.org/3/library/asyncio.html\n\n**Sources:**\nPython documentation."
        )
        result = await server.web_search("query", channels=["grok"], profile="quick", max_results=2)
        self.assertEqual(result["sources_count"], 2)
        self.assertEqual(result["sources"][0]["source_kind"], "model_provided_url")
        self.assertNotIn("description", result["sources"][0])
        self.assertEqual(self.factory.return_value.search.call_args.kwargs["max_results"], 2)

    async def test_deep_only_runs_selected_channels_and_reports_each_model(self):
        result = await server.web_search("query", channels=["grok", "exa"], profile="deep", max_results=2)
        self.assertEqual(self.factory.call_count, 2)
        self.assertEqual(result["routing"]["grok_models"], ["grok-multi", "grok-heavy"])
        self.providers["tavily"].assert_not_called()
        self.providers["firecrawl"].assert_not_called()
        self.assertEqual(len(result["routing"]["channel_results"]["grok"]["models"]), 2)

    async def test_no_light_model_never_escalates_to_heavy(self):
        self.catalog.return_value = ["grok-heavy", "grok-multi"]
        result = await server.web_search("query", channels=["grok"], profile="quick")
        self.factory.assert_not_called()
        self.assertEqual(result["routing"]["channel_results"]["grok"]["status"], "unavailable")

    async def test_timeout_keeps_fast_selected_source_and_cancels_slow_work(self):
        cancelled = asyncio.Event()

        async def slow(*args, **kwargs):
            try:
                await asyncio.sleep(10)
            finally:
                cancelled.set()

        self.providers["firecrawl"].side_effect = slow
        result = await server.web_search(
            "query", channels=["exa", "firecrawl"], profile="balanced", time_budget_seconds=0.05,
        )
        self.assertEqual(result["sources_count"], 1)
        self.assertEqual(result["routing"]["channel_results"]["firecrawl"]["status"], "timeout")
        self.assertTrue(cancelled.is_set())
        self.providers["tavily"].assert_not_called()

    async def test_unconfigured_selected_channel_is_not_replaced(self):
        self.stack.enter_context(patch.object(server, "_provider_enabled", side_effect=lambda name: name != "exa"))
        result = await server.web_search("query", channels=["exa"], profile="quick")
        self.assertEqual(result["sources_count"], 0)
        self.assertEqual(result["routing"]["channel_results"]["exa"]["status"], "unavailable")
        for provider in self.providers.values():
            provider.assert_not_called()

    async def test_capabilities_makes_no_search_calls(self):
        result = await server.get_search_capabilities()
        self.assertEqual(result["grok"]["quick_model"], "grok-fast-non-reasoning")
        self.factory.assert_not_called()
        for provider in self.providers.values():
            provider.assert_not_called()

    async def test_invalid_selection_is_rejected_before_network(self):
        for args in [{"channels": []}, {"channels": ["unknown"]},
                     {"channels": ["exa"], "model": "grok-fast"}, {"max_results": 50}]:
            with self.assertRaises(ValueError):
                await server.web_search("query", profile="quick", **args)
        self.factory.assert_not_called()

    async def test_legacy_explicit_model_no_longer_runs_configured_race(self):
        result = await server.web_search("query", model="grok-fast-non-reasoning")
        self.factory.assert_called_once()
        self.assertEqual(self.factory.call_args.kwargs["model"], "grok-fast-non-reasoning")
        self.assertEqual(self.factory.call_args.kwargs["fallback_models"], [])
        self.assertEqual(result["content"], "Primary answer")

    def test_model_choice_excludes_heavy_and_media_models(self):
        self.assertIsNone(choose_model(["grok-heavy", "grok-multi", "grok-image-fast"], "quick"))
        self.assertEqual(choose_model(["grok-fast-reasoning", "grok-fast-non-reasoning"], "quick"),
                         "grok-fast-non-reasoning")

    async def test_explicit_specialist_channel_is_routed_without_web_or_grok(self):
        from grok_search.routing import extra_channels
        with patch.object(extra_channels, "search", AsyncMock(return_value=[
            {"title": "Repo", "url": "https://github.com/example/repo", "provider": "github"}
        ])) as external:
            result = await server.web_search("MCP language:python", channels=["github"], profile="quick")
        self.assertEqual(result["routing"]["selected_channels"], ["github"])
        self.assertEqual(result["sources_count"], 1)
        external.assert_awaited_once()
        self.factory.assert_not_called()
        for provider in self.providers.values():
            provider.assert_not_called()

    async def test_default_deep_does_not_fan_out_to_new_or_specialist_channels(self):
        from grok_search.routing import extra_channels
        with patch.object(extra_channels, "search", AsyncMock()) as external:
            result = await server.web_search("query", profile="deep")
        self.assertEqual(result["routing"]["selected_channels"], ["grok", "tavily", "exa", "firecrawl"])
        external.assert_not_called()

    async def test_rate_limit_is_reported_without_secret_exception_text(self):
        import httpx
        from grok_search.routing import extra_channels
        request = httpx.Request("GET", "https://api.github.com/search/repositories")
        response = httpx.Response(429, headers={"Retry-After": "60"}, request=request)
        failure = httpx.HTTPStatusError("sensitive-test-message", request=request, response=response)
        with patch.object(extra_channels, "search", AsyncMock(side_effect=failure)):
            result = await server.web_search("query", channels=["github"], profile="quick")
        status = result["routing"]["channel_results"]["github"]
        self.assertEqual(status["http_status"], 429)
        self.assertEqual(status["retry_after"], "60")
        self.assertNotIn("sensitive-test-message", str(result))
