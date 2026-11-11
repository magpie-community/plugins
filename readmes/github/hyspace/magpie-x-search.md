# magpie-x-search

**X (Twitter) search for every agent behind [magpie](https://usemagpie.ai)**: a magpie *tools* plugin.

It adds two tools (`<plugin>_<tool>`; the plugin is named `x`): `x_search`, which searches public X/Twitter posts (tweets) in real time using Grok's native X search, and `x_read`, which reads one specific post from its URL. The search runs through the **Grok (SuperGrok) provider you already signed in to in magpie**, so there is no extra API key and the plugin never sees your credentials. Because magpie serves plugin tools to *all* agents, Claude Code on Kimi, Codex on DeepSeek, Pi, Hermes… anything that can use magpie's MCP endpoint gets Twitter search, whatever model it runs on.

> 中文简介：把 magpie 里登录的 SuperGrok 的 X（推特）搜索做成 magpie 工具插件，所有走 magpie 的 agent（不论底层模型）都能搜推特。

## Requirements

- magpie running, with the **Grok (SuperGrok) provider added and signed in** (sign in with Grok Build). Keep at least one Grok model ticked (Models → *Picked only*). Without it the tool returns a clear error.
- Searches count against your SuperGrok quota (one search is roughly 10k tokens of Grok usage).
- Node ≥ 20 is only needed to run the tests; magpie's own plugin host runs the plugin.

## Install

```bash
magpie plugin add github:hyspace/magpie-x-search
# private fork or no GitHub API access? use git over ssh:
# magpie plugin add git+ssh://git@github.com/hyspace/magpie-x-search.git
magpie tools                      # should list x_search and x_read under "tools"
```

Then let your agents see it. Pick one:

```bash
# A. one MCP entry (magpie) for every agent, including all plugin tools: recommended
magpie library mcp router on

# B. or give just this tool to chosen agents
magpie library mcp agents x pi,hermes
```

`magpie library` shows the entry and which agents have it. Restart an agent session after changing its tools. The raw endpoint is `http://127.0.0.1:3425/mcp/magpie/tools` (Streamable HTTP) if you want to add it by hand, e.g.
`claude mcp add --transport http magpie-tools http://127.0.0.1:3425/mcp/magpie/tools`.

Try it without any agent:

```bash
magpie tool x_search --query "what is @karpathy posting about?" --allowed_x_handles karpathy
```

## Tool: `x_search`

| arg | description |
|---|---|
| `query` (required) | what to look for, natural language |
| `allowed_x_handles` | only posts from these accounts (≤ 20, `@` optional); exclusive with `excluded_x_handles` |
| `excluded_x_handles` | ignore these accounts (≤ 20) |
| `from_date`, `to_date` | `YYYY-MM-DD` |
| `max_results` | roughly how many posts to list, 1–20 (default 5) |
| `enable_image_understanding`, `enable_video_understanding` | let Grok look at media (slower, more quota) |
| `refresh` | bypass the 5-minute cache |

Returns Grok's summary of what it found plus the source post URLs.

## Tool: `x_read`

Reads **one** post by link, for when an agent is handed an `x.com/…/status/…` URL (web fetch cannot read X).

| arg | description |
|---|---|
| `url` (required) | `https://x.com/<handle>/status/<id>` (`twitter.com`, `mobile.twitter.com`, `fxtwitter.com`, `vxtwitter.com`, `/i/status/<id>` also work) or the bare numeric id |
| `include_replies` | also list this many replies from other accounts (1–20); default none |
| `enable_image_understanding`, `enable_video_understanding` | let Grok describe media (slower, more quota) |
| `refresh` | bypass the 5-minute cache |

Returns author, time, the full text (asked verbatim), the replied-to / quoted post, the author's own follow-up posts of the thread, media URLs and counts, then the source URLs. A search takes ~10–30 s; a read ~10–20 s.

How it works: Grok's server-side tool runs its own `x_thread_fetch(post_id)` for the id. The plugin sends the same `x_search` tool with `max_tool_calls: 1` and a "fetch this exact post" prompt, then **checks the reply really contains an `x_thread_fetch` call for that id**; if not (deleted, protected, or Grok answered from memory) it errors instead of returning a guess. The text still passes through Grok, so it is faithful but not a raw API dump. Posts by the same author further down a long thread are returned only when Grok's fetch includes them; otherwise read those URLs one by one.

## Configuration

```bash
magpie plugin options x '{"perMinute":10,"cacheSec":600}'     # 'off' clears
```

| option | default | |
|---|---|---|
| `model` | auto | Grok model id; auto = highest-versioned `grok/*` model that serves `/v1/responses` |
| `maxToolCalls` | 3 | X searches Grok may run per tool call (keeps it under magpie's 55 s tool limit) |
| `cacheSec` | 300 | identical calls reuse the result (`x_read`: per post id); concurrent identical calls are merged |
| `perMinute` / `perDay` | 6 / 200 | shared cap across **all** agents and both tools, protects your SuperGrok quota; cache hits are free |
| `concurrency` | 2 | simultaneous upstream searches |
| `gateway` | `http://127.0.0.1:3425` (or `$MAGPIE_ADDR`) | magpie gateway |

Counters and cache live in memory and reset when magpie restarts the plugin.

## How it works

The tool calls magpie's own gateway: `POST /v1/responses` with `model: grok/…`, `tools: [{type:"x_search", …filters}]`, `tool_choice: "required"`. magpie's Grok plugin forwards that to Grok, which runs the X search server-side. Calls are labelled `x-search` in magpie's Usage, so you can see what this tool costs.

## Limits

- magpie tool calls are cut off at 55 s; the plugin gives up at 50 s. A search usually takes 10–30 s.
- Only public posts that Grok's X search can reach.
- Source lists can contain `x.com/i/status/…` links and a few duplicates (Grok's citation format).

## Develop

```bash
npm test                      # fake gateway, no network
magpie plugin add ./          # load this checkout in place (the tool prefix is the package name)
```

The module exports exactly one function (`XSearchTools`), which returns both tools: magpie calls every export as a plugin.

## License

MIT
