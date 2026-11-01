# Doubao (豆包) — daily web check-in

Ported from **CreditDaddy** (`src/doubaoClient.js`). Claims doubao.com's daily
web experience-credit grant (+200/day) through the account's session cookie.
The campaign endpoint is idempotent (re-claiming returns `idempotent:true`).

## Sign in
Add the plugin, then **login** and paste your `doubao.com` session cookie.
The plugin derives a stable per-account device id (`web_id`/`tea_uuid`) from
your uid, matching Doubao's desktop-webview request shape.

## Notes (verify before publishing)
- Doubao's web credits are **not** an agent API. `provider.models` is
  informational; point an agent at **Volcengine Ark** (`api.volcengine.com`)
  for real Doubao/Seed model access.
- The `api`-type sign-in method stores the cookie in `auth.key`; the
  loader/checkin read it there. Confirm Magpie's custom-prompt storage
  against the running host.
