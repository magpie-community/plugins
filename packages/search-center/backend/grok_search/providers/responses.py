"""Responses search transport parsing; only public answers/citations are returned."""
import json
from urllib.parse import urlsplit

import httpx

SEARCH_MODES = {
    "both": ("web_search", "x_search"),
    "web": ("web_search",),
    "x": ("x_search",),
}


class SearchText(str):
    """Keep the legacy text contract while preserving structured search evidence."""
    def __new__(cls, answer, sources, metadata):
        references = "\n".join(f"- [{s['title']}]({s['url']})" for s in sources)
        obj = super().__new__(cls, answer + ("\n\nSources:\n" + references if references else ""))
        obj.answer, obj.sources, obj.search_metadata = answer, sources, metadata
        return obj


async def parse_response(response, requested):
    texts, sources, calls = {}, {}, {}
    final = None
    total = 0

    def citation(value):
        if not isinstance(value, dict):
            return
        value = value.get("url_citation", value)
        url = value.get("url") if isinstance(value, dict) else None
        if not isinstance(url, str):
            return
        try:
            parsed = urlsplit(url)
            if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username is not None:
                return
        except ValueError:
            return
        title = value.get("title")
        sources[url] = {
            "url": url, "title": title if isinstance(title, str) and title else url,
            "provider": "grok", "source_kind": "upstream_citation",
        }

    def item(value):
        if not isinstance(value, dict):
            return
        kind = value.get("type", "")
        if kind == "message":
            for part in value.get("content", []):
                if isinstance(part, dict):
                    for entry in part.get("annotations", []):
                        citation(entry)
        if kind in ("web_search_call", "x_search_call"):
            identity = value.get("id") or f"{kind}-{len(calls)}"
            calls[identity] = {
                "type": kind.removesuffix("_call"),
                "status": value.get("status", "unknown"),
            }

    def failed(payload):
        error = payload.get("error") or {}
        code = str(error.get("code", "")) if isinstance(error, dict) else ""
        status = {"rate_limit_exceeded": 429, "insufficient_quota": 402,
                  "invalid_api_key": 401, "authentication_error": 401}.get(code, 502)
        safe = httpx.Response(status, request=response.request)
        raise httpx.HTTPStatusError("Grok Responses request failed", request=response.request, response=safe)

    def event(payload):
        nonlocal final
        if not isinstance(payload, dict):
            raise ValueError("Invalid Responses payload")
        kind = payload.get("type")
        if kind in ("error", "response.failed"):
            failed(payload.get("response", payload))
        if kind == "response.incomplete":
            raise ValueError("Grok Responses ended incomplete")
        if kind == "response.output_text.delta":
            key = (payload.get("output_index", 0), payload.get("content_index", 0))
            if isinstance(payload.get("delta"), str):
                texts[key] = texts.get(key, "") + payload["delta"]
        elif kind == "response.output_text.done":
            key = (payload.get("output_index", 0), payload.get("content_index", 0))
            if isinstance(payload.get("text"), str):
                texts[key] = payload["text"]
        elif kind == "response.output_text.annotation.added":
            citation(payload.get("annotation"))
        elif kind in ("response.output_item.added", "response.output_item.done"):
            item(payload.get("item"))
        elif kind == "response.completed":
            final = payload.get("response")
        elif kind in (None, "response") and "output" in payload:
            final = payload

    if "text/event-stream" in response.headers.get("content-type", ""):
        data = []
        async for line in response.aiter_lines():
            total += len(line.encode("utf-8"))
            if total > 2_000_000:
                raise ValueError("Grok Responses exceeded size limit")
            if line.startswith("data:"):
                data.append(line[5:].lstrip())
            elif not line and data:
                raw, data = "\n".join(data), []
                if raw != "[DONE]":
                    event(json.loads(raw))
        if data and "\n".join(data) != "[DONE]":
            event(json.loads("\n".join(data)))
    else:
        chunks = []
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > 2_000_000:
                raise ValueError("Grok Responses exceeded size limit")
            chunks.append(chunk)
        event(json.loads(b"".join(chunks)))

    if not isinstance(final, dict):
        raise ValueError("Grok Responses stream ended without completion")
    if final.get("status") == "failed" or final.get("error"):
        failed(final)
    if final.get("status") not in (None, "completed"):
        raise ValueError("Grok Responses did not complete")
    answers = []
    for output in final.get("output", []):
        item(output)
        if output.get("type") == "message":
            answers.extend(part["text"] for part in output.get("content", [])
                           if part.get("type") == "output_text" and isinstance(part.get("text"), str))
    answer = "\n".join(answers) if answers else "".join(texts.values())
    if not answer.strip() and not sources:
        raise ValueError("Grok Responses returned no answer or citations")
    return SearchText(answer.strip(), list(sources.values()), {
        "api": "responses", "tools_requested": list(requested),
        "tool_calls": list(calls.values()), "response_status": "completed",
    })
