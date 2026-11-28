# bailucode

[BAILU AI](https://bailucode.com) (白鹿) for magpie and OpenCode: the Open
Platform's models, its API key or a browser sign-in that fetches yours, the
account's quota on the provider card, and the portal's daily check-in.

- API keys: <https://bailucode.com/api_platform/#api-keys>
- Gateway: `https://bailucode.com/openapi/v1` — one Bearer key, three faces
  (OpenAI Chat Completions, Anthropic Messages, OpenAI Responses), plus
  embeddings, all verified against the live gateway.

## Signing in

Two ways, both from the provider's own sign-in:

- **API key** — paste `sk-…`. Nothing else is asked: the gateway address is
  fixed, and a different one comes from the plugin's options
  (`{"baseURL":"https://your-mirror/openapi/v1"}`).
- **Browser sign-in** — the plugin opens Chrome against a throwaway profile
  (created per sign-in, removed afterwards) on the portal's login page; you
  finish the email sign-in there, and it reads the cookies over CDP (httpOnly
  included), trades them for the key your account already holds
  (`POST /api/api_keys {"action":"get_keys"}`), and keeps that session **on the
  account itself** (its `metadata`), never in a file another account would read.
  With a working session on that account it skips the browser entirely. Only an
  account with no *active* key gets one created (`create_key`, name `magpie`;
  a disabled key counts as none).

## What the card shows

`GET /openapi/v1/models` gives the key's own model list (9 ids at the time of writing, all `bailu-*` / `yuyu-*`; the gateway's count is its own, and it served 27 earlier that day). The quota is
account-scoped, so it comes from the signed-in dashboard
(`https://bailucode.com/auth/`), whose wallet the page carries as
`var S = {...}`:

| Line | From | Example |
| --- | --- | --- |
| 白鹿编码 | `code.planRemain` + `code.addonTokens / 1000` | `21,500 Credits` |
| API 平台 | `api.usedEff` / `api.quotaEff`, reset day from the page | `657 / 3.18 亿 Tokens` |
| 定向额度 | `packs[]` (Anthropic and friends) | `剩 500 万 / 共 500 万 Tokens` |

The browser sign-in stores the session on the account. To point an account at a
session by hand, name it: the `session` option or `BAILUCODE_SESSION`; a file is
read only when `sessionFile` names it (and written 0600 in a 0700 directory).
No default path is read on its own — that is what made two accounts share one
wallet.

## What writes

Only two, both the portal's own endpoints: `create_key` when the account holds
no active key, and `claim_*` when you press check-in. The logout route is never
called.

## Check-in

`magpie accounts checkin` (or the card's check-in entry) takes the portal's
three daily items when it can, and says what happened when it can't:

- `done` — all three already taken today (nothing is sent)
- `captcha` — a claim needs Cap human verification, which this plugin never
  solves: open <https://bailucode.com/auth/> and tap the claim, or hand it a
  ticket (`{"captchaTicket":"…"}`, `BAILUCODE_CAPTCHA`)
- `claimed` — with a ticket it posts `claim_daily_checkin` /
  `claim_anthropic_promo` / `claim_openclaw_promo`, and reports the credit

`until` is the portal's next midnight (Asia/Shanghai), which is when the three
open again.

## Notes

- Cloudflare answers a browser-shaped user agent sent over a non-browser TLS
  stack with a challenge; this plugin keeps an honest client user agent on every
  request, which the gateway accepts.
- The gateway has no per-key quota route (probed over a hundred paths), so
  without a portal session the card shows only whether the key is accepted.

## Test

```sh
bun test
```