# Kimi Work

Use the ordinary **Kimi desktop Work subscription** as a provider in Magpie or OpenCode. This is separate from Kimi Code's subscription/API and from the Kimi agent package, which sends Kimi's inference in the opposite direction to Magpie.

```sh
magpie plugin add @magpie-community/opencode-kimi-work-auth
magpie plugin login kimi-work
```

Open Kimi desktop and sign in to Work on the same computer first. Choose **使用本机 Kimi Work 登录** in the provider's sign-in menu. There is no browser sign-in or API-key fallback in this package. It cannot sign in on a headless machine without an existing desktop session file.

## Models and requests

The account's models and reasoning options come from `https://agent-gw.kimi.com/coding/v1/models`. Chat completions, streaming, tool calls and cancellation use the same Work gateway. The request uses this plugin's own User-Agent; it does not impersonate Kimi's desktop client. It never uses `api.kimi.com` or a Kimi Code API key.

Version 0.1.4 preserves the calling agent's shared instructions, prompts, history and tools unchanged. Since 0.1.5 one exception: tool schemas Kimi's "moonshot flavored json schema" check refuses are rewritten to an equivalent it takes (#287). A `$ref` beside a `type`, as zod writes a schema derived from a reused one, gets its target written in; a `type` beside an `anyOf` is left out; an untyped `enum`, `const` or `$ref` target gets the type its values or keywords say. A request with none of these goes byte for byte. Instructions, MCP and skills are assigned to that agent in Magpie's Library; the provider does not create a second target or enable resources on its own. The ordinary Kimi agent's Library support starts at `@magpie-community/agent-kimi-desktop` 0.1.1.

An inference HTTP 401 marks the provider sign-in as expired (`kimi_work_login_expired`). Sign in to desktop Work if needed, then **reconnect Kimi Work in Magpie** (or run `magpie plugin login kimi-work`); signing in to the desktop alone does not reconnect the provider. Other HTTP errors, including 429 and 5xx, pass through unchanged with Kimi's status, headers, body and Retry-After. This preserves the distinction between concurrency limits and exhausted allowance, including any upstream reset details. Network failures use `kimi_work_connection_failed` and retain the underlying cause code or fetch error message for diagnosis. Rate limits and service failures do not invalidate the desktop sign-in. Cancellation stays cancellation. No automatic retry sends a conversation twice or falls back to Code.

Models use standard context, capped at 262,144 tokens, rather than silently enabling the higher-priced XL context. The fallback model is `kimi-work/k3-agent`; the signed-in account's live catalog replaces it.

Usage comes from Kimi's membership `GetSubscriptionStats` endpoint and is labelled **shared membership allowance**, not a separate free Work allowance. No reset time is reported: `subscriptionBalance.expireTime` and `upcomingExpiration.timestamp` are expiration fields, and have not been verified to describe allowance resets. An observed Windows request was classified by Kimi as `FEATURE_WORK` while the Code five-hour and weekly ratios stayed unchanged. This is an observation, not a promise about future quota accounting: Kimi controls billing, shared allowances, access and rate limits.

Every reasoning-effort value returned by `/models` is retained, including `STANDARD` if listed. The checked Windows catalog in `tests/fixtures/work-models.redacted.json` lists `LOW` (displayed by Kimi as **Standard**), `HIGH` and `MAX`; the plugin sends the advertised effort value instead of guessing from the display label.

## Sign-in and local files

The plugin reads only the desktop app's `daimon-share/daimon/config.json` under:

- Windows: `%APPDATA%/kimi-desktop/`
- macOS: `~/Library/Application Support/kimi-desktop/`
- Linux: `~/.config/kimi-desktop/`

The internal Work credential is named `credentials.kimiCode`, but its origin must be exactly `https://agent-gw.kimi.com/coding/v1`. `credentials.kimiWeb` supplies the membership sign-in. The plugin rejects missing credentials and other origins. It saves only a hashed account reference in Magpie/OpenCode's auth store; the actual tokens remain in Kimi's own file and are reread on each operation. It never reads Magpie's credential files, writes Kimi configuration, consumes refresh tokens, or stores copies of desktop credentials.

Kimi desktop remains responsible for refreshing its sign-in. If it expires, sign in there and reconnect this provider. Changing the desktop account requires reconnecting, so requests do not silently switch accounts. Each synced device must have its own Kimi desktop sign-in.

During connection, missing local credentials still ask for a desktop sign-in, and a Work `/models` HTTP 401 explicitly says that the login expired. HTTP 429/5xx and network/timeout failures instead report the actual HTTP status or network cause; they do not tell the user that local credentials are missing. A failed connection check saves no new account reference or tokens. Existing sign-ins, configuration and model IDs use the same format as 0.1.4.

## Origin and provider-id conflict

This submission packages the local desktop-sign-in implementation from [`kupakupar/kimi-work-provider`](https://github.com/kupakupar/kimi-work-provider), whose Git-installed package was version 0.1.2. The community package now starts at 0.1.3. The previously stated preservation of model IDs/account references referred only to that implementation: both use `source: "kimi-work-desktop"` and a hashed account reference.

The separate MIT-licensed [`kimi-work-opencode`](https://www.npmjs.com/package/kimi-work-opencode) by Jared Boynton also uses provider ID `kimi-work`. It is not the source or a dependency of this package, and no migration from its authentication format is implemented. **Do not enable both packages together:** they claim the same provider/auth hooks, so load order can replace model/configuration or sign-in handling. Back up your configuration, keep only the desired plugin enabled, and reconnect it using its own sign-in method. This package does not automatically delete or convert the other package's settings or login data.

## Compatibility and validation

These are undocumented desktop interfaces, not a supported public Kimi API. Windows and Apple-silicon macOS have been tested with real Work inference, including streaming. The [macOS record](COMPATIBILITY.md) includes the Kimi build, observed file/fields, real Magpie route and test limits. Linux and Intel macOS remain unverified. Changed desktop layouts stop with a sign-in error; changed upstream schemas stop model discovery or usage with an error. Inference failures are returned without retrying against Code or another service. Users remain responsible for their subscription's terms.

```sh
bun test packages/kimi-work
bun scripts/check.mjs kimi-work
```

Tests use synthetic sessions and fake HTTP responses: credential separation/rotation, read-only local import, account changes, endpoint restrictions, streaming/tool preservation, model discovery and shared-usage accounting. No account, token, prompt, conversation or vendor binary is distributed. No runtime dependencies.
