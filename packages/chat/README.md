# @magpie-community/page-chat

A chat page in [magpie](https://usemagpie.ai)'s window. Talk to magpie's own models with your MCP servers, instructions and skills, with images and LaTeX, without starting an agent.

Made by **Magic_zero** ([Magiczerowxy](https://github.com/Magiczerowxy)), from [Magiczerowxy/magpie-chat](https://github.com/Magiczerowxy/magpie-chat) (0.1.18). This package is that code, with the changes listed under [Changes from the original](#changes-from-the-original).

![Chat inside magpie's window](https://raw.githubusercontent.com/Magiczerowxy/magpie-chat/main/screenshots/23-math-and-layout.png)

## Install

From magpie's **Plugins › Discover**, or:

```sh
magpie plugin add @magpie-community/page-chat
```

It then has a tab, **Chat** (对话, 對話, チャット), under Plugins in the sidebar.

## What it does

- **magpie's models.** The list comes from the gateway's `/v1/models`. Models with reasoning levels get an effort picker.
- **magpie's library.** Tick instructions and skills from `~/.config/magpie/library/` (folded into the system prompt), and MCP servers from `library.json` (their tools run as real `tool_calls`, at most 8 rounds, Streamable HTTP and stdio).
- **Images and files.** Pick, drop or paste them. Images go to the model as `image_url`.
- **Streaming.** Reasoning unfolds while it arrives, then collapses.
- **Math.** `$…$`, `$$…$$`, `\(…\)` and `\[…\]` render with a bundled KaTeX 0.16.11. No CDN.
- **Conversations kept**, pinned or deleted, under `~/.config/magpie/magpie-chat/`.
- **Looks like magpie.** Colors and fonts come from the window's theme.

It registers no provider, asks for no sign-in and stores no credentials of its own. Every request goes out through magpie's gateway, so usage, routing and failover are the same as an agent's.

## How it works

A plugin page runs in a sandboxed frame with no network (`connect-src 'none'`). Its only way out is to navigate itself. So this plugin has two parts:

1. `page/index.html` and `page/boot.js`: a launcher magpie hosts. It reads the window's theme and the `port` option through `_magpie/bridge.js`, then sends its frame to `http://127.0.0.1:<port>/`. It makes no request of its own.
2. `index.mjs`: an OpenCode v1 plugin (`export default {id, server}`). When magpie's plugin host calls `server()`, it starts a local service on `127.0.0.1:3477` (the `port` option). `lib/server.mjs` serves the chat UI in `chat/` and `/api/*`, and forwards chat to magpie's gateway.

### What the service reads and sends

- From magpie's config folder (`$XDG_CONFIG_HOME/magpie` or `~/.config/magpie`): `caller-keys.json` (the first gateway key, sent as `Authorization: Bearer` to the gateway, so the chat's usage is counted on that key), `providers.json` and `routing.json` (icons), `settings.json` (fonts), `library.json` and `library/` (MCP servers, instructions, skills).
- To magpie's gateway: `MAGPIE_CHAT_GATEWAY` if set, else `MAGPIE_ADDR`, else `http://127.0.0.1:3425`. The key goes there, so set `MAGPIE_CHAT_GATEWAY` only to a gateway you trust.
- To your MCP servers: what the model asks their tools, with the headers you configured for them. A stdio server's command is run as you configured it.

### Who can use the service

Only the chat page it served:

- Every `/api/` route needs `x-magpie-chat-token`, a random token made each time the service starts. The service writes it into the chat page's HTML, which it sends without CORS headers, so another page can't read it. `/api/ping`, `/api/fonts.css` and `/api/icon/*` are open; they give nothing secret.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, so a DNS-rebound page is turned away.
- `Origin` must be `null` (the sandboxed frame) or the service's own.

## Options

```json
{ "port": 3477 }
```

The launcher and the service both read it. Change it if something else holds 3477.

## Starting it without magpie's host

`serve.mjs` (`node serve.mjs`, or `start-server.cmd` / `start-server.vbs` on Windows) starts the same service on its own, and `install-autostart.cmd` puts it in Windows' Startup folder. See [SERVE.md](SERVE.md). None of these runs unless you start it.

## Changes from the original

- The service answered `Origin: null` and requests with no Origin, and didn't check `Host`. Any website's sandboxed iframe sends `Origin: null`, so it could chat on your gateway key, read and change conversations and settings, and drive your MCP tools. A DNS-rebound page could read conversations. The token and the Host check above close it.
- The service started when `index.mjs` was imported, on 3477 whatever the `port` option said, while the launcher went to the option's port. It now starts when the host calls `server()`, on the option's port.
- A remote provider icon answered 302 with no `Location`. It has one.
- `/api/bootstrap` said version `0.1.0` whatever the version. It says the package's.

## Known limits

- The page opens the service on this computer's 127.0.0.1, so `magpie web` used from another machine won't reach it.
- MCP has no legacy GET SSE stream and no reconnect.
- Images go inline as base64, at most 24MB each.
- Built-in provider icons live inside magpie's binary; when one can't be read, the service draws a letter badge.

## Test

```sh
bun test packages/chat
```

The test starts the service on a free port against a fake gateway, in a temporary config folder.

## License

MIT, © 2026 Magiczerowxy. See [LICENSE](LICENSE).

---

中文：Magic_zero（[Magiczerowxy](https://github.com/Magiczerowxy)）做的「对话」页面，来自 [Magiczerowxy/magpie-chat](https://github.com/Magiczerowxy/magpie-chat)。装好后侧栏「插件」里点「对话」，就能用 magpie 自己的模型聊天，带上你的 MCP 服务器、指令和技能，支持图片与 LaTeX。它不注册供应商、不保存凭据，请求都经 magpie 网关发出，用的是 `caller-keys.json` 里第一把网关 key。本地服务只听 127.0.0.1，每个 `/api/` 请求都要带上服务写进对话页里的口令，并检查 `Host`，别的网页用不了它。
