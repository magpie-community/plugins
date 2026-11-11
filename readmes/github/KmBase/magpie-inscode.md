# magpie-inscode

Run **InsCode free quota** as a provider inside [magpie](https://usemagpie.ai) (and OpenCode).

Login is a **browser OAuth** at `https://taotoken.net/oauth?sid=<uuid>`: you
authorize there, the page binds the session, and the plugin picks it up from the
*complete* endpoint, then uses the returned `api_key`. Chat requests go to the
gateway `https://taotoken.net/api/v1` with the Bearer key **plus the `X-Tt`
client signature** (see below), so `inscode/deepseek-v4-flash` becomes a normal,
OpenAI-compatible provider you can pick from any agent.

> Built against the SDK-side logic of [`inscode2api`](https://github.com/HPPC114514/inscode2api),
> a zero-dependency local proxy that turns the same InsCode quota into an
> OpenAI API. This plugin does the equivalent work entirely inside magpie's
> plugin host — no proxy process needed.

## Install

Add it from the magpie UI (**Plugins → Add → folder path**) or on the CLI:

```bash
magpie plugin add ./magpie-inscode   # local folder, nothing is installed
```

Then sign in and test:

```bash
magpie plugin login inscode           # opens the browser OAuth sign-in
magpie plugin                         # inscode (InsCode, N models) signed in
magpie provider test inscode          # ✓ chat  …ms · deepseek-v4-flash
magpie quota                          # inscode · InsCode 免费套餐 · …
```

Your models are then available as `inscode/<model>` alongside every other
provider.

## How it logs in

The primary login is a **browser OAuth** keyed by a random session id: the plugin
opens `https://taotoken.net/oauth?sid=<uuid>`, you authorize there, and the page
binds that session to your account. That page then deep-links into the InsCode
desktop app (`inscode://auth/callback`), so a plugin cannot read the browser.
Instead the plugin polls the app-side endpoint
`POST https://api.taotoken.net/v1/codex/session/<sid>/complete?deviceId=<id>`
(unauthenticated, `X-Tt-Device-Id` header) until it reports `SUCCESS`, then stores
the returned `apiKey`. Claiming is idempotent, so the desktop app may claim the
same session too.

| Login | What happens |
|---|---|
| Browser OAuth (default) | open `…/oauth?sid=…`, poll `…/codex/session/<sid>/complete` for the `apiKey` |
| Local credentials (fallback) | read `~/.config/inscode/{taotoken,device,auth}.json` directly |

Everything stays on this machine — the values are only sent to the taotoken
gateway as the `Authorization` and `X-Tt-*` signature headers.

## How requests are signed

Chat POSTs carry the **`X-Tt` client signature** on top of the Bearer key — a
request with only `Authorization` gets `401 invalid_client_signature`. The
algorithm (per the InsCode client, verified against the live gateway; see
`sign.mjs`):

- HMAC key: the account's `sign_key` value, **base64-decoded** (32 raw bytes);
- canonical string: `POST\n{path}\n{ts_ms}\n{nonce_b64}\n{key_id}\n{sha256_hex(body)}`;
- `X-Tt-Sign` = HMAC-SHA256 hex, sent with `X-Tt-Keyid`, `X-Tt-Ts` (epoch ms),
  `X-Tt-Nonce`, `X-Tt-Sign-Version: v1` and `X-Tt-Device-Id`.

`GET` endpoints (e.g. `/v1/models`) are **pure Bearer** and are not signed.
`loader.baseURL` is `https://taotoken.net/api/v1` with
`@ai-sdk/openai-compatible`, so chat-completions requests land on
`https://taotoken.net/api/v1/chat/completions` — the host+path combination the
signature is verified against. Accounts signed in before this change start
signing automatically: the login snapshot's `signKey` (and the local
`taotoken.json` for fallback logins) is read per request, no re-login needed.

## Magpie-native hooks

- **`auth.usage`** (`quota.mjs`) — reports a single 5-hour window (the one that
  gates day-to-day usage) from the `codingPlan.buckets`, which it re-polls from
  the idempotent session-complete endpoint (the login `sid` is kept for this;
  throttled by `quotaTtlMs`) so the bucket shows up even when it only appears
  after login. Week/month buckets are dropped to keep the quota line short.
  When the bind response carries no buckets, it falls back to the InsCode
  client's local `taotoken.json` (also for browser-OAuth accounts), so the
  5-hour window shows up whenever a `used`/`limit` pair is on record. Falls
  back to a plan row with an empty window list otherwise. Shows up under
  **magpie quota** and the account row.
- **`auth.checkin`** (`checkin.mjs`) — daily free-quota claim. The taotoken
  check-in endpoint is **not verified**, so the hook only acts when you set
  `INCODE2API_CHECKIN_URL` (POST, Bearer auth). Without it, it reports
  `inactive` — no retries, no false claims.
- **`auth.refresh`** — not needed for the `api_key` (stored at login); quota
  buckets are refreshed inside `auth.usage` by re-polling the session-complete
  endpoint.

## Provider models

Per-account models are fetched from `GET /v1/models` (pure Bearer) inside the
account's scope and mapped onto the static list — a low-tier account only sees
the models it actually has.

## Files

```
index.mjs     plugin entry: config, auth (methods/loader/usage/checkin), provider
internal.mjs  PROVIDER id, DEFAULT_API_BASE, inlined icon, shared helpers
oauth.mjs     browser OAuth: sid, authorize URL, session-complete polling
sign.mjs      X-Tt client signature for chat POSTs
creds.mjs     load & parse the local InsCode credential files (fallback login)
models.mjs    model fallback, normalization, per-account catalog
quota.mjs     free-quota → auth.usage mapping
checkin.mjs   daily check-in hook (opt-in)
i18n.mjs      zh/en UI strings
assets/       provider icon (inlined at load)
test/         `node --test` unit tests (oauth / quota / sign / i18n / models / creds)
```

## Options

The plugin entry reads an optional `options` object
(`magpie plugin options <name> '{"locale":"zh", …}'`):

| Option | Default | Meaning |
|---|---|---|
| `locale` | `auto` | `"zh"`, `"en"`, or follow the machine. |
| `apiBase` | `https://taotoken.net/api/v1` | Override the taotoken gateway base. |
| `deviceId` | desktop app's `device_id` | Device id sent to the session-complete endpoint. |
| `modelsTtlMs` | `600000` | How long one account's model list is cached. |
| `maxOutputTokens` | `8192` | Default output window for models lacking one. |
| `quotaTtlMs` | `60000` | How long a `usage` result is cached per account. |

## Tests

```bash
node --test test/*.test.mjs     # 52 unit tests
npm test                        # same
```

## Security notes

- Credentials are used **only** in the plugin-host process to talk to
  taotoken.net; they are never logged or sent anywhere else.
- Prefer running magpie/agents on your own machine. Since the plugin reuses
  your InsCode login, do **not** expose this provider's requests over an
  untrusted network or to a multi-user gateway that could burn your quota.
- A rotated `sign_key` (has a `expire_at`) is re-read from the stored metadata
  per request; when it goes stale the gateway answers
  `401 invalid_client_signature` — re-login (or restart the InsCode client and
  re-add the local-credentials account) to pick up the fresh key.

## Limitations

- `auth.usage` and `auth.checkin` are best-effort until the taotoken
  quota/check-in endpoints are confirmed; chat and models are unaffected.
- Only the primary free account is wired; multi-account / `pros` plans are not
  exposed as separate accounts yet.

## License

MIT