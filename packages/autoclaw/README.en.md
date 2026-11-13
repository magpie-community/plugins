# @magpie-community/opencode-autoclaw-auth

[中文](README.md) | English

An [OpenCode](https://opencode.ai) / [magpie](https://usemagpie.ai) provider plugin for **AutoClaw (Zhipu's OpenClaw cloud account system)**. Talks straight to the upstream cloud API: one sign-in brings both **model calls** and **credit balance**, with multi-account pools, failover, token rotation and daily check-in.

## What this plugin covers

One package registers two providers, split by where the account lives:

| Provider id | Sign-in | Upstream host | Model refs |
|---|---|---|---|
| `autoclaw` | Google / z.ai web OAuth | `autoglm-api.autoglm.ai` | `autoclaw/zai_auto` etc. |
| `autoclaw-cn` | Phone SMS (+86) | `autoglm-api.zhipuai.cn` | `autoclaw-cn/zai_auto` etc. |

Both providers support magpie's multi-account pools, failover, automatic token rotation and credit balance display. 4 online models verified working, as prefixed routeModelIds (`zai_` Zhipu / `zaicoding_` coding plan):

- `zai_auto` / `zai_auto-fast` (auto-routing, reasoning variants: low / high / max)
- `zai_glm-5.3-flash` (fast reasoning, reasoning variants)
- `zaicoding_glm-5.3` (GLM-5.3 coding, reasoning variants)

> Note: the old `zai_glm-5-turbo` and the Doubao DeepSeek mappings `tdpsk_deepseek-v4-flash-202605` / `tdpsk_deepseek-v4-pro-202606` were taken offline upstream (every call returns `400 illegal model`) and have been removed from the model list.

## Signing in

```sh
magpie plugin add @magpie-community/opencode-autoclaw-auth
magpie plugin login autoclaw                   # Google / z.ai web sign-in
magpie plugin login autoclaw-cn                # phone SMS
magpie provider test autoclaw zai_auto
magpie quota                                   # credit balance
```

OpenCode works the same way (`opencode auth login`). Sign-ins are kept in magpie's `plugin-auth.json` (mode 600) or OpenCode's `auth.json`.

**The chat endpoint**: `POST {host}/autoclaw-proxy/proxy/autoclaw/v1/chat/completions`, authenticated with `X-Authorization: Bearer <access token>` (separate from the headers the sign-in/credit endpoints use). Access tokens rotate before they expire — the refresh token is one-time, the `auth.refresh` hook is serialized by magpie, in-flight refreshes for the same token are shared (reused within 60 s), so **a refresh token is never spent twice**; every rotation lands in an in-memory fallback, so a failed write-back loses nothing.

**What the credit line means**: points only, no cap; the wallet breakdown (gift / membership) rides inside the balance string as brackets (`余额行（赠送积分 500 · 会员积分 734）`), never as its own window. The **current-spend** window's percentage is the **share spent since the last rise** (peak − current), not the pool's remainder; a new cycle opens on **any rise** over the last observed balance (including a rise from 0 — check-ins, gifts, redemptions), **without waiting to pass the old peak** (a check-in often lands after spending). Since the daily check-in opens one every day, "current" ≈ "since today's check-in".

**Magpie Web / Docker / remote server sign-in** (from 0.2.23; 0.2.24 changed the entry point and copy buttons; 0.2.25 puts the panel link straight into the sign-in dialog; from 0.2.26 a panel port conflict no longer removes existing accounts):

1. Open the sign-in panel from **Plugins → AutoClaw sign-in** in the sidebar. **With an account already signed in**, right-click the AutoClaw provider row and choose **Open AutoClaw sign-in** (`magpie.actions`) — the add-account dialog no longer blocks the way. From 0.2.25 the add-account dialog itself shows the panel address (the `/_magpie/plugin/<token>/_magpie/service/` path on your current Web address), so clicking it lands in the same panel. Pick Google or z.ai and complete the captcha in the panel.
2. Press **Copy authorization link** (writes straight to the clipboard) and paste it into a new browser tab. After signing in, copy the final callback address from the address bar back into the AutoClaw panel. The callback page may fail to connect; copying its full address is sufficient.
3. The panel exchanges the code and shows a one-time completion code. Press **Copy completion code** and paste it into the sign-in field under **Providers → AutoClaw → Add account**. Magpie then saves the account.

If the pasted callback address fails, expand **Authorization diagnostics** in the panel: it reports vendor, host, client_id, redirect_uri, response_type, scope and link length (never the state or credentials). Google's 400 `malformed` usually means the authorization link was damaged while copying or escaping — the plugin keeps the upstream string verbatim and rejects links containing newlines or `&amp;` entities; press restart to fetch a fresh link.

The panel and its API use Magpie's service proxy on the existing Web address, so Docker needs no additional published port. Upstream still requires `http://localhost:18432/auth/callback-{google|zai}` as an OAuth parameter; the plugin parses the pasted address without listening on or requesting it. Completion codes expire after ten minutes and can be consumed once. Access and refresh tokens stay on the server. Domestic SMS sign-in is unchanged.

Only the page can report the panel address: the host proxy rewrites the request Host to `127.0.0.1:<port>` and strips the `/_magpie/plugin/<token>/_magpie/service` prefix, so the service cannot derive its own public URL from a request. The panel therefore POSTs its own address to `api/address` when it loads (with the CSRF header, and only for a Magpie proxy path or the local `127.0.0.1` root). The link stays valid for ten minutes; if the panel was never opened, the dialog falls back to the plain instructions.

This requires a Magpie version supporting `magpie.page.service`. The internal service listens only on the server's `127.0.0.1:18741`. From 0.2.26 the panel starts on demand: a port conflict only produces an actionable error for a new sign-in and no longer removes the `autoclaw` / `autoclaw-cn` providers or existing accounts (older versions could show `no plugin signs in to autoclaw`). Set the plugin's `loginPort` option (1–65535), then reopen the panel or restart Magpie to retry. Do not expose it publicly. Standalone OpenCode retains its local browser guide, official callback port pool, cancellation, timeout and OAuth state checks.

## Credits on the card

`magpie quota` / a GUI refresh shows, on every AutoClaw card:

- **Credit balance** (prepaid wallet window `{ name: "积分余额", balance, unit: "积分" }`, magpie ≥ v0.1.1790, #3950): routing knows and ranks accounts by their real balance, invents no percentages, and treats 0 as spent out; older magpie builds ignore `balance` and leave the account as-is.
- **Daily check-in** status row (今日已签 ✓ / 今日未签（+N）).
- **Current spend** (aside, display-only, never routed): the upstream has no per-model credit ledger (wallets.v2 carries balances only), so it is computed from local balance deltas — each `usage()` records the cycle peak, `peak − current = spent this cycle`; **any rise** (relative to the last seen balance, including a rise from 0 — check-ins, gifts, redemptions) opens a new cycle. Since a daily check-in opens one every day, "current" ≈ "since today's check-in".
- **Campaign points** (aside): when the account has campaign ledger activity, one extra row at the end — see [Daily check-in](#daily-check-in) below.
- A `total_balance` that is null / empty / non-numeric is treated as unknown ("积分响应异常") and not recorded.

State is kept per account (keyed by `signinAccountKey`, #254: uid, or a hash of the refresh token when there is none) as JSON. Address precedence: `AUTOCLAW_USAGE_STATE_FILE` (explicit override) → `$XDG_CONFIG_HOME/magpie/` → `$HOME/.config/magpie/` (on Windows HOME is usually unset, so `USERPROFILE` next, `os.homedir()` last — never the drive root `C:\.config\magpie`) → file name `autoclaw-usage.json`. Writes go through a temp file + rename; entries untouched for 30 days are pruned; plugin updates do not lose it. Tests can point it elsewhere with `_internal.setUsageStatePath`.

## Daily check-in

Two ways; the native one is recommended:

**① magpie native check-in (magpie ≥ v0.1.1083, recommended)**: the plugin implements the `auth.checkin` hook on magpie's unified schedule — Settings → Usage → Plugins has a **Daily check-in** switch per provider (default off); when on, each account is signed once a day (Beijing time; first check 2 minutes after start, polling every 30 minutes, failures retried 30 minutes later). The account's Usage card shows the result, and **Check in now** signs manually.

**② Legacy auto-sign-in (default off)**: quota reads (`magpie quota`, GUI refresh) and token refreshes sign the account in when it is not yet signed (idempotent upstream, deduped locally by Beijing day; failures are not throttled — the next quota read or refresh retries). For older magpie/OpenCode hosts, or users who prefer this behavior, turn on `signinOnUsage`.

> **"Sign-in for points" campaign rewards**: the server only records an `autoclaw_user_active` event for a `POST /userapi/v1/user-info` that carries the full official desktop business headers (`X-Channel: AutoClaw20`, `X-Version: 2.2.0`, UA `AutoClaw/2.2.0 (win-x64)`, `X-Tm: win-x64`, `X-Product`, …; every platform reports this Windows fingerprint) — without that call, such campaigns pay nothing (yetone/magpie#3681). Measured payouts: international "AutoClaw Weekly Perks" +4000, CN "AutoClaw 用户登录奖励" +5000.
>
> **Only ① the native check-in path calls `user-info`**: with the current access token, refreshed and retried only when the upstream refuses it. `user-info` itself does not complete the daily check-in — that stays with `task-complete`; the two are independent. ② the legacy path, and hosts that never run the `checkin` hook (OpenCode 1.x/2.x), do not earn campaign rewards.

### The campaign points row

When the account has campaign ledger activity (credits, spends or expiries), `usage()` appends one row:

```text
剩 4,000（AutoClaw Weekly Perks） · 已领 14,000 · 过期 7,711（近期）
```

- **Source**: `GET /agent-assetmgr/api/v1/ledgers_std?biz_app_id=autoclaw&page_size=200&wallet_scope=campaign`. The server opens one wallet instance per activity (`wallet_id`), and credit / debit / expire entries all carry `wallet_scope=campaign`; the server may ignore the filter, so entries are re-filtered client-side.
- **How 剩 is computed**: per instance, `credit − debit − expire`, clamped at 0. An instance whose credit fell out of the window counts 0 (its expiry still lands in 过期) — **remaining never over-states**, but out-of-window credits do not participate.
- **已领 / 过期** are window sums (the newest ~151 entries ≈ 18 days; pagination is inert), hence （近期）.
- **Caching**: per account key (`signinAccountKey`), 10 minutes; invalidated the moment check-in's `user-info` reaches the server (a grant may have just landed); a failed read is not cached (the next `usage()` retries); a protocol change (entries not an array) is treated as unknown and cached for 10 minutes. Any read failure only omits the row — balance and check-in rows are never affected.
- **The row never carries `balance`**: magpie (≥ v0.1.1790) treats a window's `balance` as a prepaid routing pool (#3950) and would double-count it.
- **Numbers are grouped in threes** (`fmtPoints`, locale-independent); the wallet breakdown inside the balance line is not (yet).

## Options

The legacy path has **two switches** (plugin options first, config file fallback; the native check-in switch lives only in the GUI's Settings):

```sh
# Channel 1: plugin options (magpie CLI)
magpie plugin options @magpie-community/opencode-autoclaw-auth '{"signin": false}'        # master off
magpie plugin options @magpie-community/opencode-autoclaw-auth '{"signinHour": 8}'        # only 8:00–8:59
magpie plugin options @magpie-community/opencode-autoclaw-auth '{"signinOnUsage": true}'  # sign on quota reads / refreshes

# Channel 2: config file ~/.config/magpie/autoclaw.json (hot-read)
cat > ~/.config/magpie/autoclaw.json <<'EOF'
{ "signin": true, "signinHour": null, "signinOnUsage": true }
EOF
```

| Option | Default | Meaning |
|---|---|---|
| `signin` | `true` | legacy auto-sign-in master switch (does not affect native check-in) |
| `signinOnUsage` | `false` | sign in on quota reads / refreshes (default off, left to the native switch) |
| `signinHour` | `null` | restrict the sign-in hour: `8` = only when local time is 8:00–8:59; `null` = no restriction |
| `dump406` | `false` | master switch for the 406 dump (boolean; the string `"false"` does not count as on). Writes to `~/.config/magpie/autoclaw-406/`; the `AUTOCLAW_406_DUMP_DIR` env var overrides the address and turns it on by itself (takes precedence over this option) |

## The chat gateway and request shaping

AutoClaw's chat gateway enforces a strict request shape; missing any item returns an empty-body `406 Not Acceptable`:
- **Official system prefix**: must start with `You are AutoClaw. Answer the user directly and concisely.` (the plugin merges it into the caller's system messages, or adds a minimal one when there is none)
- **max_tokens removed**: the gateway refuses `max_tokens` / `max_completion_tokens`; the plugin strips them before sending
- **No X-Harness-Type**: the upstream 406s on that header; the legacy header is deleted
- **External harness identity lines rewritten**: the upstream intercepts system messages that announce an external agent identity ("You are Codex", "You are Claude Code", …); the plugin's `unflag` rewrites them into compatible wording
- **Official client fingerprint (international chat)**: international chat requests carry the full header set of the official AutoClaw 2.0.3 desktop client (`official` channel), taken from its AppImage's `dist/main.cjs`: `X-Channel: official`, `X-Version: 2.0.3`, `X-Lang: en`, `X-Client-Type: pc`, `X-Product: autoclaw`, `x_trace_id: autoclaw-desktop`, `X-Auth-Appid/X-Auth-TimeStamp/X-Auth-Sign` (`md5("100003&<second timestamp>&<appKey>")`, the same signature as sign-in and credits), `X-Request-Id` = `X-Trace-Id` (one UUID per request), `X-Session-Id` (a UUID constant per conversation, derived from the first message), OpenAI SDK 6.26.0's `User-Agent` and `X-Stainless-*`. macOS / Windows keep the official `managedPlatform()` value (`mac` / `win`). International chat omits `X-Tm` on Linux because the gateway still rejects the exact `linux` value for plugin accounts (403 `forbidden` on both x64 and arm64, #367); reporters verified omission works, and it does not impersonate another OS.

The CN build `autoclaw-cn` goes through AutoClaw 2.1.0's managed gateway (`autoglm-acceleration-api.zhipuai.cn`); the international `autoclaw` goes through the overseas direct gateway (`autoglm-api.autoglm.ai`). Both verified with real calls and inference.

### The 406 dump (off by default)

A 406's upstream body is empty and magpie keeps only token counts — diagnosing a sentence the FLAGGED list misses needs the refused request's own text. When enabled (the `AUTOCLAW_406_DUMP_DIR` env var, or the plugin option `"dump406": true`), every 406 writes the **rewritten, actually-sent** system/developer messages (plus the `model` field; never user/assistant/tool content) as one JSON: file mode 0600, directory 0700, the newest 10 kept (rotated by write time; only files matching `autoclaw-406-*.json` are ever touched).

**Privacy note**: system prompts are not free of personal data — harnesses put the working directory, git status, project instruction files, sometimes the user's email there. This is a local 0600 diagnostic file, off by default; know that before turning it on. `AUTOCLAW_406_DUMP_DIR` may point at any existing directory (rotation only deletes the dump's own files); the default directory falls back `HOME` → `USERPROFILE` → `os.homedir()` on Windows GUI processes (which usually have no `HOME`).

## Known behavior

- Phone-number accounts only ever use the CN host (managed gateway; 401/403 mark the sign-in expired); z.ai/Google accounts only the international host (401/403 retries the other side, both refusing marks it expired). Exception: on an exact bare `403 forbidden`, the plugin checks the credits route: a healthy credential keeps the sign-in and surfaces the client-fingerprint refusal; a credential refused there expires; a failed check passes the upstream 403 through without guessing the sign-in state.
- An exhausted quota is not a signed-out account: a `403` + `{"code":810000,"message":"GLM-5.3 免费额度已用完,…"}` answer (or a 403 body about quotas/balances) becomes a `429` carrying the upstream's own words, the sign-in is kept (`X-Magpie-Sign-In: kept`), and the international side stops host-hopping (plugins#274).
- A banned account is not a signed-out account: a `403` + `{"code":410004,"message":"The account has been banned"}` answer (or code/message fields saying banned / 封禁 / 账号异常 / 账号被冻结) flows through on chat, refresh, credits and check-in with the upstream's own words; chat becomes a `403 permission_error`, the sign-in is kept, no host-hopping. Other 401/403s still mark the sign-in expired.
- A request too large is not a signed-out account (plugins#891): the CN gateway answers a ~200k-token request `401 AutoClaw 登录状态失效` while the same token's smaller requests seconds before and after get 200. A 401/403 for a body larger than the largest this process has seen answered has its sign-in checked on the credits route: a sign-in that holds turns it into `413 request_too_large` with the sign-in kept, so magpie tries another route or has the agent compact. A sign-in refused there too, a check that fails, or a body no larger than one answered is still the sign-in. No threshold is guessed; the comparison is with the largest request answered.
- DeepSeek Harness is masked throughout system, not only in its identity line (plugins#924): the gateway refuses the name anywhere in system or developer text, so every `DeepSeek Harness` there becomes `DeepSeek`, and the identity line (with or without a comma) becomes `You are an AI agent powered by a local coding harness.` A `powered by the glm-<x> model` sentence in any case is written in the `GLM-<x>` form. User messages and tool arguments are never changed.
- The upstream model whitelist changes with versions; a retired model returns `400 illegal model` (the error message passes through).
- Refresh tokens are **mutually evicting** with the AutoClaw desktop app (both rotate) — do not stay signed in on desktop with the same account.
- When the upstream changes protocols, `CLIENT_VERSION` / endpoint paths may need to follow the official client.

### Local sign-in page ownership

The plugin waits for the loopback listener before returning its guide URL. Magpie/OpenCode opens that URL; the callback does not launch a second browser through a shell. Cancelled or expired sessions release their port; begin a new sign-in rather than reusing the old URL.

The guide distinguishes an intentional authorization redirect from the user closing the page. The redirect must keep the loopback callback alive; closing a guide before authorization still cancels it. The guide reports a disconnected or expired session explicitly.

## Disclaimer

This is an **unofficial** community plugin, unaffiliated with Zhipu AI / OpenClaw / AutoClaw. It is built on reverse-engineering and live testing of the official client's behavior, for personal study only; account risks are the user's own. Upstream protocol changes can break it at any time.
