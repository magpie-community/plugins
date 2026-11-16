"""Per-request search choices. No keys, settings writes, or hidden model upgrades."""
import asyncio
import time
from typing import Any
from .utils import extract_unique_urls
from . import channels as extra_channels
from .providers.responses import SEARCH_MODES, SearchText

CHANNELS = ("grok", "tavily", "exa", "firecrawl", *extra_channels.CATALOG)
DEFAULT_WEB_CHANNELS = ("tavily", "exa", "firecrawl", "you", "brave", "parallel",
                        "perplexity", "bocha", "serper", "searxng")
PROFILES = {
    "quick": {"description": "Simple lookup; one channel, lightweight Grok if selected.", "default_count": 3},
    "balanced": {"description": "Ordinary research; one Grok model plus one reference channel.", "default_count": 6},
    "deep": {"description": "Cross-checking; configured Grok model/race plus at most three general reference channels.", "default_count": 10},
}


def choose_model(models: list[str], profile: str) -> str | None:
    """Only pick an advertised text model. Never silently promote quick to heavy."""
    candidates = [m for m in models if "grok" in m.lower()
                  and not any(word in m.lower() for word in ("image", "imagine", "video", "audio", "vision", "voice", "stt", "composer", "build"))]
    if profile == "quick":
        candidates = [m for m in candidates if any(word in m.lower() for word in ("fast", "mini", "lite", "non-reasoning"))
                      and not any(word in m.lower() for word in ("multi", "heavy"))]
        candidates.sort(key=lambda m: ("non-reasoning" not in m.lower(), "fast" not in m.lower(), m))
    else:
        candidates = [m for m in candidates if not any(word in m.lower() for word in ("multi", "heavy"))]
        candidates.sort(key=lambda m: ("reasoning" not in m.lower() or "non-reasoning" in m.lower(), "fast" not in m.lower(), m))
    return candidates[0] if candidates else None


async def capabilities(server, discover_models=True) -> dict[str, Any]:
    channels = {
        name: (extra_channels.availability(name) if name in extra_channels.CATALOG
               else {"configured": server._provider_enabled(name)})
        for name in CHANNELS
    }
    models, model_status = [], "not_requested"
    if discover_models and channels["grok"]["configured"]:
        try:
            target = server.config.primary_grok_target
            models = await asyncio.wait_for(
                server._get_available_models_cached(target.api_url, target.api_key), 8,
            )
            model_status = "advertised" if models else "empty"
        except Exception:
            model_status = "unavailable"
    deep = []
    if channels["grok"]["configured"]:
        deep = server.config.grok_multi_race_models or [server.config.grok_model]
    return {
        "channels": channels,
        "profiles": PROFILES,
        "grok": {
            "available_models": models, "model_list_status": model_status,
            "quick_model": choose_model(models, "quick"),
            "balanced_model": choose_model(models, "balanced"),
            "deep_models": deep,
            "search_modes": list(SEARCH_MODES),
            "default_search_mode": "both",
            "note": "Advertised models are candidates, not proof every model can search. Explicit model disables the configured race.",
        },
    }


