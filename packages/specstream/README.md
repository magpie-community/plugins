# @magpie-community/tools-specstream

[SpecStream](https://specstream.ai) Search API and Extract API for every agent magpie connects, and as a web search API in Settings > Models > Web search.

- `web_search`: `GET https://api.specstream.ai/v1/web-search`, $5 per 1,000 searches of up to 10 sources; `count` is sent as `num` (1 to 100), and each started block of 10 more sources adds $0.006 to the call. Returns an answer when the evidence supports one, the rows found with the page each value was read from, and the sources in rank order.
- `extract`: `POST https://api.specstream.ai/v1/extract`, up to 20 URLs a call, $0.80 per 1,000 pages. Returns each page's text as markdown or plain text, with its title and the date it says it was published. A page with no text is not charged.

```sh
magpie plugin add @magpie-community/tools-specstream
```

Set `SPECSTREAM_API_KEY` for the tools (a key from [Agents & API](https://specstream.ai/workspace/agents?tab=keys) in a SpecStream workspace). The web search entry uses only the key magpie keeps for it, asks for the `count` magpie passes, and trims the sources to it.

A call that succeeds returns `{"data": {...}}`, and one that stops returns `{"error": {"code", "message"}}`. The package reads `data` and, when there is none, raises `error.message` with the HTTP status. A missing or unknown key (401), an empty balance (402) and a spending limit (403) rest the key in magpie's key rotation. SpecStream signals its per-minute limit with 503 and `Retry-After`, not 429, so magpie counts that as a plain failure and asks the next search API; the key is not rested.

API reference: [search-api.md](https://specstream.ai/docs/search-api.md) and [extract-api.md](https://specstream.ai/docs/extract-api.md); `num` is in [agents.md](https://specstream.ai/agents.md).

Test: `bun test packages/specstream`. The tests use mocked replies and never call the API.
