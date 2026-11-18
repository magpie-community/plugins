# AnySearch — magpie web search plugin

> **Third-party community plugin.** Not affiliated with, endorsed by, or sponsored by
> AnySearch. This plugin calls AnySearch's publicly documented Search API
> (`POST https://api.anysearch.com/v1/search`) with **your own** API key. No
> reverse-engineered or private protocol. You bear any account, quota, billing and
> interface-change risk.

**中文简介：** 把 AnySearch 接成 magpie 的网页搜索 API（Settings › Models › Web
search），让 magpie、Alma、Pi 等所有走 magpie 的 agent 共用一份搜索配置和 key。
插件只做协议转换，不保存 key、不记录查询；key 由 magpie 保管、轮换和掩码显示。

## Why a plugin

magpie ships Tavily, Brave, Exa, Firecrawl and others natively, but not AnySearch.
Its documented `search` hook is the sanctioned way to add one: magpie keeps the
keys, order, masking, request log and resting/failover, and calls this plugin only
while it and magpie's Web search plugin are on.

## Install

```sh
magpie plugin add <path-to-this-folder>     # or github:czdtech/magpie-anysearch
magpie search add anysearch:anysearch <key>
magpie search                               # AnySearch is listed, key masked
magpie tool web_search "Go 1.26 release notes"
```

Get a key at <https://www.anysearch.com/>. AnySearch also has an anonymous
per-IP free tier, but this plugin is declared `keyOptional: false`, so magpie
expects a key.

Restart magpie after adding or editing the plugin: there is no hot-reload. In the
macOS app, quit and reopen it; with `magpie serve`, restart the process.

## What it does

`index.ts` exports one `search` entry, `anysearch`, implemented against
AnySearch's Search API:

- Request: `POST https://api.anysearch.com/v1/search`, `Authorization: Bearer
  <key>`, JSON `{ "query": …, "max_results": … }`.
- Success: HTTP 200 with `code: 0` and `data.results[]`.
- The plugin maps each result to magpie's `{ title, url, text }`, using the
  result's `content` when present, otherwise its `snippet`.
- A non-2xx answer throws with the HTTP `status`, so magpie rests the key on
  401/402/403/429 and fails over to the next search API on any other error.
- magpie strips tags, cuts each page's text and masks the query in its request
  log, as it does for its built-in search APIs.

The `tag` and `params` fields AnySearch documents for intent routing are not
exposed: magpie passes only a query and a count.

## Verify

```sh
magpie search                 # 1. AnySearch (key masked)
magpie tool web_search "AnySearch API documentation"
```

To prove the plugin itself answers, switch the other search APIs off, search,
then switch them back on:

```sh
magpie search off exa
magpie tool web_search "AnySearch API documentation"
magpie search on exa
```

## Notes

- **No hot-reload:** restart magpie after editing `index.ts`.
- **Proxy:** the plugin host runs on magpie's bundled Bun; `HTTPS_PROXY` /
  `HTTP_PROXY` / `ALL_PROXY` must be set explicitly for restricted networks
  (Bun ignores the macOS system proxy).
- **Quota and billing:** see AnySearch's pricing page. magpie shows no usage
  counter for this API; use the AnySearch console.
- **Secrets:** never put a key in this repository or in `package.json`; add it
  only through `magpie search add`.
- Runs on magpie's plugin host; no extra runtime to install.

## Files

- `index.ts` — the search hook.
- `package.json` — manifest (`magpie` name and summary).
- `README.md` — this file.

## License

MIT
