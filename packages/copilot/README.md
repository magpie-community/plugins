# GitHub Copilot

An unofficial OpenCode provider plugin for GitHub Copilot on GitHub.com and
GitHub Enterprise (including GHE.com). In magpie it also shows the account's
premium request or credit quota: used, remaining, the included allowance and
when it resets. It does not change the subscription or enable paid overage.

The authentication and request implementation is adapted from
[`opencode-copilot-auth` 0.0.12](https://www.npmjs.com/package/opencode-copilot-auth)
([source](https://github.com/anomalyco/opencode-copilot-auth)), under its MIT
license, retained in `LICENSE`. It keeps the device flow, request signing,
initiator detection and vision headers, with client versions matching magpie's
native Copilot implementation. No runtime dependency on another installed plugin
or local file is needed.

## Install and sign in

```sh
magpie plugin add @magpie-community/opencode-copilot-auth
magpie plugin login github-copilot
```

Choose GitHub.com or GitHub Enterprise; for Enterprise enter your own GitHub
host, such as `company.ghe.com`. Complete GitHub's device authorization in
the browser. Host inputs must be HTTPS origins without credentials, paths,
query strings or custom ports. As in the upstream plugin, Enterprise API and
inference hosts are `api.<host>` and `copilot-api.<host>`; deployments with
different endpoint layouts are not covered.

For OpenCode, add `@magpie-community/opencode-copilot-auth` to `plugin` in
`opencode.json`, then run `opencode auth login`.

The provider id is `github-copilot` for both deployments. GitHub's OAuth token
is stored in the host's auth store as `refresh`; the short-lived Copilot token
is stored as `access` with `expires`. In magpie this is `plugin-auth.json`,
scoped by the host to the selected account, including additional `#slot`
accounts. Enterprise sign-ins keep `enterpriseUrl` through token renewal.
Models come from the host's existing `github-copilot` catalog.

If the original `opencode-copilot-auth` is already installed in magpie, keep
it and explicitly choose which plugin serves the existing provider:

```sh
magpie plugin use @magpie-community/opencode-copilot-auth github-copilot
```

The shared provider id lets the new plugin reuse the existing sign-in and
model picks; there is no automatic migration from magpie's separate built-in
`copilot` provider or from a legacy `github-copilot-enterprise` auth entry.

## Quota reporting

magpie calls `auth.usage(getAuth, provider)` independently of model requests.
It reads `GET /copilot_internal/user` on `api.github.com` or the account's
`api.<enterpriseUrl>` using the GitHub OAuth token, **not** the short-lived
inference token. Reading quota neither renews nor persists either token.
When the inference token exchange itself answers 401, the request fails
with `signIn: "expired"` and magpie asks for a new sign-in; any other
failure there leaves the account for the next request.
OpenCode ignores magpie's additional hook.

- Only `chat`, `completions` and `premium_interactions` snapshots are read;
  unknown quota types cannot block chat model routing.
- Snapshot counters accept numbers or numeric strings. Fractional
  `quota_remaining` takes precedence over the rounded legacy `remaining`;
  `remaining` is the fallback when the canonical field is absent. Used amount
  is entitlement minus remaining. Organization-pool `credits_used` has no
  per-seat denominator and is never divided by entitlement. Without remaining
  counters or a percentage, a finite seat's utilization is unknown.
- Snapshot amounts determine the percentage when known; otherwise
  `percent_remaining` gives a percentage without inventing an absolute balance.
- `quota_reset_at`, `quota_reset_date_utc` and `quota_reset_date` supply resets;
  date-only values mean UTC midnight. Legacy free-plan monthly counters are
  supported too.
- `has_quota: false` does not hide a usable or exhausted seat. A zero
  entitlement means no included allowance. An exhausted premium pool may say
  `unlimited: true, has_quota: false`; it is shown as 100% used, not unlimited.
- Unlimited chat and completion allowances are labelled `Unlimited`, not
  `0 / 0`. An unlimited premium credit pool with readable `credits_used` shows
  that usage as informational (`aside`), without inventing a seat limit or
  percentage. Completion quotas do not block chat model routing. For finite
  premium allowances, only unmanaged seats with vendor-permitted overage are
  informational (`aside`); Business and Enterprise exhaustion remains blocking,
  as in magpie's native Copilot implementation. The plugin never changes the
  overage permission or adds the separate overage counter to included usage.
- Empty, malformed or unavailable quota data is unknown, not zero usage.
  Only an explicit HTTP 401 marks the sign-in expired. Network errors, rate
  limits, 403s and server errors keep the sign-in. A read GitHub answers
  clears a mark, since the OAuth token it took is what renews the inference
  token (an idle account whose inference token lapsed, #618). No response body or token is
  included in error messages. Quota requests have a timeout and reject redirects.

GitHub's quota endpoint is internal and may change. An organization may not
expose all balances to a seat; missing data is not an estimate of its budget.

## Network and credential scope

The new network operation is a read of `GET /copilot_internal/user`. It sends
the account's GitHub OAuth token only to `https://api.github.com` or, for an
Enterprise sign-in, `https://api.<enterpriseUrl>`. Enter only the GitHub host
your organization trusts: HTTPS validation does not establish ownership of a
domain. The quota request rejects redirects, and sends no prompt, model
request, local file or inference token.

The inherited device flow posts the public OAuth client id and device code
to the selected GitHub host's `/login/device/code` and
`/login/oauth/access_token`. Inference token renewal sends the OAuth token to
`/copilot_internal/v2/token` on that account's API host. Model requests use
the Copilot inference token at `https://api.githubcopilot.com` or the
Enterprise `https://copilot-api.<enterpriseUrl>` origin. These operations are
separate from reading quota.

The plugin gets credentials from the host's `getAuth`; it does not scan
credential files, a keychain or agent configurations. Only the existing
inference token renewal calls `client.auth.set`. No dependency, install
script, telemetry, relay or account migration is added.

Request signing preserves host headers (including `Content-Type`, `Accept` and
`chat.headers`) supplied as a `Headers` object, plain object or tuples. It replaces
authorization and removes `x-api-key` case-insensitively. If the host stops
returning OAuth credentials, requests pass through without Copilot signing.

## Tests

```sh
(
  verification_home=$(mktemp -d) || exit
  trap 'rm -rf "$verification_home"' EXIT
  HOME="$verification_home" bun test packages/copilot
)
bun scripts/check.mjs copilot
```

Tests use synthetic accounts, mocked vendor responses and a loopback HTTP server:
public and Enterprise device flows, token refresh, outgoing request headers and
body, non-OAuth passthrough, fractional credits, legacy requests, unlimited
allowances, organization-pool credits, resets, unknown quota types and read failures.
They read no real auth files and consume no Copilot allowance.
The quota read test also uses an expired inference token and asserts the exact
single OAuth quota request, no auth persistence and unchanged input credentials.
Live inference and Enterprise access require separate verification against a
real account; these offline tests are not evidence of vendor acceptance.
