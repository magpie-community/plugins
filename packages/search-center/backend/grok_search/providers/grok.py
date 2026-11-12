import asyncio
import json
import re
from datetime import datetime
from typing import Sequence

import httpx

from .base import BaseSearchProvider
from .responses import SEARCH_MODES, parse_response
from ..config import GrokTarget, config
from ..logger import log_info
from ..utils import fetch_prompt, rank_sources_prompt, search_prompt, url_describe_prompt


_FAILOVER_STATUS_CODES = {401, 403, 408, 429, 500, 502, 503, 504}
_QUOTA_HINTS = ("quota", "credit", "billing", "rate limit", "insufficient")
_MODEL_FAILOVER_HINTS = (
    "no available accounts for this model tier",
    "does not support parameter reasoningeffort",
    "model_not_found",
    "unsupported model",
    "model does not support",
    "unknown model",
)


def _needs_time_context(query: str) -> bool:
    keywords = [
        "current",
        "now",
        "today",
        "latest",
        "recent",
        "this week",
        "this month",
        "this year",
    ]
    lowered = query.lower()
    return any(keyword in lowered or keyword in query for keyword in keywords)


def _get_time_context(query: str) -> str:
    if not _needs_time_context(query):
        return ""
    now = datetime.now().astimezone()
    return (
        "[Current Time Context]\n"
        f"- Date: {now.strftime('%Y-%m-%d')}\n"
        f"- Time: {now.strftime('%H:%M:%S')}\n"
        f"- Timezone: {now.tzname() or 'Local'}\n\n"
    )


def _should_failover(exc: Exception) -> bool:
    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError, httpx.ConnectError, httpx.RemoteProtocolError)):
        return True
    if not isinstance(exc, httpx.HTTPStatusError):
        return False
    if exc.response.status_code in _FAILOVER_STATUS_CODES:
        return True
    if exc.response.status_code != 400:
        return False
    return any(hint in exc.response.text.lower() for hint in _QUOTA_HINTS)


def _should_failover_model(exc: Exception) -> bool:
    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError, httpx.ConnectError, httpx.RemoteProtocolError)):
        return True
    if not isinstance(exc, httpx.HTTPStatusError):
        return False
    if exc.response.status_code in {400, 401, 403, 404, 408, 429, 500, 502, 503, 504}:
        body = exc.response.text.lower()
        return any(hint in body for hint in _QUOTA_HINTS + _MODEL_FAILOVER_HINTS)
    return False


