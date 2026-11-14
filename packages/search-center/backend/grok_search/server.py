"""Search backend helpers invoked by worker.py (no FastMCP server or project-mutating tools)."""
import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Literal

import httpx

src_dir = Path(__file__).parent.parent
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

try:
    from grok_search.config import config
    from grok_search.logger import log_info
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
    from .providers.grok import GrokSearchProvider
    from .sources import SourcesCache, merge_sources, new_session_id, split_answer_and_sources


_SOURCES_CACHE = SourcesCache(max_size=256)
_AVAILABLE_MODELS_CACHE: dict[tuple[str, str], list[str]] = {}
_AVAILABLE_MODELS_LOCK = asyncio.Lock()
_ENDPOINT_CACHE: dict[tuple[str, str], str] = {}
_ENDPOINT_CACHE_LOCK = asyncio.Lock()

_MAX_ERROR_CHARS = 240


def _provider_headers(provider: str, api_key: str | None) -> dict[str, str]:
    """Send only each vendor's single documented Bearer authentication header."""
    headers = {"Content-Type": "application/json"}
    if api_key:
        if provider in ("grok", "tavily", "firecrawl", "exa"):
            headers["Authorization"] = f"Bearer {api_key}"
        else:
            raise ValueError(f"Unsupported provider for header construction: {provider}")
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
    ctx: Any = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[dict[str, Any], str]:
    headers = _provider_headers(provider, api_key)
    cache_key = (provider, action)
    candidates = _candidate_urls(base_url, suffixes)

    async with _ENDPOINT_CACHE_LOCK:
        cached = _ENDPOINT_CACHE.get(cache_key)
    if cached and cached in candidates:
        candidates = [cached] + [item for item in candidates if item != cached]

    errors: list[str] = []
    client_kwargs: dict[str, Any] = {"timeout": timeout, "follow_redirects": False}
    if transport is not None:
        client_kwargs["transport"] = transport

    async with httpx.AsyncClient(**client_kwargs) as client:
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
                short = str(exc)[:_MAX_ERROR_CHARS]
                errors.append(f"{candidate} -> {short}")
                await log_info(ctx, f"{provider}.{action} failed at {candidate}: {short}", config.debug_enabled)

    message = "; ".join(errors[-3:])[:600] if errors else "no candidate endpoints"
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


async def _fetch_available_models(
    api_url: str,
    api_key: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[str]:
    data, _ = await _request_json_candidates(
        "GET",
        "grok",
        "models",
        api_url,
        ["/models"],
        api_key=api_key,
        timeout=10.0,
        transport=transport,
    )
    models: list[str] = []
    for item in data.get("data", []) or []:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            models.append(item["id"])
    return models


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
    ctx: Any = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
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
        transport=transport,
    )
    return _normalize_search_items(data.get("results", []) or [], "tavily")


async def _call_firecrawl_search(
    query: str,
    limit: int,
    ctx: Any = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
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
        transport=transport,
    )
    if isinstance(data.get("data"), dict):
        items = data["data"].get("web", []) or data["data"].get("results", []) or []
    else:
        items = data.get("data", []) or data.get("results", []) or []
    return _normalize_search_items(items, "firecrawl")


async def _call_exa_search(
    query: str,
    num_results: int,
    ctx: Any = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
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
        transport=transport,
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


async def web_search(
    query: str,
    platform: str = "",
    model: str = "",
    extra_sources: int = 0,
    time_budget_seconds: float = 0,
    channels: list[str] | None = None,
    profile: Literal["quick", "balanced", "deep"] | None = None,
    max_results: int = 6,
    ctx: Any = None,
    grok_search_mode: Literal["both", "web", "x"] = "both",
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
            await log_info(ctx, f"grok.search model={race_model} failed: {str(exc)[:_MAX_ERROR_CHARS]}", config.debug_enabled)
            return (race_model, "")

    async def _safe_grok() -> str:
        try:
            provider = GrokSearchProvider(grok_targets, model=effective_model, fallback_models=fallback_models)
            return await _within_budget(provider.search(query, platform, ctx=ctx, search_mode=grok_search_mode))
        except Exception as exc:
            await log_info(ctx, f"grok.search failed: {str(exc)[:_MAX_ERROR_CHARS]}", config.debug_enabled)
            return ""

    async def _safe_exa() -> list[dict[str, str]]:
        if allocation["exa"] <= 0:
            return []
        try:
            return await _within_budget(_call_exa_search(query, allocation["exa"], ctx=ctx))
        except Exception as exc:
            await log_info(ctx, f"exa.search failed: {str(exc)[:_MAX_ERROR_CHARS]}", config.debug_enabled)
            return []

    async def _safe_tavily() -> list[dict[str, str]]:
        if allocation["tavily"] <= 0:
            return []
        try:
            return await _within_budget(_call_tavily_search(query, allocation["tavily"], ctx=ctx))
        except Exception as exc:
            await log_info(ctx, f"tavily.search failed: {str(exc)[:_MAX_ERROR_CHARS]}", config.debug_enabled)
            return []

    async def _safe_firecrawl() -> list[dict[str, str]]:
        if allocation["firecrawl"] <= 0:
            return []
        try:
            return await _within_budget(_call_firecrawl_search(query, allocation["firecrawl"], ctx=ctx))
        except Exception as exc:
            await log_info(ctx, f"firecrawl.search failed: {str(exc)[:_MAX_ERROR_CHARS]}", config.debug_enabled)
            return []

    if multi_race_models:
        grace_period = float(os.getenv("GROK_RACE_GRACE_SECONDS", "3"))
        race_futures = {asyncio.ensure_future(_safe_grok_single(m)): m for m in multi_race_models}
        extra_futures = [
            asyncio.ensure_future(_safe_exa()),
            asyncio.ensure_future(_safe_tavily()),
            asyncio.ensure_future(_safe_firecrawl()),
        ]
        successful: list[tuple[str, str]] = []
        pending = set(race_futures.keys())

        while pending:
            newly_done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for fut in newly_done:
                model_name, result = fut.result()
                if result.strip():
                    successful.append((model_name, result))
            if successful:
                break

        if successful and pending:
            grace_done, pending = await asyncio.wait(pending, timeout=grace_period)
            for fut in grace_done:
                model_name, result = fut.result()
                if result.strip():
                    successful.append((model_name, result))

        for fut in pending:
            fut.cancel()

        await asyncio.gather(*extra_futures)
        exa_results = extra_futures[0].result()
        tavily_results = extra_futures[1].result()
        firecrawl_results = extra_futures[2].result()

        if not successful:
            grok_result = ""
        else:
            model_priority = list(reversed(multi_race_models))
            successful.sort(key=lambda x: model_priority.index(x[0]) if x[0] in model_priority else -1, reverse=True)
            grok_result = "\n\n".join(text for _, text in successful)
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


async def get_sources(session_id: str) -> dict[str, Any]:
    sources = await _SOURCES_CACHE.get(session_id)
    if sources is None:
        return {
            "session_id": session_id,
            "sources": [],
            "sources_count": 0,
            "error": "session_id_not_found_or_expired",
        }
    return {"session_id": session_id, "sources": sources, "sources_count": len(sources)}


async def get_search_capabilities() -> dict[str, Any]:
    from grok_search.routing import capabilities
    return await capabilities(sys.modules[__name__])
