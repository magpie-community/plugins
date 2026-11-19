# @magpie-community/opencode-packycode-balance-auth

A Magpie usage-only provider for the **PackyAPI account balance**. It reads the
account-level balance from New API's `GET /api/user/self`, using the system
access token and user ID described in PackyAPI's
[CC-Switch usage-query guide](https://docs.packyapi.ai/docs/ccswitch/4-usage-query.html).
It does not use the model API key or the token-level `/api/usage/token` result.

**Provider id:** `packycode-balance`

## Add and sign in

```sh
magpie plugin add @magpie-community/opencode-packycode-balance-auth
magpie plugin login packycode-balance
```

Choose the PackyAPI console host, then enter:

1. **System access token** from Personal Settings → Security Settings. Magpie
   masks this password prompt.
2. **User ID** shown in PackyAPI personal settings. It must belong to that
   system access token.

The plugin checks the credentials with `GET /api/user/self` before saving them.
The current PackyAPI guide recommends `https://www.packyapi.ai`; the
`https://www.packyapi.com` console host is also offered for accounts that use
the URL supplied in older setup instructions. Requests are limited to those
two HTTPS hosts and do not follow redirects.

## What it displays

The plugin reads `data.quota` from the account response and divides it by
500,000 to display the account wallet in USD, following PackyAPI's New API
template. It does not use `data.used_quota` as a current-window limit because
that field is cumulative. A missing, malformed, or negative `quota` is shown as
an error; the plugin never takes its absolute value or substitutes a token
quota.

This is a separate, usage-only provider account in Magpie. Magpie does not let
one plugin attach its usage card to an existing custom PackyCode provider, so
this balance appears on the `packycode-balance` account card. It supplies no
models and does not send model requests.

## Credential handling

- Credentials are stored in Magpie's `plugin-auth.json`; the system access
  token is stored once as the account key, and the user ID and selected host
  are stored as account metadata.
- Every balance request sends the system access token and user ID only to the
  selected PackyAPI HTTPS host.
- The plugin sends no telemetry. It does not log credentials or include API
  response bodies in errors.
- Do not put real tokens, user IDs, or captured authenticated requests in this
  repository.

PackyAPI owns the returned quota and its unit conversion. The plugin cannot
verify an account's balance without the user's credentials; its tests use
inert fixtures and make no network requests.
