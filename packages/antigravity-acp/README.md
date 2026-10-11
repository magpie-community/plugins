# opencode-antigravity-acp-auth

English | [简体中文](README.zh-CN.md)

A magpie (OpenCode) provider plugin for **Google Antigravity through its official ACP server** — the agent runtime the Antigravity IDE speaks (`agy_acp_server.par`, served by dl.google.com), driven over Agent Client Protocol v1.

Adapted from [`pi-antigravity-acp-provider`](https://github.com/zacbemis/pi-antigravity-acp-provider) (MIT): the pinned runtime manifest, the runtime discovery order and install/validation flow, the model-family folding algorithm, the headless OAuth relay, and parts of the ACP session lifecycle are derived from it, reshaped for magpie's plugin contract. Its license notice is carried in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

> **Requires the Antigravity IDE, installed and signed in with your Google account.** The ACP server rides the IDE's Google sign-in — that is the supported path, and the one verified against the current server (1.2.1). The plugin downloads Google's official `agy_acp_server.par` itself; the IDE is not driven by the plugin, it is where the credential lives.

## Requirements

- **Antigravity IDE, installed and signed in.** See the note above. Sign in to the plugin with *Sign in with Google* (or *Use Antigravity's current Google sign-in*); on a machine where the IDE is signed in, the server answers at once.
- **Bun** — magpie runs plugins on it and installs it for you.
- **`unzip`** (Linux only) for the one-time runtime extraction.
- First sign-in downloads the official ACP server (~112 MB archive, ~400 MB on disk, macOS arm64) to `~/.local/opt/agy-acp/`.

## How it works

- **Sign-in**: the ACP server owns the Google sign-in and decides alone where it keeps it (an install with the IDE signed in usually carries no token file at all); the plugin stores a marker, never a token, and reads the sign-in's health from the server's own answers — a session can be made signed-out, but only a credential gets a prompt through. One Google sign-in is shared by every account of this provider on a machine. Three ways to sign in:
  - *Sign in with Google* — the server authenticates against the credential the signed-in IDE provides, and answers at once; without one it drives the browser itself. On SSH or a headless Linux the OAuth URL is captured and shown instead; paste the final localhost URL back.
  - *Use Antigravity's current Google sign-in* — a sign-in the Antigravity IDE already made on this machine.
  - *Gemini API key* — authenticated to the server with `_meta.api-key`.
- **Runtime**: found first to last at `AGY_ACP_BIN`, `~/.local/opt/agy-acp/current`, `~/.local/bin/agy_acp_server.par`, `PATH`. When none is there, the release pinned in `runtime-manifest.json` (SHA-256 and exact sizes checked, the extracted server validated over ACP before use) is downloaded to `~/.local/opt/agy-acp/versions/` and linked as `current`. Linux extraction needs `unzip` on the machine.
- **Requests**: each request arrives as the model's OpenAI Chat body (the models are on `@ai-sdk/openai-compatible`). The plugin turns it into one ACP session: the history rides as an embedded markdown context, the latest user text and images ride as prompt blocks, and the reply streams back as OpenAI chunks — `agent_message_chunk` as content, `agent_thought_chunk` as `reasoning_content`, the prompt's usage and quota as the final chunk.
- **Models**: the server's effort-qualified ids are folded into one entry per family (`gemini-3.8-flash-low/-medium/-high` becomes `gemini-3.8-flash` with low/medium/high variants); the request's `reasoning_effort` picks the variant's exact id on the session.
- **Tools**: the request's tools are served to the agent as an MCP bridge on loopback. A call there becomes the reply's `tool_calls` and ends the turn, the way a chat client expects. Antigravity's own tools are turned down (`session/request_permission` is answered *cancelled*), so nothing runs on this machine but what the client's agent asked for.
- **Usage**: the quota the last prompt's answer carried (`_meta.quota`) shows on the account's Usage card.

## Limits

- One Google sign-in per machine, shared by all accounts of this provider; "another account" means signing the machine in as someone else.
- Antigravity's own file and shell tools never run; a model that insists on them will say it couldn't. The client agent's tools are the ones served.
- Sessions are not warmed across requests: each request carries its conversation as context, as a stateless model API would.

## Ban risk, and magpie's built-in Antigravity

What gets accounts suspended is Google seeing the account used outside Antigravity. magpie's built-in `antigravity` provider says so itself ("use one you can afford to lose"): it connects to Google's Code Assist API with its own code, wearing a spoofed `antigravity/hub/<version>` user agent.

This plugin is one notch safer on that axis — every byte to Google comes from Google's own server binary, through the server's own authentication, into the same conversation store the IDE uses. **It is not zero**: the server still sees an outside agent's system prompts and tool schemas, a scripted calling rhythm, and a client whose name is not the IDE, and Google can add server-side checks at any time. Both providers can coexist; keep the accounts separate, and use an account you can afford to lose.

| | built-in `antigravity` | this plugin `antigravity-acp` |
| --- | --- | --- |
| talks to Google as | magpie's own code, spoofed IDE headers | the official ACP server binary |
| authentication | the account's OAuth token, refreshed by magpie | the server's own flow, riding the IDE's Google sign-in |
| accounts | a pool, per-account model catalogs merged | one Google sign-in per machine, shared |
| models | account-pool merge, magpie's own family folding | the server's live rollout catalog, folded in the plugin |
| usage | quota endpoints, tier cards | the quota each prompt answer carries |
| tool calls | served to the model API | the client's tools over a loopback MCP bridge; Antigravity's own tools are turned down |
| third-party account import | yes (Antigravity Manager, CLIProxyAPI) | no — the sign-in belongs to the server |
| extra deps | none | the downloaded official runtime (~400 MB) + one child process |

## Environment

- `AGY_ACP_BIN` — an `agy_acp_server.par` of your own, preferred over everything.
- `AGY_ACP_HOME` — moves `~/.gemini` and `~/.local` (sandboxes, tests).
- `AGY_ACP_AUTH_DIR`, `AGY_ACP_RUNTIME_ROOT` — move the sign-in and the managed runtime separately.
- `AGY_ACP_OAUTH_MODE` — `manual` (relay, paste the URL back) or `browser` (let the server open one).

## Test

```sh
node test/smoke.mjs   # the whole plugin against a fake ACP server; no download, no Google
```

## License

MIT — see [LICENSE](../../LICENSE) at the repository root. Adapted from `pi-antigravity-acp-provider` (MIT); its notice is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
