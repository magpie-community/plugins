# magpie-dumate-proxy

Provider plugin for [magpie](https://usemagpie.ai) and OpenCode that exposes a local
DuMate reverse proxy as an OpenAI-compatible provider. Provider id: `dumate`.

## What it does

- Live model discovery from the active DuMate desktop account through the proxy.
- Registers chat models with `modalities.output: ["text"]`.
- Registers `dumate-image0.1` with `modalities.output: ["image"]`, so magpie treats it as an image model.
- Keeps the sign-in alive through `auth.refresh`, `refreshLead: 10min` and `auth.keepAlive: true`.
- Shows a usable DuMate sign-in method in magpie; it checks `/healthz` and refuses to save an account while proxy login is missing.
- Allows plugin fetch for `/models`, `/chat/completions`, `/images/generations` and `/images/edits`.

## Sign-in methods

Three methods follow the DuMate desktop/web login model: read-only desktop `auth.json`, browser sign-in with a DevTools Network Cookie, and manual Cookie paste. Browser/manual cookies are validated directly against Baidu console before the Magpie account is saved.

Requests go directly to the official DuMate gateway with a short-lived gateway token; no local proxy URL is required.
## Setup

Run the proxy from <https://github.com/EFate/dumate-proxy>, then add this plugin:

```sh
magpie plugin add @magpie-community/magpie-dumate-proxy
```

Sign in with **DuMate local reverse proxy**. The plugin verifies `/healthz`; the proxy
owns the DuMate desktop session and gateway token renewal.

## Environment

- `DUMATE_PROXY_URL` — proxy base URL, default `http://127.0.0.1:8787/v1`
- `DUMATE_PROXY_API_KEY` — optional proxy API key
- `DUMATE_USER_DATA_DIR`, `DUMATE_OPENCODE_CONFIG` — optional model-catalog overrides

Unofficial; requires a local DuMate desktop session with personal points.