class GrokSearchProvider(BaseSearchProvider):
    def __init__(
        self,
        api_url_or_targets: str | Sequence[GrokTarget],
        api_key: str | None = None,
        model: str = "grok-4.20-beta",
        fallback_models: Sequence[str] | None = None,
    ):
        if isinstance(api_url_or_targets, str):
            if not api_key:
                raise ValueError("Missing api_key for GrokSearchProvider")
            targets = [
                GrokTarget(
                    api_url=api_url_or_targets.rstrip("/"),
                    api_key=api_key,
                    source="primary",
                    label="primary-1",
                )
            ]
        else:
            targets = list(api_url_or_targets)
            if not targets:
                raise ValueError("GrokSearchProvider requires at least one target")

        super().__init__(targets[0].api_url, targets[0].api_key)
        self.targets = targets
        self.model = model
        self.models = [model] + [item for item in (fallback_models or []) if item and item != model]
        self._active_index = 0
        self._active_lock = asyncio.Lock()

    def get_provider_name(self) -> str:
        return "Grok"

    async def search(
        self,
        query: str,
        platform: str = "",
        min_results: int = 3,
        max_results: int = 10,
        ctx=None,
        search_mode: str = "both",
    ) -> str:
        if search_mode not in SEARCH_MODES:
            raise ValueError("grok_search_mode must be both, web, or x")
        platform_prompt = (
            f"\n\nFocus especially on this platform when relevant: {platform}\n"
            if platform
            else ""
        )
        result_limit_prompt = (
            f"\nReturn at most {max_results} source URLs. Keep the findings concise and factual.\n"
            if max_results < 10 else ""
        )
        payload = {
            "model": self.model,
            "input": [
                {"role": "system", "content": search_prompt},
                {"role": "user", "content": _get_time_context(query) + query + platform_prompt + result_limit_prompt},
            ],
            "stream": True,
            "store": False,
            "tools": [{"type": name} for name in SEARCH_MODES[search_mode]],
            "tool_choice": "auto",
        }
        await log_info(ctx, f"grok.search query={query}", config.debug_enabled)
        return await self._execute_stream_with_failover(payload, ctx)

    async def fetch(self, url: str, ctx=None) -> str:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": fetch_prompt},
                {"role": "user", "content": url},
            ],
            "stream": True,
        }
        return await self._execute_stream_with_failover(payload, ctx)

    async def _parse_streaming_response(self, response: httpx.Response, ctx=None) -> str:
        content = ""
        chunks: list[str] = []

        async for line in response.aiter_lines():
            line = line.strip()
            if not line:
                continue
            chunks.append(line)

            if not line.startswith("data:"):
                continue
            if line in ("data: [DONE]", "data:[DONE]"):
                continue
            try:
                payload = json.loads(line[5:].lstrip())
                choices = payload.get("choices", [])
                if choices:
                    delta = choices[0].get("delta", {})
                    if "content" in delta:
                        content += delta["content"]
            except (json.JSONDecodeError, IndexError, TypeError):
                continue

        if not content and chunks:
            raw = "".join(chunks)
            raw = re.sub(r"^data:\s*", "", raw)
            try:
                payload = json.loads(raw)
                choices = payload.get("choices", [])
                if choices:
                    content = (
                        choices[0].get("message", {}).get("content")
                        or choices[0].get("text", "")
                    )
            except json.JSONDecodeError:
                content = raw

        content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
        await log_info(ctx, f"grok.response length={len(content)}", config.debug_enabled)
        return content

    async def _get_try_order(self) -> list[int]:
        async with self._active_lock:
            start = self._active_index
        return list(range(start, len(self.targets))) + list(range(0, start))

    async def _promote_target(self, index: int) -> None:
        async with self._active_lock:
            self._active_index = index
            self.api_url = self.targets[index].api_url
            self.api_key = self.targets[index].api_key

    def _target_debug_name(self, target: GrokTarget) -> str:
        return f"{target.label}@{target.api_url}#{config.mask_api_key(target.api_key)}"

    async def _execute_stream_with_failover(self, payload: dict, ctx=None) -> str:
        errors: list[str] = []
        last_exc: Exception | None = None
        base_payload = dict(payload)
        for model_index, model in enumerate(self.models):
            model_payload = dict(base_payload)
            model_payload["model"] = model
            model_errors: list[str] = []
            model_last_exc: Exception | None = None
            for index in await self._get_try_order():
                target = self.targets[index]
                headers = {
                    "Authorization": f"Bearer {target.api_key}",
                    "Content-Type": "application/json",
                }
                try:
                    result = await self._execute_stream_once(target.api_url, headers, model_payload, ctx)
                    self.model = model
                    if model_index > 0:
                        await log_info(ctx, f"grok.model_fallback selected={model}", config.debug_enabled)
                    await self._promote_target(index)
                    return result
                except Exception as exc:
                    model_last_exc = exc
                    last_exc = exc
                    message = f"{self._target_debug_name(target)} model={model} -> {exc}"
                    model_errors.append(message)
                    errors.append(message)
                    await log_info(
                        ctx,
                        f"grok.failover target={self._target_debug_name(target)} model={model} error={exc}",
                        config.debug_enabled,
                    )
                    if not _should_failover(exc):
                        raise

            if model_last_exc is not None and not _should_failover_model(model_last_exc):
                break

        if isinstance(last_exc, httpx.HTTPStatusError):
            raise last_exc
        message = "; ".join(errors[-6:]) if errors else "all grok targets failed"
        raise RuntimeError(message) from last_exc

    async def _execute_stream_once(self, api_url: str, headers: dict, payload: dict, ctx=None) -> str:
        timeout = httpx.Timeout(connect=6.0, read=120.0, write=10.0, pool=None)
        is_search = "input" in payload
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=not is_search) as client:
            async with client.stream(
                "POST",
                f"{api_url}/responses" if is_search else f"{api_url}/chat/completions",
                headers=headers,
                json=payload,
            ) as response:
                if not response.is_success:
                    await response.aread()
                    response.raise_for_status()
                if is_search:
                    return await parse_response(response, [tool["type"] for tool in payload["tools"]])
                return await self._parse_streaming_response(response, ctx)

    async def describe_url(self, url: str, ctx=None) -> dict:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": url_describe_prompt},
                {"role": "user", "content": url},
            ],
            "stream": True,
        }
        result = await self._execute_stream_with_failover(payload, ctx)
        title, extracts = url, ""
        for line in result.strip().splitlines():
            if line.startswith("Title:"):
                title = line[6:].strip() or url
            elif line.startswith("Extracts:"):
                extracts = line[9:].strip()
        return {"title": title, "extracts": extracts, "url": url}

    async def rank_sources(self, query: str, sources_text: str, total: int, ctx=None) -> list[int]:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": rank_sources_prompt},
                {"role": "user", "content": f"Query: {query}\n\n{sources_text}"},
            ],
            "stream": True,
        }
        result = await self._execute_stream_with_failover(payload, ctx)
        order: list[int] = []
        seen: set[int] = set()
        for token in result.strip().split():
            try:
                value = int(token)
            except ValueError:
                continue
            if 1 <= value <= total and value not in seen:
                seen.add(value)
                order.append(value)
        for index in range(1, total + 1):
            if index not in seen:
                order.append(index)
        return order
