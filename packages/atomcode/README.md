# AtomCode

[中文](README.zh-CN.md) | English

An (unofficial) provider plugin for [magpie](https://usemagpie.ai) that brings **ATOMCODE (AtomGit CodingPlan)** in.

After signing in through AtomGit or reusing the official AtomCode CLI's local
sign-in, the CodingPlan models appear in magpie as the **ATOMCODE** provider.
Any agent — Claude Code, Codex, OpenCode — can use `atomcode/<model>`. The plan,
the daily check-in and rolling quota windows show up on the account row, in
`magpie quota`, and in settings.

```
Agent (Claude Code / Codex / OpenCode / …)
   │ any API
   ▼
magpie gateway ──► magpie-atomcode (adds atomcode-signing-v1 headers + UA)
   ▼
https://llm-api.atomgit.com/v1 (OpenAI-compatible, SSE streams back untouched)
```

## Features

- **Two sign-in methods**: browser OAuth via the AtomGit broker, or reuse of
  `~/.atomcode/auth.toml` from the official AtomCode CLI. CLI-backed accounts
  are re-read before use and renewed tokens are atomically written back with
  `0600` permissions.
- **Resilient renewal**: single-flight refresh plus an in-memory result cache
  prevents a rotated refresh token from being reused; a gateway 401 retries
  once with a fresh token, including on older hosts without `auth.refresh`.
- **Direct to AtomGit**: no Atom2Api instance needed; streaming, tool calls and
  reasoning-effort variants are declared to the host.
- **Daily check-in (`checkin`)**: scheduled by magpie's native check-in toggle. Plan valid → done; expired/missing → the official Max→Pro→Lite cascade re-claims it; quota exhausted → failed with the upstream reason.
- **Quota windows**: plan name, expiry, every upstream rate-limit window, and a
  token window only when upstream supplies token-specific fields without call
  counters (or explicitly declares token units), updating live.
- **Native controls**: `auto_claim` and `auto_version` appear as provider
  switches in Magpie and default on; the older camelCase options still override
  them for compatibility.
- **Restart-safe fallback**: the last successful model catalog and quota
  snapshot survive restarts. A transient refresh failure shows the stale quota
  with a clear marker instead of blanking the account row.
- **Auto version tracking**: follows the AtomCode repo's current version by default (the official client force-updates); falls back to the built-in anchor, never blocking a request.
- **Live model catalog**: each account pulls its own (varies by plan/tier), with a built-in snapshot as the offline fallback.
- **Offline diagnostics**: a loopback-only troubleshooting workspace at
  `http://127.0.0.1:3478/` summarizes local readiness, quota windows, model
  catalog, account and version state, then offers a network-free signature
  self-check and a human-readable redacted report. It opens inside Magpie's
  sandboxed plugin frame or directly in a browser.

## Current models (snapshot 2026-11-02)

| Model | Context | Reasoning efforts | Vision |
|---|---|---|---|
| `glm5.3-flash` | 512K | low / high | ✓ |
| `qwen3.8-27b` | 256K | low / medium / xhigh | ✓ |
| `deepseek-flash` | 1M | high / max | ✓ |

The catalog varies per account and plan — the live list wins after sign-in.

## Install

```bash
magpie plugin add @magpie-community/opencode-atomcode-auth
# Or load a checkout directly:
magpie plugin add /path/to/plugins/packages/atomcode
```

The package targets magpie `>=0.1.2629`. It exposes separate OpenCode 1.x and
2.x entry points, but real OpenCode host-contract verification remains
experimental.

## Sign in & check-in

```bash
magpie plugin login atomcode 1   # browser OAuth
magpie plugin login atomcode 2   # reuse the official AtomCode CLI login
```

- CLI reuse reads `~/.atomcode/auth.toml`, verifies that it is a private regular
  file, and refuses to follow symlinks or wide permissions. Renewals are written
  back atomically so the official CLI and magpie keep the same refresh chain.
- The second sign-in method asks for an optional `auth.toml` path. Leave it blank
  for the default, or enter an absolute path / `~/...`; relative paths and
  `~other-user` are rejected.
- The local CLI file is shared state. If its account changes, sign in again so
  magpie never signs requests with one account's `uid` and another account's
  access token.
- The official CLI serializes renewals with `auth-refresh.lock`. This plugin
  does not take that Rust `fs2` lock. If both renew at the same instant and the
  broker rotates the refresh token, the client that loses the race must sign in
  again.
- Check-in: the toggle in magpie's plugin settings ("has the ATOMCODE plugin sign in every signed-in account, daily"). Even when off, an expired plan is re-claimed automatically while reading quota/catalog (30-min cooldown).
- Plan quotas: Lite 1000/day; Pro trial 100/day released at 10:00. When the daily pool is out, the check-in fails with the upstream message — try again tomorrow.

## Options (`options` in `plugins.json`; all have defaults)

| Option | Default | Meaning |
|---|---|---|
| `locale` | auto | `zh` / `en` |
| `autoVersion` | `true` | legacy override for the native `auto_version` switch |
| `clientVersion` | `5.2.3` | fallback version anchor (used when `autoVersion` is off or the fetch fails) |
| `autoClaim` | `true` | legacy override for the native `auto_claim` switch |
| `masterKeyHex` | built-in | escape hatch when upstream rotates its signing key |
| `platformBaseURL` | `https://acs.atomgit.com` | OAuth broker |
| `codingPlanAPIURL` | `https://api.gitcode.com/api/v5` | CodingPlan REST |
| `quotaTtlMs` | `60000` | quota cache |
| `maxOutputTokens` | `32768` | default model output ceiling |
| `diagnosticsPort` | `3478` | loopback diagnostics port (must stay in `1024..65535`) |

`auto_claim` and `auto_version` are the preferred controls and default on. Set
them in the provider editor or with:

```bash
magpie plugin options atomcode '{"auto_claim":false}'
magpie plugin options atomcode '{"auto_version":false}'
```

The manifest defaults each AtomCode account to 8 simultaneous requests. This
helps when several agents, sessions or sub-tasks run in parallel; it does not
make a single streamed completion faster. A controlled live probe at 4, 8 and
12 simultaneous short requests returned HTTP 200 without 429 or 5xx responses,
so 8 is the conservative default and the provider editor can override it.

## Security boundaries

All of these are enforced in code, and `npm test` covers each one:

- **The gateway is the only destination.** `loader.fetch` freezes the validated
  URL before any asynchronous credential read, then compares its origin against
  `https://llm-api.atomgit.com`. A caller cannot mutate a `URL` object during the
  await and redirect signed traffic. Scheme and port are part of the comparison.
- **Upstream cannot move the destination.** A model row's `base_url` is honoured only when its origin exactly matches the signed gateway; otherwise that model falls back to the official gateway and the plugin logs that it did.
- **Endpoint options use exact hosts.** `platformBaseURL` may only be
  `acs.atomgit.com`; `codingPlanAPIURL` may only be `api.gitcode.com` (path
  overrides are allowed). Both must be HTTPS on port 443. Anything else falls
  back to the official endpoint with a redacted warning.
- **Bounded reads and redirects.** Version, OAuth and CodingPlan response bodies are capped at 1 MiB *while* streaming; every metadata call has a timeout and refuses redirects. A broker-supplied login URL must also stay on AtomGit.
- **Signable request bodies only.** Strings, byte buffers, typed arrays,
  `ArrayBuffer` and `Blob` are signed exactly as sent. Streams, `FormData` and
  `URLSearchParams` are rejected rather than signing bytes that differ from the
  wire representation. Buffered request bodies are capped at 64 MiB.
- **Final bytes are signed.** Streaming Chat Completions requests without an
  explicit `stream_options.include_usage` receive `include_usage: true`; the
  signature is computed after serialization.
- **Logs are redacted.** Upstream response bodies are not copied into errors,
  and invalid option values, bearer tokens, emails and long secrets are not
  logged.
- **Credential failures are separated from entitlement failures.** A 401 or an
  explicit credential/session 403 may trigger one refresh. Quota, plan,
  permission and other non-credential 403 responses keep the account signed in
  and return `x-magpie-sign-in: kept`.
- **Diagnostics stay local and read-only.** The service listens only on
  `127.0.0.1`, checks the request `Host`, requires a random per-process token for
  APIs, checks `Origin` on POST, and serves a restrictive CSP. The page never
  probes AtomGit or the LLM gateway.

Browser credentials live in magpie's own store. CLI credentials stay in
`~/.atomcode/auth.toml`; renewals are atomically replaced with `0600`
permissions while unrelated TOML content is preserved. Credentials are never
printed or logged and are only attached to the exact official hosts above.

Magpie also writes `<plugin data directory>/atomcode-state.json` for the
diagnostics view. It is schema-filtered and atomically written with `0600`
permissions. It may contain model names, quota windows, version provenance and
a redacted last error, but never tokens, a full user id, email addresses,
prompts or raw upstream responses.

### What runs by default

Both defaults are on out of the box, and both act without being asked:

| Default | What it actually does | Turn off with |
|---|---|---|
| `auto_claim: true` | Starts the CodingPlan `claim-v2` after sign-in and retries the idempotent claim when the plan has expired. After sign-in it runs in the background. | `magpie plugin options atomcode '{"auto_claim":false}'` |
| `auto_version: true` | Refreshes the version manifest from `raw.atomgit.com` in the background (12 h cache). Requests immediately use the current cached version, including the built-in fallback. | `magpie plugin options atomcode '{"auto_version":false}'` |

## Troubleshooting

For a 401 during sign-in or provider testing:

1. Run `magpie version` and note the failure stage: OAuth callback, model catalog, quota, or chat request.
2. Open the plugin's **AtomCode diagnostics** page. The status summary separates local readability from upstream availability; quota, model, account and version details follow, with the redacted last error, offline self-check and expandable runtime metadata below.
3. Try `atomcode login` with the official AtomCode client using the same account. If that also returns 401, the account is likely refused upstream rather than by this plugin.
4. Open a bug report with the redacted report from the diagnostics page. Never include access tokens, refresh tokens, OAuth state, `plugin-auth.json`, email addresses, account IDs, or unredacted home-directory paths.

Security issues should follow [SECURITY.md](SECURITY.md). Development and review expectations are in the [community plugin guide](https://github.com/magpie-community/plugins#write-your-own).

## Development

```bash
cd ../..
npm test                       # Node test suite from the workspace root
npm run test:bun               # Bun host/runtime suite
npm run test:coverage:enforce  # line/branch/function gates
npm run pack:check             # verify the published tarball contents
```

Live validation spends a small amount of quota and is disabled by default:

```bash
ATOMCODE_LIVE=1 npm run test:live
```

It is capped at nine requests, disables automatic claiming, never runs check-in,
and prints no tokens, prompts or model response text.

CI runs the suite on Node 20, 22 and 24 plus a pinned Bun, enforces coverage
thresholds, and installs the packed tarball into a clean project for an import
smoke test. Release publishing is prepared through npm trusted publishing with
provenance and is triggered only by a GitHub release.

Sandbox verification (never touches your real magpie):

```bash
SB=$(mktemp -d)
PLUGIN_ROOT="$(pwd)/packages/atomcode"
sb() { env HOME="$SB" USERPROFILE="$SB" XDG_CONFIG_HOME="$SB/.config" XDG_CACHE_HOME="$SB/.cache" \
  MAGPIE_ADDR=127.0.0.1:3499 MAGPIE_PLUGIN_MARKET=off magpie "$@"; }
sb plugin add "$PLUGIN_ROOT"
sb plugin list
sb plugin options atomcode
```

The same code loads as an OpenCode plugin (v1 shape); magpie-only hooks
(`auth.usage`, `auth.refresh`, `auth.checkin`) are ignored by OpenCode. OpenCode
support remains experimental because its OAuth type does not declare the `uid`
field required by AtomCode request signing. The diagnostics service and native
provider switches are Magpie-only.

## Disclaimer

Unofficial, not affiliated with or endorsed by AtomGit / AtomCode. Upstream protocols may change at any time; usage you choose may breach terms of service and risks account restriction or bans — Atom2Api carries the same warning. See [NOTICE.md](NOTICE.md) for attribution.
