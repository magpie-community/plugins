import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import grok_search.server as server


class SearchBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def run_search(self, race_models, budget, primary):
        config = SimpleNamespace(
            grok_targets=[object()],
            primary_grok_target=object(),
            grok_model="test-model",
            grok_models=["test-model"],
            grok_multi_race_models=race_models,
            debug_enabled=False,
        )
        fast_source = AsyncMock(return_value=[
            {"title": "Reference", "url": "https://example.com/ref", "description": "Actual source text"}
        ])
        cancelled = asyncio.Event()

        async def slow_source(*args, **kwargs):
            try:
                await asyncio.sleep(10)
            finally:
                cancelled.set()

        with (
            patch.object(server, "config", config),
            patch.object(server, "_allocate_extra_sources", return_value={"exa": 1, "tavily": 0, "firecrawl": 1}),
            patch.object(server, "GrokSearchProvider") as provider,
            patch.object(server, "_call_exa_search", fast_source),
            patch.object(server, "_call_firecrawl_search", slow_source if budget else AsyncMock(return_value=[])),
        ):
            provider.return_value.search = primary
            result = await server.web_search(
                "test query", extra_sources=3, time_budget_seconds=budget,
            )
        sources = await server.get_sources(result["session_id"])
        return result, sources, cancelled

    async def test_single_model_timeout_keeps_completed_sources(self):
        primary_cancelled = asyncio.Event()

        async def slow_primary(*args, **kwargs):
            try:
                await asyncio.sleep(10)
            finally:
                primary_cancelled.set()

        result, sources, cancelled = await self.run_search([], 0.05, slow_primary)
        self.assertEqual(sources["sources"][0]["url"], "https://example.com/ref")
        self.assertEqual(result["sources_count"], 1)
        self.assertTrue(primary_cancelled.is_set())
        self.assertTrue(cancelled.is_set())

    async def test_model_race_timeout_keeps_completed_sources(self):
        async def slow_primary(*args, **kwargs):
            await asyncio.sleep(10)

        result, sources, cancelled = await self.run_search(["test-model"], 0.05, slow_primary)
        self.assertEqual(result["sources_count"], 1)
        self.assertEqual(sources["sources"][0]["description"], "Actual source text")
        self.assertTrue(cancelled.is_set())

    async def test_default_budget_preserves_primary_answer(self):
        result, sources, _ = await self.run_search([], 0, AsyncMock(return_value="Primary answer"))
        self.assertEqual(result["content"], "Primary answer")
        self.assertEqual(sources["sources_count"], 1)


if __name__ == "__main__":
    unittest.main()
