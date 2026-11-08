# @magpie-community/tools-specstream

[SpecStream](https://specstream.ai) Search API and Extract API for every agent magpie connects, and as a web search API in Settings > Models > Web search.

- `web_search`: `GET https://api.specstream.ai/v1/web-search`, $5 per 1,000 searches. Returns an answer when the evidence supports one, the rows found with the page each value was read from, and the sources in rank order.
- `extract`: `POST https://api.specstream.ai/v1/extract`, up to 20 URLs a call, $0.80 per 1,000 pages. Returns each page's text as markdown or plain text, with title, date and email addresses. A page with no text is not charged.

```sh
magpie plugin add @magpie-community/tools-specstream
```

Set `SPECSTREAM_API_KEY` for the tools (a key from [specstream.ai](https://specstream.ai); new accounts start with $10 of credit). The web search entry uses the key magpie keeps for it.

Both replies are wrapped as `{"request_id", "status", "data", "error"}`. The package reads `data` and, when it is null, raises `error.message` with the HTTP status, so a refused key (401, 402, 403, 429) rests in magpie's key rotation.

Accuracy and method: [specstream.ai/benchmarks](https://specstream.ai/benchmarks). API reference: [specstream.ai/search-api](https://specstream.ai/search-api) and [specstream.ai/extract-api](https://specstream.ai/extract-api).

Test: `bun test packages/specstream`. The tests use mocked replies and never call the API.
