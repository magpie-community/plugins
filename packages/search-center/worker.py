"""One request, one channel. Credentials are injected or decrypted in this process."""
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / 'backend'))


async def main():
    request = json.loads(sys.stdin.read(200_000))
    channel = request["channel"]
    args = request["args"]
    base = request.get("baseUrl", "")
    encrypted = request.get("encrypted")
    fields = {"grok": "GROK_API_KEY", "tavily": "TAVILY_API_KEY", "exa": "EXA_API_KEY", "firecrawl": "FIRECRAWL_API_KEY",
              "you": "YOU_API_KEY", "brave": "BRAVE_API_KEY", "parallel": "PARALLEL_API_KEY", "perplexity": "PERPLEXITY_API_KEY",
              "bocha": "BOCHA_API_KEY", "serper": "SERPER_API_KEY", "github": "GITHUB_SEARCH_TOKEN"}
    selected_key = os.environ.get(fields.get(channel, ''), '') if request.get('injected') else ''
    prefixes = ('GROK_', 'TAVILY_', 'EXA_', 'FIRECRAWL_', 'YOU_', 'BRAVE_', 'PARALLEL_', 'PERPLEXITY_', 'BOCHA_', 'SERPER_', 'SEARXNG_', 'GITHUB_SEARCH_')
    for name in list(os.environ):
        if name.startswith(prefixes):
            del os.environ[name]
    if selected_key:
        os.environ[fields[channel]] = selected_key
    backend_dir = Path(os.environ['SEARCH_CENTER_DATA_DIR']) / 'backend'
    os.environ['GROK_CONFIG_DIR'] = str(backend_dir)
    os.environ['GROK_LOG_DIR'] = str(backend_dir / 'logs')
    if encrypted:
        from local_secrets import unprotect
        fields = {"grok": "GROK_API_KEY", "tavily": "TAVILY_API_KEY", "exa": "EXA_API_KEY", "firecrawl": "FIRECRAWL_API_KEY",
                  "you": "YOU_API_KEY", "brave": "BRAVE_API_KEY", "parallel": "PARALLEL_API_KEY", "perplexity": "PERPLEXITY_API_KEY",
                  "bocha": "BOCHA_API_KEY", "serper": "SERPER_API_KEY", "github": "GITHUB_SEARCH_TOKEN"}
        os.environ[fields[channel]] = unprotect(channel, encrypted["id"], encrypted["cipher"])
    urls = {"grok": "GROK_API_URL", "tavily": "TAVILY_API_URL", "exa": "EXA_API_URL",
            "firecrawl": "FIRECRAWL_API_URL", "searxng": "SEARXNG_URL"}
    if base and channel in urls:
        os.environ[urls[channel]] = base
    if channel == "grok" and not base:
        os.environ["GROK_API_URL"] = "https://api.x.ai/v1"
    if channel == 'grok' and args.get('model'):
        os.environ['GROK_MODEL'] = args['model']
    if args.get("operation") == "quota":
        from quota import query
        field = {"tavily": "TAVILY_API_KEY", "firecrawl": "FIRECRAWL_API_KEY"}.get(channel)
        result = await query(channel, base, os.environ.get(field, "") if field else "")
        print(json.dumps({"result": result}, ensure_ascii=False))
        return
    # Explicit channel selection prevents inherited credentials enabling other providers.
    import grok_search.server as server
    if args.get("operation") == "models" and channel == "grok":
        target = server.config.primary_grok_target
        models = await server._fetch_available_models(target.api_url, target.api_key)
        print(json.dumps({"result": {"available_models": models}}, ensure_ascii=False))
        return
    result = await server.web_search(
        args["query"], channels=[channel], profile=args.get("profile", "quick"),
        model=args.get("model", ""), max_results=args.get("count", 3),
        time_budget_seconds=args.get("time_budget_seconds", 20),
        grok_search_mode=args.get("grok_search_mode", "both"),
    )
    print(json.dumps({"result": result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        # Never print exception text, request headers, or credential-bearing URLs.
        sys.exit(1)
