# Verboo Code for Magpie & OpenCode

[中文文档](README.zh-CN.md)

Unofficial provider plugin that connects a [Verboo Code](https://code.verboo.ai) subscription to [Magpie](https://usemagpie.ai) and OpenCode (1.x and 2.x). Uses browser PKCE OAuth sign-in (the same OAuth flow as the Verboo Code client), per-account dynamic model discovery, reasoning effort mapping, and subscription/Stamina usage reporting.

## Install & Usage

### From GitHub (Magpie)

```sh
magpie plugin add github:lizimu0/magpie-verboo
```

Or add the repository / local folder in Magpie under **Plugins → Add a plugin**.

### Sign in & Test

1. In Magpie **Providers → Verboo Code**, choose **Sign in with Verboo** (browser OAuth). You can also run:
   ```sh
   magpie plugin login verboo
   ```
2. Wait for your account's model catalog to load, then select a model in Magpie or run:
   ```sh
   magpie provider test verboo
   ```
   Models are addressed via the Magpie gateway as `verboo/<upstream-model-id>`.
3. Check subscription plan, renewal date, Stamina remaining, and trial token quota:
   ```sh
   magpie quota
   ```

## Authentication, Requests & Usage

- **Browser OAuth (PKCE) & rotating refresh tokens**: Replays the same OAuth 2.1 PKCE flow as the Verboo Code client—a temporary `127.0.0.1` loopback server receives the callback, exchanges the code at `https://code.verboo.ai/oauth/token`, and reads account identity (`email` + `uid`) from `/api/me` for multi-account separation and deduplication. A per-machine installation UUID is stored in `~/.magpie-verboo/installation-id` (`0600`). The plugin declares `rotating: true`, deduplicates concurrent refreshes, and recovers cleanly if another process rotates the single-use refresh token first.
- **Per-account live model catalog & reasoning efforts**: Discovers context windows, max output tokens, vision capability, and supported reasoning effort levels per account, mapping Verboo's `off` to Magpie's canonical `none`. Existing loaders pick up subsequent model list updates dynamically while keeping multiple accounts isolated. Explicit active efforts are sent in Verboo Code's thinking format (`thinking: { type: "enabled" }` + `reasoning_effort`), clamping unsupported levels to the nearest offered level; explicit `off`/`none` omits both `thinking` and `reasoning_effort` (matching Verboo Code), unspecified effort leaves the model's default behavior untouched, and non-reasoning models never receive thinking parameters.
- **Subscription & Stamina usage (`auth.usage`)**: Reads `/api/me`, `/api/me/subscriptions`, `/api/me/stamina`, and `/api/me/trial-status` (gracefully degrading on `404`). Stamina pacing windows are marked `aside: true` so speed throttling displays in Magpie without blocking gateway routing.
- **Strict origin & redirect guard**: Credentials are sent only to `https://code.verboo.ai` OAuth/account and subscription endpoints with `redirect: "error"`. Responses (JSON and SSE streams) pass straight back to Magpie.

> Signing out in Magpie removes local credentials only. Because Magpie does not notify plugins on sign-out, server-side refresh tokens expire naturally.

## Local Testing

Requires Node.js >= 20.3 or Bun (zero runtime or dev dependencies):

```sh
npm test
# or
bun test
```

## Links

- [Verboo Code](https://code.verboo.ai)
- [Verboo Code Desktop (upstream reference)](https://github.com/verbeux-ai/verboo-code-v2)
- [Magpie Plugin Documentation](https://usemagpie.ai/docs/plugins)
