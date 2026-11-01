# MiraSim — token auth + rolling-window quota

Ported from **CreditDaddy** (`src/mirasimClient.js`). MiraSim (`mirasim.ai`)
access-token auth with profile lookup and the 5h/7d rolling-window quota,
plus refresh-token renewal. The rolling windows show as Magpie usage.

## Sign in
Add the plugin, then **login** and paste your MiraSim access token (and
optionally the refresh token for auto-renewal).

## Notes (verify before publishing)
- The `api`-type sign-in stores the access token in `auth.key` and the
  refresh token in `auth.refresh`; confirm Magpie's multi-prompt storage
  against the running host.
- The chat endpoint `baseURL` is set to the relay host; confirm the exact
  path (`/v1/messages` vs `/v1/chat/completions`) before publishing.
