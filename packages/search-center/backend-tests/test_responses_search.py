import json
import unittest
from unittest.mock import patch

import httpx

from grok_search.providers.grok import GrokSearchProvider
from grok_search.providers.responses import SearchText, parse_response


def completed(text="Public answer", tools=True):
    output = []
    if tools:
        output = [
            {"type": "web_search_call", "id": "web-1", "status": "completed"},
            {"type": "x_search_call", "id": "x-1", "status": "completed"},
        ]
    output.append({"type": "message", "content": [{
        "type": "output_text", "text": text, "annotations": [
            {"type": "url_citation", "url": "https://x.com/example/status/123", "title": "Post"},
            {"type": "url_citation", "url": "https://example.com/docs", "title": "Docs"},
            {"type": "url_citation", "url": "javascript:alert(1)", "title": "Bad"},
        ],
    }]})
    return {"object": "response", "status": "completed", "output": output}


class ResponsesSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_default_both_uses_responses_and_keeps_other_calls_on_chat(self):
        calls = []

        def handle(request):
            body = json.loads(request.content)
            calls.append((request.url.path, body))
            if request.url.path.endswith("/responses"):
                return httpx.Response(200, json=completed())
            return httpx.Response(200, json={"choices": [{"message": {"content": "Fetched"}}]})

        actual_client = httpx.AsyncClient
        with patch("grok_search.providers.grok.httpx.AsyncClient",
                   side_effect=lambda **kw: actual_client(transport=httpx.MockTransport(handle), **kw)):
            provider = GrokSearchProvider("https://proxy.test/v1", "synthetic-unit-key", model="grok-fast")
            result = await provider.search("test")
            self.assertIsInstance(result, SearchText)
            self.assertEqual(result.answer, "Public answer")
            self.assertEqual(len(result.sources), 2)
            self.assertEqual(result.search_metadata["tools_requested"], ["web_search", "x_search"])
            await provider.search("test x", search_mode="x")
            await provider.search("test web", search_mode="web")
            self.assertEqual(await provider.fetch("https://example.com"), "Fetched")
        self.assertEqual(calls[0][0], "/v1/responses")
        self.assertEqual(calls[0][1]["tools"], [{"type": "web_search"}, {"type": "x_search"}])
        self.assertIn("input", calls[0][1])
        self.assertFalse(calls[0][1]["store"])
        self.assertEqual(calls[1][1]["tools"], [{"type": "x_search"}])
        self.assertEqual(calls[2][1]["tools"], [{"type": "web_search"}])
        self.assertEqual(calls[3][0], "/v1/chat/completions")
        with self.assertRaises(ValueError):
            await provider.search("test", search_mode="invalid")

    async def test_sse_final_output_is_authoritative_and_preserves_citations_and_calls(self):
        events = [
            {"type": "response.output_text.delta", "delta": "Partial"},
            {"type": "response.output_item.added", "item": {"type": "x_search_call", "id": "x-1", "status": "in_progress"}},
            {"type": "response.output_item.done", "item": {"type": "x_search_call", "id": "x-1", "status": "completed"}},
            {"type": "response.reasoning_text.delta", "delta": "Do not expose private reasoning"},
            {"type": "response.completed", "response": completed()},
        ]
        body = ": keepalive\r\n\r\n" + "".join(f"event: {e['type']}\r\ndata: {json.dumps(e)}\r\n\r\n" for e in events) + "data: [DONE]\r\n\r\n"
        response = httpx.Response(200, headers={"content-type": "text/event-stream"}, text=body,
                                  request=httpx.Request("POST", "https://proxy.test/v1/responses"))
        result = await parse_response(response, ["web_search", "x_search"])
        self.assertEqual(result.answer, "Public answer")
        self.assertNotIn("Partial", result)
        self.assertNotIn("private reasoning", result)
        self.assertEqual(len(result.search_metadata["tool_calls"]), 2)
        self.assertEqual(len(result.sources), 2)
        self.assertTrue(all(s["source_kind"] == "upstream_citation" for s in result.sources))

    async def test_failed_incomplete_or_truncated_stream_is_not_a_successful_search(self):
        for event in [
            {"type": "response.incomplete", "response": {"status": "incomplete"}},
            {"type": "response.output_text.delta", "delta": "Truncated"},
            {"type": "response.failed", "response": {"error": {"code": "rate_limit_exceeded", "message": "private"}}},
        ]:
            response = httpx.Response(200, headers={"content-type": "text/event-stream"},
                text="data: " + json.dumps(event) + "\n\n",
                request=httpx.Request("POST", "https://proxy.test/v1/responses"))
            with self.assertRaises((ValueError, httpx.HTTPStatusError)) as raised:
                await parse_response(response, ["x_search"])
            self.assertNotIn("private", str(raised.exception))
            if event["type"] == "response.failed":
                self.assertEqual(raised.exception.response.status_code, 429)

    async def test_http_rate_limit_remains_visible_after_provider_failover(self):
        def handle(request):
            return httpx.Response(429, headers={"Retry-After": "30"}, text="rate limited")
        actual_client = httpx.AsyncClient
        with patch("grok_search.providers.grok.httpx.AsyncClient",
                   side_effect=lambda **kw: actual_client(transport=httpx.MockTransport(handle), **kw)):
            provider = GrokSearchProvider("https://proxy.test/v1", "synthetic-unit-key")
            with self.assertRaises(httpx.HTTPStatusError) as raised:
                await provider.search("query")
        self.assertEqual(raised.exception.response.status_code, 429)
        self.assertEqual(raised.exception.response.headers["Retry-After"], "30")

    async def test_enabled_tools_are_not_reported_as_executed_without_evidence(self):
        response = httpx.Response(200, json=completed(tools=False),
                                  request=httpx.Request("POST", "https://proxy.test/v1/responses"))
        result = await parse_response(response, ["web_search", "x_search"])
        self.assertEqual(result.search_metadata["tool_calls"], [])
        self.assertEqual(result.search_metadata["tools_requested"], ["web_search", "x_search"])

    async def test_unsupported_responses_does_not_silently_fall_back_to_chat(self):
        calls = []
        def handle(request):
            calls.append(request.url.path)
            return httpx.Response(404, text="not found")
        actual_client = httpx.AsyncClient
        with patch("grok_search.providers.grok.httpx.AsyncClient",
                   side_effect=lambda **kw: actual_client(transport=httpx.MockTransport(handle), **kw)):
            provider = GrokSearchProvider("https://proxy.test/v1", "synthetic-unit-key")
            with self.assertRaises(httpx.HTTPStatusError):
                await provider.search("query")
        self.assertEqual(calls, ["/v1/responses"])


if __name__ == "__main__":
    unittest.main()
