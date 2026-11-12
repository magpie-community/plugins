import asyncio
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Annotated, Any, Literal

import httpx
from fastmcp import Context, FastMCP
from pydantic import Field


src_dir = Path(__file__).parent.parent
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

try:
    from grok_search.config import config
    from grok_search.logger import log_info
    from grok_search.planning import _split_csv, engine as planning_engine
    from grok_search.providers.grok import GrokSearchProvider
    from grok_search.sources import (
        SourcesCache,
        merge_sources,
        new_session_id,
        split_answer_and_sources,
    )
except ImportError:
    from .config import config
    from .logger import log_info
    from .planning import _split_csv, engine as planning_engine
    from .providers.grok import GrokSearchProvider
    from .sources import SourcesCache, merge_sources, new_session_id, split_answer_and_sources


mcp = FastMCP("grok-search")

_SOURCES_CACHE = SourcesCache(max_size=256)
_AVAILABLE_MODELS_CACHE: dict[tuple[str, str], list[str]] = {}
_AVAILABLE_MODELS_LOCK = asyncio.Lock()
_ENDPOINT_CACHE: dict[tuple[str, str], str] = {}
_ENDPOINT_CACHE_LOCK = asyncio.Lock()


def _provider_headers(provider: str, api_key: str | None) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        if provider == "exa":
            headers["Authorization"] = f"Bearer {api_key}"
        else:
            headers["Authorization"] = f"Bearer {api_key}"
            headers["x-api-key"] = api_key
            headers["X-API-Key"] = api_key
    return headers


def _candidate_urls(base_url: str, suffixes: list[str]) -> list[str]:
    root = base_url.rstrip("/")
    urls: list[str] = []
    seen: set[str] = set()
    for suffix in suffixes:
        if not suffix:
            candidate = root
        elif suffix.startswith("/"):
            candidate = f"{root}{suffix}"
        else:
            candidate = f"{root}/{suffix}"
        if candidate not in seen:
            seen.add(candidate)
            urls.append(candidate)
    return urls


async def _request_json_candidates(
    method: str,
    provider: str,
    action: str,
    base_url: str,
    suffixes: list[str],
    *,
    api_key: str | None,
    json_body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    timeout: float = 30.0,
    ctx: Context | None = None,
) -> tuple[dict[str, Any], str]:
    headers = _provider_headers(provider, api_key)
    cache_key = (provider, action)
    candidates = _candidate_urls(base_url, suffixes)

    async with _ENDPOINT_CACHE_LOCK:
        cached = _ENDPOINT_CACHE.get(cache_key)
    if cached and cached in candidates:
        candidates = [cached] + [item for item in candidates if item != cached]

    errors: list[str] = []
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        for candidate in candidates:
            try:
                response = await client.request(
                    method,
                    candidate,
                    headers=headers,
                    json=json_body,
                    params=params,
                )
                response.raise_for_status()
                data = response.json()
                async with _ENDPOINT_CACHE_LOCK:
                    _ENDPOINT_CACHE[cache_key] = candidate
                return data if isinstance(data, dict) else {"data": data}, candidate
            except Exception as exc:
                errors.append(f"{candidate} -> {exc}")
                await log_info(ctx, f"{provider}.{action} failed at {candidate}: {exc}", config.debug_enabled)

    message = "; ".join(errors[-3:]) if errors else "no candidate endpoints"
    raise RuntimeError(f"{provider}.{action} failed: {message}")


def _safe_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()


def _pick_first_text(item: dict[str, Any], keys: list[str]) -> str:
    for key in keys:
        value = _safe_text(item.get(key))
        if value:
            return value
    return ""


def _normalize_search_items(items: list[Any], provider: str) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    for raw in items or []:
        if not isinstance(raw, dict):
            continue
        url = _pick_first_text(raw, ["url", "href", "link", "sourceURL", "sourceUrl"])
        if not url:
            continue
        item = {"url": url, "provider": provider}
        title = _pick_first_text(raw, ["title", "name"])
        if title:
            item["title"] = title
        description = _pick_first_text(
            raw,
            ["description", "snippet", "content", "text", "summary"],
        )
        if description:
            item["description"] = description
        published_date = _pick_first_text(
            raw,
            ["published_date", "publishedDate", "date", "published_at"],
        )
        if published_date:
            item["published_date"] = published_date
        normalized.append(item)
    return normalized


async def _fetch_available_models(api_url: str, api_key: str) -> list[str]:
    data, _ = await _request_json_candidates(
        "GET",
        "grok",
        "models",
        api_url,
        ["/models"],
        api_key=api_key,
        timeout=10.0,
    )
    models: list[str] = []
    for item in data.get("data", []) or []:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            models.append(item["id"])
    return models


