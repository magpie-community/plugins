"""Additional search APIs. Credentials come from the server process environment."""
import asyncio
import html
import os
import re
import time
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

import httpx


CATALOG = {
    "you": {
        "name": "You.com", "kind": "web", "required_env": [],
        "optional_env": ["YOU_API_KEY"],
        "use_when": "General web/news search. Keyless endpoint is rate limited; API key uses the official paid Search API.",
    },
    "brave": {
        "name": "Brave Search", "kind": "web", "required_env": ["BRAVE_API_KEY"],
        "use_when": "Independent general web index; useful as a second source to compare with existing engines.",
    },
    "parallel": {
        "name": "Parallel", "kind": "web", "required_env": ["PARALLEL_API_KEY"],
        "use_when": "Natural-language web research with excerpts. quick=turbo, balanced=fast, deep=advanced.",
    },
    "perplexity": {
        "name": "Perplexity Search", "kind": "web", "required_env": ["PERPLEXITY_API_KEY"],
        "use_when": "Ranked results via Search API, not a Sonar completion. quick uses search_type=fast; other profiles use web.",
    },
    "bocha": {
        "name": "博查", "kind": "web", "required_env": ["BOCHA_API_KEY"],
        "use_when": "Candidate for Chinese-language web search and cross-checking; compare relevance on the actual query.",
    },
    "serper": {
        "name": "Serper", "kind": "web", "required_env": ["SERPER_API_KEY"],
        "use_when": "Google search results through Serper; useful when a Google-oriented result set is wanted.",
    },
    "searxng": {
        "name": "SearXNG", "kind": "metasearch", "required_env": ["SEARXNG_URL"],
        "use_when": "A user-controlled SearXNG instance with JSON output enabled. Not an arbitrary public instance.",
    },
    "github": {
        "name": "GitHub repositories", "kind": "code", "required_env": [],
        "optional_env": ["GITHUB_SEARCH_TOKEN"],
        "use_when": "Find public repositories using short keywords and GitHub repository qualifiers. Not code/file-content search.",
    },
    "arxiv": {
        "name": "arXiv", "kind": "papers", "required_env": [],
        "use_when": "Find preprints. Use English keywords or native arXiv syntax such as all:retrieval AND all:augmented.",
    },
    "crossref": {
        "name": "Crossref", "kind": "bibliography", "required_env": [],
        "use_when": "Find scholarly works, titles and DOIs. Metadata may lack abstracts; this is not full-text search.",
    },
}

_ARXIV_LOCK = asyncio.Lock()
_ARXIV_LAST = 0.0


def availability(name):
    info = CATALOG[name]
    enabled = os.getenv(f"{name.upper()}_ENABLED", "true").lower() not in ("false", "0", "no")
    missing = [field for field in info["required_env"] if not os.getenv(field, "").strip()]
    return {**info, "enabled": enabled, "configured": enabled and not missing, "missing_env": missing}


def _text(value):
    if isinstance(value, list):
        value = " ".join(str(item) for item in value if item)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))).strip()[:2400]


def _page(url, title="", description="", date=""):
    if not isinstance(url, str):
        return None
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return {"url": url, "title": _text(title), "description": _text(description),
            "published_date": _text(date)}


def normalize(name, data, count):
    """Validate each API shape so API errors cannot masquerade as empty search results."""
    if name == "arxiv":
        root = ET.fromstring(data)
        ns = {"a": "http://www.w3.org/2005/Atom"}
        entries = root.findall("a:entry", ns)
        pages = []
        for item in entries:
            if item.findtext("a:id", "", ns).endswith("/api/errors"):
                raise ValueError("arXiv rejected the query syntax")
            link = next((x.get("href") for x in item.findall("a:link", ns)
                         if x.get("rel") == "alternate"), item.findtext("a:id", "", ns))
            pages.append(_page(link, item.findtext("a:title", "", ns),
                               item.findtext("a:summary", "", ns), item.findtext("a:published", "", ns)))
    elif name == "you":
        rows = data["results"]
        pages = [_page(x.get("url"), x.get("title"), x.get("snippets") or x.get("description"), x.get("page_age"))
                 for x in rows.get("web", []) + rows.get("news", [])]
    elif name == "brave":
        if data.get("type") == "ErrorResponse":
            raise ValueError("Brave returned an API error")
        pages = [_page(x.get("url"), x.get("title"), x.get("description"), x.get("age"))
                 for x in data.get("web", {}).get("results", [])]
    elif name in ("parallel", "perplexity", "searxng"):
        pages = [_page(x.get("url"), x.get("title"),
                       x.get("excerpts") or x.get("snippet") or x.get("content"),
                       x.get("publish_date") or x.get("date") or x.get("publishedDate"))
                 for x in data["results"]]
    elif name == "bocha":
        if data.get("code") not in (None, 200):
            raise ValueError("Bocha returned an API error")
        pages = [_page(x.get("url"), x.get("name"), x.get("summary") or x.get("snippet"), x.get("datePublished"))
                 for x in data["data"].get("webPages", {}).get("value", [])]
    elif name == "serper":
        if "organic" not in data and "searchParameters" not in data:
            raise ValueError("Serper returned no search response")
        pages = [_page(x.get("link"), x.get("title"), x.get("snippet"), x.get("date"))
                 for x in data.get("organic", [])]
    elif name == "github":
        pages = [_page(x.get("html_url"), x.get("full_name"), x.get("description"), x.get("updated_at"))
                 for x in data["items"]]
    elif name == "crossref":
        if data.get("status") != "ok":
            raise ValueError("Crossref returned an API error")
        pages = [_page(x.get("URL"), (x.get("title") or [""])[0],
                       x.get("abstract") or "DOI: " + x.get("DOI", ""),
                       "-".join(str(p) for p in x.get("published", {}).get("date-parts", [[]])[0]))
                 for x in data["message"]["items"]]
    else:
        raise ValueError(f"Unknown search channel: {name}")
    seen, result = set(), []
    for page in pages:
        if page and page["url"] not in seen:
            seen.add(page["url"])
            page["provider"] = name
            result.append(page)
        if len(result) >= count:
            break
    return result


