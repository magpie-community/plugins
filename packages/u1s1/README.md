# @magpie-community/opencode-u1s1-auth

Sign in to your own **u1s1** account (device-code) and use u1s1's models from any agent behind Magpie, or from OpenCode.

u1s1 is an OpenAI-compatible chat service. The protocol here is implemented from the official **u1s1-cli 1.14.5** source (`dist/api.js`, `device-auth.js`, `login.js`, `site.js`), and verified against the live gateway.

## What it signs in to

Your own u1s1 account, at the u1s1 gateway:

| Endpoint | Usage |
|---|---|
| `POST {origin}/auth/device/start` / `poll` | Device-code sign-in (browser approval), the same flow as `u1s1 login` |
| `POST {base}/chat/completions` | OpenAI-compatible chat (Magpie's gateway converts to other protocols) |
| `GET {base}/models` | Live model catalog (context, max output, price, vision, reasoning) |
| `GET /me` | Account identity, shown after sign-in |

Sites: China `https://api.u1s1app.com/v1` (default), international `https://api.u1s1.dev/v1` (used when the China site is unreachable; the two accounts are separate).

## How the sign-in works

Device code: `authorize()` returns a URL; you open it in a browser, log in to u1s1, approve, and the terminal completes automatically. The device name shows as `<hostname> (magpie)` so you can tell devices apart in the dashboard's "My devices".

Each request is authenticated with a **DPoP signature** (a P-256 key pair generated on your machine) plus `x-u1s1-version` / `x-u1s1-client` / `x-u1s1-platform` / `x-u1s1-attestation` headers (attestation is fetched from `GET /models`, cached for its 7-day lifetime, refreshed when it expires). The `User-Agent: u1s1-cli` header is required — the server identifies an official client by it; a missing header is a `403 client integrity`.

## Where the sign-in is kept

In your own Magpie/OpenCode config only (`plugin-auth.json`). Each user signs in to their **own** account; keys and tokens never leave the machine seat, are not shared and not exported.

## Models

Before sign-in, a fallback list is offered (deepseek-flash, qwen3.8-flash, glm-5.3-flash). After sign-in, `GET /models` replaces it with the account's real catalog: `context_length`, `max_tokens`, `price {input, output, cache_read}`, `vision` and `reasoning` mapped through.

## Install

Magpie:

```sh
magpie plugin add @magpie-community/opencode-u1s1-auth
magpie plugin login u1s1
```

Or in the app, Plugins → Discover → u1s1, install, then sign in.

OpenCode, in `opencode.json`:

```json
{ "plugin": ["@magpie-community/opencode-u1s1-auth"] }
```

then `opencode auth login`.

## Uninstall

```sh
magpie plugin remove u1s1
```

## Troubleshooting

| Symptom | Meaning and fix |
|---|---|
| **401** / sign-in expired | Credentials invalid (device removed / key rotated) → `magpie plugin login u1s1` again |
| **403** / "client integrity review" | Usually a missing or overridden `User-Agent: u1s1-cli` (the server identifies the official client by it). Otherwise, account-level refusal; re-login doesn't help |
| Empty model list | Fallback list shows before sign-in; the live catalog replaces it after sign-in |
| China site unreachable | Switches to the international site automatically (separate accounts, sign in each separately) |

## Notes

- The two sites (`u1s1app.com` / `u1s1.dev`) are independent accounts.
- Usage draws from the signed-in account's balance; model prices and availability follow the u1s1 website "Models & Pricing" page.

## License

MIT. This is the **official u1s1 plugin**, published to the community registry by the u1s1 team. The repository is the community plugins repo; the standalone release is `u1s1-magpie` on npm.