async def _probe_grok_model(
    api_url: str,
    api_key: str,
    model: str,
    *,
    ctx: Context | None = None,
) -> dict[str, Any]:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Reply with OK only."},
            {"role": "user", "content": "health check"},
        ],
        "stream": False,
        "max_tokens": 8,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    timeout = httpx.Timeout(connect=6.0, read=30.0, write=10.0, pool=None)
    endpoint = f"{api_url.rstrip('/')}/chat/completions"

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        try:
            response = await client.post(endpoint, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json() if response.content else {}
            choices = data.get("choices", []) if isinstance(data, dict) else []
            content = ""
            if choices and isinstance(choices[0], dict):
                message = choices[0].get("message", {})
                if isinstance(message, dict):
                    content = _safe_text(message.get("content"))
            return {
                "model": model,
                "status": "ok",
                "message": content or "OK",
            }
        except httpx.HTTPStatusError as exc:
            body = exc.response.text.strip()
            message = body or str(exc)
            await log_info(
                ctx,
                f"grok.model_probe failed model={model} status={exc.response.status_code} error={message}",
                config.debug_enabled,
            )
            return {
                "model": model,
                "status": "error",
                "http_status": exc.response.status_code,
                "message": message,
            }
        except Exception as exc:
            await log_info(
                ctx,
                f"grok.model_probe failed model={model} error={exc}",
                config.debug_enabled,
            )
            return {
                "model": model,
                "status": "error",
                "message": str(exc),
            }


async def _get_available_models_cached(api_url: str, api_key: str) -> list[str]:
    key = (api_url, api_key)
    async with _AVAILABLE_MODELS_LOCK:
        cached = _AVAILABLE_MODELS_CACHE.get(key)
    if cached is not None:
        return cached

    try:
        models = await _fetch_available_models(api_url, api_key)
    except Exception:
        models = []

    async with _AVAILABLE_MODELS_LOCK:
        _AVAILABLE_MODELS_CACHE[key] = models
    return models


async def _call_tavily_search(
    query: str,
    max_results: int,
    ctx: Context | None = None,
) -> list[dict[str, str]]:
    if not config.tavily_enabled or not config.tavily_api_key:
        return []
    payload = {
        "query": query,
        "max_results": max_results,
        "search_depth": "advanced",
        "include_answer": False,
        "include_raw_content": False,
    }
    data, _ = await _request_json_candidates(
        "POST",
        "tavily",
        "search",
        config.tavily_api_url,
        ["/api/search", "/search"],
        api_key=config.tavily_api_key,
        json_body=payload,
        timeout=45.0,
        ctx=ctx,
    )
    return _normalize_search_items(data.get("results", []) or [], "tavily")


async def _call_tavily_extract(url: str, ctx: Context | None = None) -> str:
    if not config.tavily_enabled or not config.tavily_api_key:
        return ""
    payload = {"urls": [url], "include_images": False, "extract_depth": "advanced"}
    data, _ = await _request_json_candidates(
        "POST",
        "tavily",
        "extract",
        config.tavily_api_url,
        ["/api/extract", "/extract"],
        api_key=config.tavily_api_key,
        json_body=payload,
        timeout=90.0,
        ctx=ctx,
    )
    results = data.get("results", []) or data.get("data", []) or []
    for item in results:
        if not isinstance(item, dict):
            continue
        for key in ("raw_content", "content", "markdown", "text"):
            value = _safe_text(item.get(key))
            if value:
                return value
    return ""


async def _call_tavily_map(
    url: str,
    instructions: str,
    max_depth: int,
    max_breadth: int,
    limit: int,
    timeout: int,
    ctx: Context | None = None,
) -> dict[str, Any]:
    if not config.tavily_enabled or not config.tavily_api_key:
        raise RuntimeError("Tavily API key not configured")
    payload: dict[str, Any] = {
        "url": url,
        "max_depth": max_depth,
        "max_breadth": max_breadth,
        "limit": limit,
        "timeout": timeout,
    }
    if instructions:
        payload["instructions"] = instructions
    data, endpoint = await _request_json_candidates(
        "POST",
        "tavily",
        "map",
        config.tavily_api_url,
        ["/api/map", "/map"],
        api_key=config.tavily_api_key,
        json_body=payload,
        timeout=float(timeout) + 10.0,
        ctx=ctx,
    )
    return {
        "provider": "tavily",
        "endpoint": endpoint,
        "base_url": data.get("base_url") or url,
        "results": data.get("results", []) or data.get("links", []) or [],
        "raw": data,
    }


async def _call_firecrawl_search(
    query: str,
    limit: int,
    ctx: Context | None = None,
) -> list[dict[str, str]]:
    if not config.firecrawl_api_key:
        return []
    payload = {"query": query, "limit": limit}
    data, _ = await _request_json_candidates(
        "POST",
        "firecrawl",
        "search",
        config.firecrawl_api_url,
        ["/firecrawl/v2/search", "/v2/search", "/search"],
        api_key=config.firecrawl_api_key,
        json_body=payload,
        timeout=45.0,
        ctx=ctx,
    )
    if isinstance(data.get("data"), dict):
        items = data["data"].get("web", []) or data["data"].get("results", []) or []
    else:
        items = data.get("data", []) or data.get("results", []) or []
    return _normalize_search_items(items, "firecrawl")


async def _call_firecrawl_scrape(url: str, ctx: Context | None = None) -> str:
    if not config.firecrawl_api_key:
        return ""
    payload = {
        "url": url,
        "formats": ["markdown"],
        "timeout": 60000,
        "waitFor": 1500,
    }
    data, _ = await _request_json_candidates(
        "POST",
        "firecrawl",
        "scrape",
        config.firecrawl_api_url,
        ["/firecrawl/v2/scrape", "/v2/scrape", "/scrape"],
        api_key=config.firecrawl_api_key,
        json_body=payload,
        timeout=90.0,
        ctx=ctx,
    )
    container = data.get("data") if isinstance(data.get("data"), dict) else data
    for key in ("markdown", "content", "text"):
        value = _safe_text(container.get(key)) if isinstance(container, dict) else ""
        if value:
            return value
    return ""


async def _call_firecrawl_map(
    url: str,
    instructions: str,
    max_depth: int,
    max_breadth: int,
    limit: int,
    timeout: int,
    ctx: Context | None = None,
) -> dict[str, Any]:
    if not config.firecrawl_api_key:
        raise RuntimeError("Firecrawl API key not configured")
    effective_limit = min(limit, max_breadth) if max_breadth else limit
    payload: dict[str, Any] = {
        "url": url,
        "limit": effective_limit,
        "timeout": timeout * 1000,
    }
    if instructions:
        payload["search"] = instructions
    if max_depth:
        payload["maxDiscoveryDepth"] = max_depth
    data, endpoint = await _request_json_candidates(
        "POST",
        "firecrawl",
        "map",
        config.firecrawl_api_url,
        ["/firecrawl/v2/map", "/v2/map", "/map"],
        api_key=config.firecrawl_api_key,
        json_body=payload,
        timeout=float(timeout) + 10.0,
        ctx=ctx,
    )
    raw_results = []
    if isinstance(data.get("data"), dict):
        raw_results = data["data"].get("links", []) or data["data"].get("results", []) or []
    else:
        raw_results = data.get("links", []) or data.get("data", []) or data.get("results", []) or []

    normalized: list[dict[str, str]] = []
    for item in raw_results:
        if isinstance(item, str):
            normalized.append({"url": item})
        elif isinstance(item, dict):
            url_value = _pick_first_text(item, ["url", "href", "link"])
            if url_value:
                entry = {"url": url_value}
                title = _pick_first_text(item, ["title", "name"])
                if title:
                    entry["title"] = title
                normalized.append(entry)

    return {
        "provider": "firecrawl",
        "endpoint": endpoint,
        "base_url": url,
        "results": normalized,
        "raw": data,
    }


async def _call_exa_search(
    query: str,
    num_results: int,
    ctx: Context | None = None,
) -> list[dict[str, str]]:
    if not config.exa_enabled or not config.exa_api_key:
        return []
    payload = {
        "query": query,
        "numResults": num_results,
        "type": "auto",
        "contents": {"text": {"maxCharacters": 800}},
    }
    data, _ = await _request_json_candidates(
        "POST",
        "exa",
        "search",
        config.exa_api_url,
        ["/search", "/api/search", "/v1/search"],
        api_key=config.exa_api_key,
        json_body=payload,
        timeout=45.0,
        ctx=ctx,
    )
    items = data.get("results", []) or data.get("data", []) or []
    return _normalize_search_items(items, "exa")


def _extra_results_to_sources(*groups: list[dict[str, str]]) -> list[dict[str, str]]:
    sources: list[dict[str, str]] = []
    seen: set[str] = set()
    for group in groups:
        for item in group or []:
            url = _safe_text(item.get("url"))
            if not url or url in seen:
                continue
            seen.add(url)
            source = {"url": url}
            for key in ("title", "description", "provider", "published_date"):
                value = _safe_text(item.get(key))
                if value:
                    source[key] = value
            sources.append(source)
    return sources


def _allocate_extra_sources(total: int) -> dict[str, int]:
    enabled: list[str] = []
    if config.exa_enabled and config.exa_api_key:
        enabled.append("exa")
    if config.tavily_enabled and config.tavily_api_key:
        enabled.append("tavily")
    if config.firecrawl_api_key:
        enabled.append("firecrawl")

    allocation = {name: 0 for name in ("exa", "tavily", "firecrawl")}
    if total <= 0 or not enabled:
        return allocation

    for index in range(total):
        allocation[enabled[index % len(enabled)]] += 1
    return allocation


def _build_fallback_answer(query: str, sources: list[dict[str, str]]) -> str:
    if not sources:
        return f"No answer was returned for: {query}"

    lines = [f"No primary answer was returned for: {query}", "", "Relevant sources:"]
    for item in sources[:8]:
        title = item.get("title") or item["url"]
        description = item.get("description", "")
        if description:
            lines.append(f"- [{title}]({item['url']}): {description}")
        else:
            lines.append(f"- [{title}]({item['url']})")
    return "\n".join(lines)


def _provider_enabled(name: str) -> bool:
    from grok_search import channels as extra_channels
    if name in extra_channels.CATALOG:
        return extra_channels.availability(name)["configured"]
    if name == "grok":
        try:
            return bool(config.grok_targets)
        except ValueError:
            return False
    if name == "tavily":
        return config.tavily_enabled and bool(config.tavily_api_key)
    if name == "firecrawl":
        return bool(config.firecrawl_api_key)
    if name == "exa":
        return config.exa_enabled and bool(config.exa_api_key)
    return False


@mcp.tool(
    name="web_search",
    output_schema=None,
    description="""
    Use plan_intent for multi-step research; a simple lookup can call this directly.
    Search with per-call channels and Grok model choice. For ordinary agent calls use
    profile="quick" (simple lookup), "balanced" (normal research), or "deep" (cross-checking).
    channels restricts calls to exactly those channels. Quick defaults to one reference
    channel without an LLM; channels=["grok"] selects an advertised lightweight Grok model.
    Explicit model always disables the configured multi-model race and heavy fallbacks.
    get_search_capabilities lists configured channels and advertised model choices.
    Omitting profile and channels preserves the legacy deep-search behavior.

    This tool extracts sources if provided by upstream, caches them, and returns:
    - session_id: string
    - content: string
    - sources_count: int
    """,
    meta={"version": "3.0.0", "author": "Codex"},
)
async def web_search(
    query: Annotated[str, "Clear, self-contained natural-language search query."],
    platform: Annotated[
        str,
        "Target platform to focus on (e.g., 'Twitter', 'GitHub', 'Reddit'). Leave empty for general web search.",
    ] = "",
    model: Annotated[
        str,
        "Optional exact Grok model for this request. Choose from get_search_capabilities. "
        "Overrides the profile model and disables multi-model racing and model fallbacks.",
    ] = "",
    extra_sources: Annotated[
        int,
        "Number of additional reference results from Tavily/Firecrawl/Exa. Set 0 to disable. Default 0.",
    ] = 0,
    time_budget_seconds: Annotated[
        float,
        Field(ge=0, le=90),
        "Per-provider time budget for short-deadline clients such as Magpie. "
        "0 preserves the normal deep-search behavior. Completed sources are kept on timeout.",
    ] = 0,
    channels: Annotated[
        list[str] | None,
        "Optional exact channels for this call. Unselected channels are never called. "
        "Omit for profile defaults. Call get_search_capabilities for all IDs and intended uses; "
        "e.g. ['exa'], ['grok', 'tavily'], ['github'], ['arxiv', 'crossref'].",
    ] = None,
    profile: Annotated[
        Literal["quick", "balanced", "deep"] | None,
        "Use quick for simple lookups, balanced for normal research, deep only for cross-checking. "
        "Omit only for compatibility with the original deep-search tool.",
    ] = None,
    max_results: Annotated[int, Field(ge=1, le=20), "Maximum total source URLs in profile mode."] = 6,
    ctx: Context | None = None,
    grok_search_mode: Annotated[
        Literal["both", "web", "x"],
        "Grok Responses tools: both enables web_search and x_search by default; web or x restricts enabled tools. Does not add Grok to an explicit channel list.",
    ] = "both",
) -> dict[str, Any]:
    if grok_search_mode not in ("both", "web", "x"):
        raise ValueError("grok_search_mode must be both, web, or x")
    if profile is not None or channels is not None:
        from grok_search.routing import search as routed_search
        return await routed_search(
            sys.modules[__name__], query, channels, profile or "quick", model,
            max_results, platform, time_budget_seconds, ctx, grok_search_mode,
        )
    session_id = new_session_id()

    try:
        grok_targets = config.grok_targets
        primary_target = config.primary_grok_target
    except ValueError as exc:
        await _SOURCES_CACHE.set(session_id, [])
        return {"session_id": session_id, "content": f"Configuration error: {exc}", "sources_count": 0}

    effective_model = config.grok_model
    if model:
        available_models = await _get_available_models_cached(primary_target.api_url, primary_target.api_key)
        if available_models and model not in available_models:
            await _SOURCES_CACHE.set(session_id, [])
            return {
                "session_id": session_id,
                "content": f"Invalid model: {model}",
                "sources_count": 0,
            }
        effective_model = model

    fallback_models = [] if model else [item for item in config.grok_models if item != effective_model]
    multi_race_models = [] if model else config.grok_multi_race_models
    allocation = _allocate_extra_sources(extra_sources)

    async def _within_budget(awaitable):
        if time_budget_seconds > 0:
            return await asyncio.wait_for(awaitable, timeout=time_budget_seconds)
        return await awaitable

    async def _safe_grok_single(race_model: str) -> tuple[str, str]:
        provider = GrokSearchProvider(grok_targets, model=race_model, fallback_models=[])
        try:
            result = await _within_budget(provider.search(query, platform, ctx=ctx, search_mode=grok_search_mode))
            return (race_model, result)
        except Exception as exc:
            await log_info(ctx, f"grok.search model={race_model} failed: {exc}", config.debug_enabled)
            return (race_model, "")

    async def _safe_grok() -> str:
        try:
            provider = GrokSearchProvider(grok_targets, model=effective_model, fallback_models=fallback_models)
            return await _within_budget(provider.search(query, platform, ctx=ctx, search_mode=grok_search_mode))
        except Exception as exc:
            await log_info(ctx, f"grok.search failed: {exc}", config.debug_enabled)
            return ""

    async def _safe_exa() -> list[dict[str, str]]:
        if allocation["exa"] <= 0:
            return []
        try:
            return await _within_budget(_call_exa_search(query, allocation["exa"], ctx=ctx))
        except Exception as exc:
            await log_info(ctx, f"exa.search failed: {exc}", config.debug_enabled)
            return []

    async def _safe_tavily() -> list[dict[str, str]]:
        if allocation["tavily"] <= 0:
            return []
        try:
            return await _within_budget(_call_tavily_search(query, allocation["tavily"], ctx=ctx))
        except Exception as exc:
            await log_info(ctx, f"tavily.search failed: {exc}", config.debug_enabled)
            return []

    async def _safe_firecrawl() -> list[dict[str, str]]:
        if allocation["firecrawl"] <= 0:
            return []
        try:
            return await _within_budget(_call_firecrawl_search(query, allocation["firecrawl"], ctx=ctx))
        except Exception as exc:
            await log_info(ctx, f"firecrawl.search failed: {exc}", config.debug_enabled)
            return []

    if multi_race_models:
        _RACE_GRACE_PERIOD = float(os.getenv("GROK_RACE_GRACE_SECONDS", "3"))
        race_futures = {asyncio.ensure_future(_safe_grok_single(m)): m for m in multi_race_models}
        extra_futures = [
            asyncio.ensure_future(_safe_exa()),
            asyncio.ensure_future(_safe_tavily()),
            asyncio.ensure_future(_safe_firecrawl()),
        ]
        all_race = set(race_futures.keys())
        successful: list[tuple[str, str]] = []
        done: set[asyncio.Future] = set()
        pending = set(all_race)

        while pending:
            newly_done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for fut in newly_done:
                model_name, result = fut.result()
                if result.strip():
                    successful.append((model_name, result))
            done.update(newly_done)
            if successful:
                break

        if successful and pending:
            if pending:
                grace_done, pending = await asyncio.wait(pending, timeout=_RACE_GRACE_PERIOD)
                for fut in grace_done:
                    model_name, result = fut.result()
                    if result.strip():
                        successful.append((model_name, result))
                done.update(grace_done)

        for fut in pending:
            fut.cancel()

        await asyncio.gather(*extra_futures)
        exa_results = extra_futures[0].result()
        tavily_results = extra_futures[1].result()
        firecrawl_results = extra_futures[2].result()

        if len(successful) == 0:
            grok_result = ""
        elif len(successful) == 1:
            grok_result = successful[0][1]
        else:
            model_priority = list(reversed(multi_race_models))
            successful.sort(key=lambda x: model_priority.index(x[0]) if x[0] in model_priority else -1, reverse=True)
            parts = ["[MULTI_MODEL_CANDIDATES]\n"]
            for m, r in successful:
                parts.append(f"--- candidate from {m} ---\n{r}\n")
            parts.append("[/MULTI_MODEL_CANDIDATES]\nPlease evaluate the above candidates and use the best one.")
            grok_result = "\n".join(parts)
    else:
        grok_result, exa_results, tavily_results, firecrawl_results = await asyncio.gather(
            _safe_grok(),
            _safe_exa(),
            _safe_tavily(),
            _safe_firecrawl(),
        )

    answer, grok_sources = split_answer_and_sources(grok_result)
    extra = _extra_results_to_sources(exa_results, tavily_results, firecrawl_results)
    sources = merge_sources(grok_sources, extra)

    if not answer.strip():
        answer = _build_fallback_answer(query, sources)

    await _SOURCES_CACHE.set(session_id, sources)
    return {"session_id": session_id, "content": answer, "sources_count": len(sources)}


@mcp.tool(
    name="get_sources",
    description="""
    Retrieve all cached sources for a previous web_search call.
    Provide the session_id returned by web_search to get the full source list.
    """,
    meta={"version": "1.0.0", "author": "Codex"},
)
async def get_sources(
    session_id: Annotated[str, "Session ID from previous web_search call."],
) -> dict[str, Any]:
    sources = await _SOURCES_CACHE.get(session_id)
    if sources is None:
        return {
            "session_id": session_id,
            "sources": [],
            "sources_count": 0,
            "error": "session_id_not_found_or_expired",
        }
    return {"session_id": session_id, "sources": sources, "sources_count": len(sources)}


@mcp.tool(
    name="get_search_capabilities",
    description="List configured search channels, quick/balanced/deep choices and advertised Grok models. "
    "No search query is sent and no model completion is generated. Use before choosing an explicit model. "
    "Configured or advertised does not mean that a channel or model passed a live search.",
)
async def get_search_capabilities() -> dict[str, Any]:
    from grok_search.routing import capabilities
    return await capabilities(sys.modules[__name__])


@mcp.tool(
    name="web_fetch",
    output_schema=None,
    description="""
    Fetches and extracts complete content from a URL, returning it as a structured Markdown document.
    """,
    meta={"version": "3.0.0", "author": "Codex"},
)
async def web_fetch(
    url: Annotated[str, "Valid HTTP/HTTPS web address pointing to the target page."],
    ctx: Context | None = None,
) -> str:
    await log_info(ctx, f"fetch.start url={url}", config.debug_enabled)

    try:
        content = await _call_tavily_extract(url, ctx=ctx)
        if content:
            return content
    except Exception as exc:
        await log_info(ctx, f"tavily.extract failed: {exc}", config.debug_enabled)

    try:
        content = await _call_firecrawl_scrape(url, ctx=ctx)
        if content:
            return content
    except Exception as exc:
        await log_info(ctx, f"firecrawl.scrape failed: {exc}", config.debug_enabled)

    try:
        fallback_models = [item for item in config.grok_models if item != config.grok_model]
        provider = GrokSearchProvider(config.grok_targets, model=config.grok_model, fallback_models=fallback_models)
        content = await provider.fetch(url, ctx=ctx)
        if content:
            return content
    except Exception as exc:
        await log_info(ctx, f"grok.fetch failed: {exc}", config.debug_enabled)

    return "Failed to fetch content from all configured providers."


@mcp.tool(
    name="web_map",
    description="""
    Maps a website's structure by traversing it like a graph, discovering URLs and generating a comprehensive site map.
    """,
    meta={"version": "3.0.0", "author": "Codex"},
)
async def web_map(
    url: Annotated[str, "Root URL to begin the mapping."],
    instructions: Annotated[str, "Natural language instructions for the crawler."] = "",
    max_depth: Annotated[int, Field(description="Maximum depth of mapping from the base URL.", ge=1, le=5)] = 1,
    max_breadth: Annotated[int, Field(description="Maximum number of links to follow per page.", ge=1, le=500)] = 20,
    limit: Annotated[int, Field(description="Total number of links to process before stopping.", ge=1, le=500)] = 50,
    timeout: Annotated[int, Field(description="Maximum time in seconds for the operation.", ge=10, le=180)] = 60,
    ctx: Context | None = None,
) -> dict[str, Any]:
    try:
        return await _call_tavily_map(url, instructions, max_depth, max_breadth, limit, timeout, ctx=ctx)
    except Exception as tavily_exc:
        await log_info(ctx, f"tavily.map failed, falling back to firecrawl: {tavily_exc}", config.debug_enabled)
        return await _call_firecrawl_map(url, instructions, max_depth, max_breadth, limit, timeout, ctx=ctx)


async def _check_provider(name: str) -> dict[str, Any]:
    result = {"enabled": _provider_enabled(name), "status": "disabled"}
    if not result["enabled"]:
        return result

    try:
        if name == "grok":
            primary_target = config.primary_grok_target
            models = await _fetch_available_models(primary_target.api_url, primary_target.api_key)
            result["status"] = "ok"
            result["available_models"] = models[:20]
            result["count"] = len(models)
        elif name == "tavily":
            search_results = await _call_tavily_search("ping", 1)
            result["status"] = "ok"
            result["sample_results"] = len(search_results)
        elif name == "firecrawl":
            search_results = await _call_firecrawl_search("ping", 1)
            result["status"] = "ok"
            result["sample_results"] = len(search_results)
        elif name == "exa":
            search_results = await _call_exa_search("ping", 1)
            result["status"] = "ok"
            result["sample_results"] = len(search_results)
    except Exception as exc:
        result["status"] = "error"
        result["message"] = str(exc)
    return result


@mcp.tool(
    name="get_config_info",
    output_schema=None,
    description="""
    Returns current Grok Search MCP server configuration and tests API connectivity.
    """,
    meta={"version": "3.0.0", "author": "Codex"},
)
async def get_config_info() -> dict[str, Any]:
    info = config.get_config_info()
    checks = await asyncio.gather(
        _check_provider("grok"),
        _check_provider("tavily"),
        _check_provider("firecrawl"),
        _check_provider("exa"),
    )
    info["provider_checks"] = {
        "grok": checks[0],
        "tavily": checks[1],
        "firecrawl": checks[2],
        "exa": checks[3],
    }


@mcp.tool(
    name="probe_grok_models",
    output_schema=None,
    description="""
    Fetches the currently advertised Grok models from the configured endpoint and sends
    a minimal chat completion request to each one, reporting which models are actually usable.
    """,
    meta={"version": "3.1.0", "author": "Codex"},
)
async def probe_grok_models(
    include_all: Annotated[
        bool,
        "When false, skip obvious non-chat models such as image models. Default true.",
    ] = True,
    ctx: Context | None = None,
) -> dict[str, Any]:
    primary_target = config.primary_grok_target
    available_models = await _fetch_available_models(primary_target.api_url, primary_target.api_key)
    candidates = available_models
    if not include_all:
        candidates = [
            model
            for model in available_models
            if "image" not in model.lower() and "vision" not in model.lower()
        ]

    results: list[dict[str, Any]] = []
    for model in candidates:
        results.append(await _probe_grok_model(primary_target.api_url, primary_target.api_key, model, ctx=ctx))

    usable = [item["model"] for item in results if item.get("status") == "ok"]
    unusable = [item for item in results if item.get("status") != "ok"]
    return {
        "endpoint": primary_target.api_url,
        "tested_count": len(results),
        "usable_models": usable,
        "unusable_models": unusable,
        "results": results,
    }
    return info


@mcp.tool(
    name="switch_model",
    output_schema=None,
    description="""
    Switches the default Grok model used for search and fetch operations, persisting the setting.
    """,
    meta={"version": "3.0.0", "author": "Codex"},
)
async def switch_model(
    model: Annotated[str, "Model ID to switch to."],
) -> dict[str, Any]:
    previous_model = config.grok_model
    config.set_model(model)
    return {
        "status": "ok",
        "previous_model": previous_model,
        "current_model": config.grok_model,
        "config_file": str(config.config_file),
    }


@mcp.tool(
    name="toggle_builtin_tools",
    output_schema=None,
    description="""
    Toggle Claude Code's built-in WebSearch and WebFetch tools on/off.
    """,
    meta={"version": "3.0.0", "author": "Codex"},
)
async def toggle_builtin_tools(
    action: Annotated[str, "Action to perform: on, off, or status."] = "status",
) -> dict[str, Any]:
    root = Path.cwd()
    while root != root.parent and not (root / ".git").exists():
        root = root.parent

    settings_path = root / ".claude" / "settings.json"
    tools = ["WebFetch", "WebSearch"]

    if settings_path.exists():
        with open(settings_path, "r", encoding="utf-8") as handle:
            settings = json.load(handle)
    else:
        settings = {"permissions": {"deny": []}}

    deny = settings.setdefault("permissions", {}).setdefault("deny", [])
    blocked = all(tool in deny for tool in tools)

    if action in {"on", "enable"}:
        for tool in tools:
            if tool not in deny:
                deny.append(tool)
        blocked = True
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        with open(settings_path, "w", encoding="utf-8") as handle:
            json.dump(settings, handle, ensure_ascii=False, indent=2)
    elif action in {"off", "disable"}:
        deny[:] = [tool for tool in deny if tool not in tools]
        blocked = False
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        with open(settings_path, "w", encoding="utf-8") as handle:
            json.dump(settings, handle, ensure_ascii=False, indent=2)

    return {"blocked": blocked, "deny_list": deny, "file": str(settings_path)}


@mcp.tool(
    name="plan_intent",
    output_schema=None,
    description="""
    Phase 1 of search planning: Analyze user intent. Call this FIRST to create a session.
    """,
)
async def plan_intent(
    thought: Annotated[str, "Reasoning for this phase"],
    core_question: Annotated[str, "Distilled core question in one sentence"],
    query_type: Annotated[str, "factual | comparative | exploratory | analytical"],
    time_sensitivity: Annotated[str, "realtime | recent | historical | irrelevant"],
    session_id: Annotated[str, "Empty for new session, or existing ID to revise"] = "",
    confidence: Annotated[float, "Confidence 0.0-1.0"] = 1.0,
    domain: Annotated[str, "Specific domain if identifiable"] = "",
    premise_valid: Annotated[str, "False if the question contains a flawed assumption"] = "",
    ambiguities: Annotated[str, "Comma-separated unresolved ambiguities"] = "",
    unverified_terms: Annotated[str, "Comma-separated external terms to verify"] = "",
    is_revision: Annotated[bool, "True to overwrite existing intent"] = False,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "core_question": core_question,
        "query_type": query_type,
        "time_sensitivity": time_sensitivity,
    }
    if domain:
        data["domain"] = domain
    if premise_valid:
        data["premise_valid"] = premise_valid.lower() not in {"false", "0", "no"}
    if ambiguities:
        data["ambiguities"] = _split_csv(ambiguities)
    if unverified_terms:
        data["unverified_terms"] = _split_csv(unverified_terms)
    return planning_engine.process_phase(
        phase="intent_analysis",
        thought=thought,
        session_id=session_id,
        is_revision=is_revision,
        confidence=confidence,
        phase_data=data,
    )


@mcp.tool(
    name="plan_complexity",
    output_schema=None,
    description="Phase 2: Assess search complexity.",
)
async def plan_complexity(
    session_id: Annotated[str, "Session ID from plan_intent"],
    thought: Annotated[str, "Reasoning for complexity assessment"],
    level: Annotated[int, "Complexity 1-3"],
    estimated_sub_queries: Annotated[int, "Expected number of sub-queries"],
    estimated_tool_calls: Annotated[int, "Expected total tool calls"],
    justification: Annotated[str, "Why this complexity level"],
    confidence: Annotated[float, "Confidence 0.0-1.0"] = 1.0,
    is_revision: Annotated[bool, "True to overwrite"] = False,
) -> dict[str, Any]:
    if not planning_engine.get_session(session_id):
        return {"error": f"Session '{session_id}' not found. Call plan_intent first."}
    return planning_engine.process_phase(
        phase="complexity_assessment",
        thought=thought,
        session_id=session_id,
        is_revision=is_revision,
        confidence=confidence,
        phase_data={
            "level": level,
            "estimated_sub_queries": estimated_sub_queries,
            "estimated_tool_calls": estimated_tool_calls,
            "justification": justification,
        },
    )


@mcp.tool(
    name="plan_sub_query",
    output_schema=None,
    description="Phase 3: Add one sub-query.",
)
async def plan_sub_query(
    session_id: Annotated[str, "Session ID from plan_intent"],
    thought: Annotated[str, "Reasoning for this sub-query"],
    id: Annotated[str, "Unique ID (e.g., 'sq1')"],
    goal: Annotated[str, "Sub-query goal"],
    expected_output: Annotated[str, "What success looks like"],
    boundary: Annotated[str, "What this excludes"],
    confidence: Annotated[float, "Confidence 0.0-1.0"] = 1.0,
    depends_on: Annotated[str, "Comma-separated prerequisite IDs"] = "",
    tool_hint: Annotated[str, "web_search | web_fetch | web_map"] = "",
    is_revision: Annotated[bool, "True to replace all sub-queries"] = False,
) -> dict[str, Any]:
    if not planning_engine.get_session(session_id):
        return {"error": f"Session '{session_id}' not found. Call plan_intent first."}
    item: dict[str, Any] = {
        "id": id,
        "goal": goal,
        "expected_output": expected_output,
        "boundary": boundary,
    }
    if depends_on:
        item["depends_on"] = _split_csv(depends_on)
    if tool_hint:
        item["tool_hint"] = tool_hint
    return planning_engine.process_phase(
        phase="query_decomposition",
        thought=thought,
        session_id=session_id,
        is_revision=is_revision,
        confidence=confidence,
        phase_data=item,
    )


@mcp.tool(
    name="plan_search_term",
    output_schema=None,
    description="Phase 4: Add one search term.",
)
async def plan_search_term(
    session_id: Annotated[str, "Session ID from plan_intent"],
    thought: Annotated[str, "Reasoning for this search term"],
    term: Annotated[str, "Search query (max 8 words)"],
    purpose: Annotated[str, "Sub-query ID this serves"],
    round: Annotated[int, "Execution round"],
    confidence: Annotated[float, "Confidence 0.0-1.0"] = 1.0,
    approach: Annotated[str, "broad_first | narrow_first | targeted"] = "",
    fallback_plan: Annotated[str, "Fallback if primary searches fail"] = "",
    is_revision: Annotated[bool, "True to replace all search terms"] = False,
) -> dict[str, Any]:
    if not planning_engine.get_session(session_id):
        return {"error": f"Session '{session_id}' not found. Call plan_intent first."}
    data: dict[str, Any] = {
        "search_terms": [{"term": term, "purpose": purpose, "round": round}],
    }
    if approach:
        data["approach"] = approach
    if fallback_plan:
        data["fallback_plan"] = fallback_plan
    return planning_engine.process_phase(
        phase="search_strategy",
        thought=thought,
        session_id=session_id,
        is_revision=is_revision,
        confidence=confidence,
        phase_data=data,
    )


@mcp.tool(
    name="plan_tool_mapping",
    output_schema=None,
    description="Phase 5: Map a sub-query to a tool.",
)
async def plan_tool_mapping(
    session_id: Annotated[str, "Session ID from plan_intent"],
    thought: Annotated[str, "Reasoning for this mapping"],
    sub_query_id: Annotated[str, "Sub-query ID to map"],
    tool: Annotated[str, "web_search | web_fetch | web_map"],
    reason: Annotated[str, "Why this tool for this sub-query"],
    confidence: Annotated[float, "Confidence 0.0-1.0"] = 1.0,
    params_json: Annotated[str, "Optional JSON string for tool-specific params"] = "",
    is_revision: Annotated[bool, "True to replace all mappings"] = False,
) -> dict[str, Any]:
    if not planning_engine.get_session(session_id):
        return {"error": f"Session '{session_id}' not found. Call plan_intent first."}
    item: dict[str, Any] = {"sub_query_id": sub_query_id, "tool": tool, "reason": reason}
    if params_json:
        try:
            item["params"] = json.loads(params_json)
        except json.JSONDecodeError:
            pass
    return planning_engine.process_phase(
        phase="tool_selection",
        thought=thought,
        session_id=session_id,
        is_revision=is_revision,
        confidence=confidence,
        phase_data=item,
    )


@mcp.tool(
    name="plan_execution",
    output_schema=None,
    description="Phase 6: Define execution order.",
)
async def plan_execution(
    session_id: Annotated[str, "Session ID from plan_intent"],
    thought: Annotated[str, "Reasoning for execution order"],
    parallel_groups: Annotated[str, "Parallel batches"],
    sequential: Annotated[str, "Comma-separated IDs that must run in order"],
    estimated_rounds: Annotated[int, "Estimated execution rounds"],
    confidence: Annotated[float, "Confidence 0.0-1.0"] = 1.0,
    is_revision: Annotated[bool, "True to overwrite"] = False,
) -> dict[str, Any]:
    if not planning_engine.get_session(session_id):
        return {"error": f"Session '{session_id}' not found. Call plan_intent first."}
    parallel = [_split_csv(group) for group in parallel_groups.split(";") if group.strip()] if parallel_groups else []
    return planning_engine.process_phase(
        phase="execution_order",
        thought=thought,
        session_id=session_id,
        is_revision=is_revision,
        confidence=confidence,
        phase_data={
            "parallel": parallel,
            "sequential": _split_csv(sequential),
            "estimated_rounds": estimated_rounds,
        },
    )


def main() -> None:
    if threading.current_thread() is threading.main_thread():
        import signal

        def handle_shutdown(signum, frame):
            os._exit(0)

        signal.signal(signal.SIGINT, handle_shutdown)
        if sys.platform != "win32":
            signal.signal(signal.SIGTERM, handle_shutdown)

    if sys.platform == "win32":
        import ctypes

        parent_pid = os.getppid()

        def is_parent_alive(pid: int) -> bool:
            process_query_limited_information = 0x1000
            still_active = 259
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
            if not handle:
                return True
            exit_code = ctypes.c_ulong()
            result = kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
            kernel32.CloseHandle(handle)
            return bool(result and exit_code.value == still_active)

        def monitor_parent() -> None:
            while True:
                if not is_parent_alive(parent_pid):
                    os._exit(0)
                time.sleep(2)

        threading.Thread(target=monitor_parent, daemon=True).start()

    try:
        mcp.run(transport="stdio", show_banner=False)
    except KeyboardInterrupt:
        pass
    finally:
        os._exit(0)


if __name__ == "__main__":
    main()