async def search(server, query, channels, profile, model, count, platform, budget, ctx, grok_search_mode="both"):
    if grok_search_mode not in SEARCH_MODES:
        raise ValueError("grok_search_mode must be both, web, or x")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be nonempty")
    if profile not in PROFILES:
        raise ValueError("profile must be quick, balanced, or deep")
    if not 1 <= count <= 20:
        raise ValueError("max_results must be between 1 and 20")
    if channels is not None and (not channels or any(c not in CHANNELS for c in channels)):
        raise ValueError("channels must be a nonempty list from: " + ", ".join(CHANNELS))
    ready = {name: server._provider_enabled(name) for name in CHANNELS}
    references = [name for name in DEFAULT_WEB_CHANNELS if ready[name]]
    selected = list(dict.fromkeys(channels)) if channels is not None else (
        (["grok"] if model or platform else references[:1] or (["grok"] if ready["grok"] else []))
        if profile == "quick" else
        (["grok"] if ready["grok"] else []) + (references[:1] if profile == "balanced" else references[:3])
    )
    if model and "grok" not in selected:
        raise ValueError("model requires grok in channels")
    if not selected:
        raise ValueError("No configured search channel; configure a channel in the existing MCP settings")
    statuses = {}
    sources, answers = [], []
    grok_models = []
    for name in selected:
        if not ready[name]:
            statuses[name] = {"status": "unavailable"}
            if name in extra_channels.CATALOG:
                statuses[name]["missing_env"] = extra_channels.availability(name)["missing_env"]
    if "grok" in selected and ready["grok"]:
        if model:
            grok_models = [model]
        elif profile == "deep":
            grok_models = server.config.grok_multi_race_models or [server.config.grok_model]
        else:
            available = await capabilities(server)
            chosen = available["grok"][f"{profile}_model"]
            if chosen:
                grok_models = [chosen]
            else:
                statuses["grok"] = {
                    "status": "unavailable",
                    "reason": f"No advertised {profile} model; call get_search_capabilities or specify model. Heavy fallback is disabled.",
                }
    limit = float(budget) if budget else {"quick": 15, "balanced": 25, "deep": 60}[profile]
    reference_names = [n for n in selected if n != "grok" and ready[n]]
    allocation = {name: max(1, (count + len(reference_names) - 1) // len(reference_names))
                  for name in reference_names}

    async def run(name, call, model_name=None):
        started = time.monotonic()
        try:
            value = await asyncio.wait_for(call(), timeout=limit)
            if name == "grok":
                answer, found = (value.answer, list(value.sources)) if isinstance(value, SearchText) else server.split_answer_and_sources(value)
                if not found:
                    found = [{"url": url, "source_kind": "model_provided_url"}
                             for url in extract_unique_urls(value)]
                for item in found:
                    item.setdefault("provider", "grok")
                    item.setdefault("source_kind", "model_provided_reference")
                # Generated answers remain distinct from the text of cited pages.
                if answer.strip():
                    answers.append({"model": model_name, "content": answer})
            else:
                found = server._extra_results_to_sources(value)
                for item in found:
                    item.setdefault("provider", name)
            sources.extend(found)
            status = "ok" if found else "no_sources"
            result = {"status": status, "sources_count": len(found)}
            if name == "grok" and isinstance(value, SearchText):
                result["search"] = value.search_metadata
        except asyncio.TimeoutError:
            result = {"status": "timeout"}
        except Exception as exc:
            response = getattr(exc, "response", None)
            status_code = getattr(response, "status_code", None)
            result = {"status": "error", "error_type": type(exc).__name__}
            if status_code:
                result["http_status"] = status_code
                retry_after = response.headers.get("Retry-After")
                if retry_after:
                    result["retry_after"] = retry_after[:80]
        result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
        if model_name:
            result["model"] = model_name
            statuses.setdefault("grok", {"models": []})["models"].append(result)
        else:
            statuses[name] = result

    calls = []
    for name in reference_names:
        if name in extra_channels.CATALOG:
            calls.append(run(name, lambda name=name:
                             extra_channels.search(name, query, allocation[name], profile=profile)))
        else:
            function = getattr(server, f"_call_{name}_search")
            calls.append(run(name, lambda function=function, name=name:
                             function(query, allocation[name], ctx=ctx)))
    for chosen in grok_models:
        provider = server.GrokSearchProvider(server.config.grok_targets, model=chosen, fallback_models=[])
        calls.append(run("grok", lambda provider=provider: provider.search(
            query, platform, max_results=count, ctx=ctx, search_mode=grok_search_mode), chosen))
    await asyncio.gather(*calls)
    # Keep channel order stable when concurrent providers finish in a different order.
    sources.sort(key=lambda item: selected.index(item.get("provider")) if item.get("provider") in selected else len(selected))
    sources = server.merge_sources(sources)[:count]
    session_id = server.new_session_id()
    await server._SOURCES_CACHE.set(session_id, sources)
    return {
        "session_id": session_id,
        "content": "\n\n".join(item["content"] for item in answers) if answers else server._build_fallback_answer(query, sources),
        "sources_count": len(sources),
        "sources": sources,
        "routing": {
            "profile": profile, "selected_channels": selected, "grok_models": grok_models,
            **({"grok_search_mode": grok_search_mode} if "grok" in selected else {}),
            "max_results": count, "channel_results": statuses,
        },
    }
