## 中文说明

在 Magpie 窗口里看到**每个模型在所有账号、所有供应商的池子里还剩多少 token**。
它把每个额度窗口换算成 token，再按模型在窗口内的占比摊开，最后跨账号、跨供应商合并。

```sh
magpie plugin add @magpie-community/page-model-quota
```

# @magpie-community/page-model-quota

## English

A page in Magpie's window that answers one question: **how many tokens does each
model have left, across every account and every provider at once**.

Every quota window Magpie tracks — a 5-hour window, a 7-day window, a month of
credits, a token package — is turned into tokens using your own usage history,
split by each model's share inside that window, and then added up per model
across accounts and providers.

```sh
magpie plugin add @magpie-community/page-model-quota
```

## How the number is made

1. **Tokens per 1% of a window.** For each account and window, the page takes the
   readings in `quota-history.json`, cuts them into rounds (a round ends where the
   percentage jumps back up), and divides the tokens spent during a round by the
   percentage that round dropped. The median over the complete rounds is that
   window's tokens per 1%. Rounds with fewer than five calls are left out, so one
   oversized request cannot define a window.
2. **Tokens left in the window.** Remaining percentage × tokens per 1%.
3. **Split by model.** The usage rows inside that same round carry a model, so the
   window's tokens are split by the share each model had in it. Model names are
   normalized: `grok-4.7@500k` and `grok-4.7@256k` are one model.
4. **Merge.** The same model's share from every account and provider is added up.

Nested rate windows are handled as one allowance: a 5-hour window only throttles
speed, so the longest window of an account (7 days, Month, Weekly) is what counts
as its remaining allowance. If that longest window is spent, the account counts as
used up, and its shorter windows are not counted as available either.

Credit windows (`Credits`, `Extra credits`, token packages, trials) are counted one
by one; a window named `Total credits` or `总积分` is the sum of the others, so it
replaces them instead of adding to them. Windows measured in something other than
credits or tokens (requests, questions) are skipped.

## Where the data comes from

- `usage.jsonl` — one line per request, with `in`, `out`, `cache_read`,
  `cache_write` and `reasoning`. Tokens are their sum.
- `quota-history.json` — the remaining percentage Magpie recorded for each account
  and window, with the time of the reading.
- `quotas.json` — the current quota snapshot, used when the gateway does not answer.
- `GET /v1/magpie/quotas?kept=1` on the local gateway — the current remaining
  percentage, preferred over the snapshot.

Nothing leaves the machine. The service asks the local gateway and reads the files
above; there is no telemetry and no other request.

## Architecture

- `page/index.html` and `page/boot.js` are the launcher Magpie sandboxes. They read
  the theme, the language and this plugin's options, then navigate the frame to the
  local service. They never probe it: a plugin page's CSP is `connect-src 'none'`.
- `lib/server.mjs` is that service, started from `index.mjs` by Magpie's Bun host
  and stopped with the plugin. It serves `ui/` and `/api/report`.
- `lib/report.mjs` holds the estimation itself and has no I/O, so the tests can call
  it directly.

The service binds `127.0.0.1` only, on port 3496 by default; set `port` in the
plugin's options to change it. `Host` must be `127.0.0.1:<port>` or
`localhost:<port>`. Every `/api` route except `/api/ping` needs a key generated at
each start and injected into the HTML this instance serves; that HTML is returned
only to navigation requests, so another page cannot fetch it to read the key. A
sandboxed frame's `Origin: null` is accepted only together with the key.

## What it does not do

- It does not ask providers for quota. Magpie's own plugin does that; this page
  reads what Magpie recorded.
- It cannot estimate a window with no history: no readings, or no usage to line up
  with them, means no number, and the window is named in the footer.
- A window whose latest round has far fewer records than its history is marked
  "from past rounds" — the number is still shown, with that caveat.

## Tests

```sh
node --test test/*.test.mjs
```

They build a small config directory in a temp folder, start the service on port 0
and check the guards (host, origin, key) and the estimate itself.
