# @magpie-community/opencode-cline-auth

Cline (cline.bot) on your own Cline account: the models Cline's gateway
serves — usage-billed models, ClinePass's and Cline's free models alike.
Provider id: `cline`.

## Signing in

- **Cline device sign-in** — the flow Cline's own client runs: the plugin asks
  WorkOS for a device code and opens the approval page, polls until you
  approve, then trades the WorkOS tokens at Cline's `/api/v1/auth/register`
  for the account's own token pair.
- **Cline API key** — create one at [app.cline.bot → Settings → API Keys](https://app.cline.bot/dashboard/account)
  and paste it. Sent as a plain Bearer key.

The sign-in is kept where OpenCode keeps auth (`auth.json` under the data
directory); magpie keeps plugin sign-ins in its own store
(`~/.config/magpie/plugin-auth.json`). Access tokens are renewed through
`/api/v1/auth/refresh` when they near expiry — Cline rotates the refresh
token, and the rotated pair is saved back the moment it arrives (and kept in
memory beside the store, so a save that fails can't leave the next request
spending the token that was already spent). Refreshes are serialized, so two
requests renewing at once can't spend one token and lose the other. A refresh
that fails for a while keeps the token that is still good, as Cline's own
client does; only a token that has actually expired is treated as the sign-in
gone.

## Requests

Chat completions go to `https://api.cline.bot/api/v1/chat/completions` in
OpenAI's format (streaming included), with `Authorization: Bearer
workos:<access token>` for a signed-in account or the raw API key, and the
full client-identity header set Cline's own clients send (`HTTP-Referer`,
`X-Title`, `User-Agent: Cline/<version>`, `X-CLIENT-TYPE: cline-cli`,
`X-CLIENT-VERSION`, `X-PLATFORM`, `X-PLATFORM-VERSION`, `X-CORE-VERSION`,
`X-IS-MULTIROOT`, and a per-task `X-Task-ID`) — pinned to Cline's current CLI
release, which is also what the free models' gate reads; when Cline ships a
new release, move the pinned numbers in `index.mjs` along. Auth and account
requests carry the same identity. A finished non-streaming answer rides in a
`{"data": …}` envelope the official clients take apart; the plugin takes it
apart too. The model list is read from
`/api/v1/ai/cline/recommended-models` and `/api/v1/ai/cline/models` (neither
needs a sign-in); usage reads `/api/v1/users/me` and the account's `/balance`
(its balance is counted in millionths of a dollar).

## Models

The list is Cline's own, merged from the two feeds its clients read: the
recommended-models feed (its recommended picks, its free models and
ClinePass's) and the whole cloud catalog (`/ai/cline/models`, where the
usage-billed models the recommended feed doesn't name live). Refreshed from
the live feeds whenever they answer; until then a bundled snapshot of the
recommended list, Cline's own default (`anthropic/claude-sonnet-5`) among it.
Cline's `clineCloud` group is left out, as Cline's own clients leave it out
unless they opt in.

- The **free** group (`cline-free/…`, `stealth/…`) costs nothing — the names
  say "(free)". They are gated on the client surface a request claims; the
  plugin claims what it is, and the gate takes it. If Cline ever narrows that
  gate to its own apps, those models go away.
- The **ClinePass** group (`cline-pass/…`) needs a ClinePass subscription —
  the names say so, and asking without one answers 403.
- The rest are usage-billed against the account's Credits balance.

## Not included

- Cline's MCP and web-search endpoints — a chat provider only.
- Team/organization account switching.