async def search(name, query, count, *, profile="quick", transport=None):
    global _ARXIV_LAST
    state = availability(name)
    if not state["configured"]:
        raise ValueError(f"{name} is disabled or missing configuration: {', '.join(state['missing_env'])}")
    headers = {"User-Agent": "magpie-search/0.3", "Accept": "application/json"}
    method, body, params = "GET", None, {}
    if name == "you":
        key = os.getenv("YOU_API_KEY", "").strip()
        if key:
            url, method = "https://ydc-index.io/v1/search", "POST"
            headers["X-API-Key"] = key
            body = {"query": query, "count": count}
        else:
            url = "https://api.you.com/v1/agents/search"
            params = {"query": query, "count": count}
    elif name == "brave":
        url = "https://api.search.brave.com/res/v1/web/search"
        headers["X-Subscription-Token"] = os.environ["BRAVE_API_KEY"]
        params = {"q": query, "count": min(count, 20)}
    elif name == "parallel":
        url, method = "https://api.parallel.ai/v1/search", "POST"
        headers["x-api-key"] = os.environ["PARALLEL_API_KEY"]
        body = {"objective": query, "search_queries": [query], "max_results": count,
                "mode": {"quick": "turbo", "balanced": "fast", "deep": "advanced"}[profile]}
    elif name == "perplexity":
        url, method = "https://api.perplexity.ai/search", "POST"
        headers["Authorization"] = "Bearer " + os.environ["PERPLEXITY_API_KEY"]
        body = {"query": query, "max_results": min(count, 20),
                "search_type": "fast" if profile == "quick" else "web"}
    elif name == "bocha":
        url, method = "https://api.bochaai.com/v1/web-search", "POST"
        headers["Authorization"] = "Bearer " + os.environ["BOCHA_API_KEY"]
        body = {"query": query, "count": count, "summary": True, "freshness": "noLimit"}
    elif name == "serper":
        url, method = "https://google.serper.dev/search", "POST"
        headers["X-API-KEY"] = os.environ["SERPER_API_KEY"]
        body = {"q": query, "num": count}
    elif name == "searxng":
        base = os.environ["SEARXNG_URL"].rstrip("/")
        if urlsplit(base).scheme not in ("http", "https"):
            raise ValueError("SEARXNG_URL must be an http(s) instance URL")
        url = base if base.endswith("/search") else base + "/search"
        params = {"q": query, "format": "json"}
    elif name == "github":
        url = "https://api.github.com/search/repositories"
        headers["Accept"] = "application/vnd.github+json"
        headers["X-GitHub-Api-Version"] = "2022-11-28"
        token = os.getenv("GITHUB_SEARCH_TOKEN", "").strip()
        if token:
            headers["Authorization"] = "Bearer " + token
        params = {"q": query, "per_page": count}
    elif name == "arxiv":
        url = "https://export.arxiv.org/api/query"
        headers["Accept"] = "application/atom+xml"
        params = {"search_query": query if ":" in query else "all:" + query,
                  "start": 0, "max_results": count}
        async with _ARXIV_LOCK:
            delay = 3.1 - (time.monotonic() - _ARXIV_LAST)
            if delay > 0:
                await asyncio.sleep(delay)
            _ARXIV_LAST = time.monotonic()
    elif name == "crossref":
        url = "https://api.crossref.org/works"
        params = {"query.bibliographic": query, "rows": count}
    else:
        raise ValueError(f"Unknown search channel: {name}")
    async with httpx.AsyncClient(timeout=20, transport=transport, follow_redirects=False) as client:
        response = await client.request(method, url, headers=headers, params=params, json=body)
        response.raise_for_status()
        return normalize(name, response.text if name == "arxiv" else response.json(), count)
