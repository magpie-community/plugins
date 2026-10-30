# Nowledge Mem plugin for Magpie

[Nowledge Mem](https://mem.nowledge.co) is a local-first memory layer for
people and AI tools. Magpie is the gateway in front of every harness, so this
plugin puts Mem *in the gateway*: every request Magpie routes gets the Memory
that fits it, and completed conversations can flow back into Mem. No harness
needs its own Nowledge Mem plugin, skill or MCP configuration for that.

Agent-callable Memory tools are a separate surface and stay where Magpie
already provides them: the plugin installs Mem's own MCP server and a short
skill into Magpie's [Library](https://usemagpie.ai/docs/mcp-hub), given to no
agent; choose the agents there. This keeps one tool surface, Mem's own.

```mermaid
sequenceDiagram
    participant Harness as Any harness
    participant Magpie
    participant Plugin as Nowledge Mem hook
    participant Mem as Nowledge Mem
    participant Model
    Harness->>Magpie: Request
    Magpie->>Plugin: onRequest with host-derived origin and agent
    opt Recall origin allowed
        Plugin->>Mem: POST /memories/search (latest user turn)
        Plugin->>Mem: GET /context/bundle (first turn of a session)
        alt bundle is empty, missing or failing
            Plugin->>Mem: GET /agent/working-memory
        end
        Mem-->>Plugin: Memory and session context
        Plugin-->>Magpie: Context-enriched request
    end
    Magpie->>Model: One inference request
    Model-->>Harness: Live response through Magpie
    Magpie--)Plugin: Completed response notification
    opt Capture enabled and origin allowed
        Plugin-)Mem: POST /threads/import (completed conversation)
        Mem->>Mem: Background distillation into Memory
    end
```

Requires **Magpie 0.1.1273 or newer** and Bun. The package declares
`magpie.hooks: "./nowledge-mem.hooks.mjs"`, Magpie's asynchronous Bun hook
entry; it is not gateway middleware and has no OpenCode provider. Use **Magpie
0.1.1531 or newer** for options saved from the plugin page to reach the hook on
the next request; earlier hook-capable versions need a restart after saving.

## Connecting

Mem runs on this machine at `http://127.0.0.1:14242` by default; an Access
Anywhere, Nowledge Cloud or self-hosted endpoint works the same way over HTTPS.
Configure it in the plugin page, or with the CLI:

```sh
magpie plugin add @magpie-community/gateway-nowledge-mem
magpie plugin options @magpie-community/gateway-nowledge-mem '{"serverUrl":"http://127.0.0.1:14242"}'
```

The hook reads its endpoint and key from the option first, then from the
environment Magpie starts with, as Mem's own clients do:

| Option | Environment | Meaning |
|---|---|---|
| `serverUrl` | `NMEM_API_URL` | Mem base URL; the local default when neither is set |
| `apiKey` | `NMEM_API_KEY` | Sent as `Authorization: Bearer …`; no key for an unauthenticated local Mem |

A key saved in the page is kept in Magpie's local plugin configuration, not the
system keychain, and takes precedence over the environment. Enter it directly;
the form also accepts an existing `Bearer …` value. The page's **Configure
connection** form also sets the Space, Agent and the recall, Context Bundle,
capture switches; Magpie's plugin **Options** editor remains available for
advanced settings. Saving conversations remains a separate opt-in.

`serverUrl` must be HTTPS, or HTTP only for `localhost`, `127.0.0.1` and
`[::1]`. Credentials, a query or a fragment in the URL are refused. Set
`allowInsecureHttp` only for a trusted LAN server.

## One gateway, several harnesses

Magpie knows which agent sent a request. Unless `hostAgentId` is set, the hook
uses `magpie:<agent>` as the host identity and sends it with the Context Bundle
request. Mem derives an AI identity per harness from it, so a Claude Code
session, a Codex session and a chat UI behind the same Magpie keep distinct
provenance without sharing one anonymous identity. The same value and the raw
agent name are recorded on imported Threads.

Each harness also gets its own recall cache: the same prompt from two harnesses
does not reuse the other's block. An explicit `hostAgentId` overrides the
derived value for all of them.

## Options

- `serverUrl`: Mem base URL. If unset, `NMEM_API_URL`, then
  `http://127.0.0.1:14242`.
- `apiKey`: Bearer API key. If unset, the variable named in `apiKeyEnv`.
- `apiKeyEnv`: environment fallback name, default `NMEM_API_KEY`; only an `NMEM_*` name is accepted. The environment key goes to the endpoint the hook resolves: page `serverUrl` first, then `NMEM_API_URL`. Keep the two paired; a page URL with an unrelated `NMEM_*` key sends that key there.
- `spaceId`: Mem Space for recall, context and imports. Empty means the default
  Space.
- `agentId`: optional portable Mem agent profile. It selects a profile for the
  Context Bundle and is recorded on imported Threads; it is not authentication.
- `hostAgentId`: optional fixed host identity. Empty derives
  `magpie:<agent>`, or `magpie` when Magpie reports no agent.
- `recall`: default **true**. Whether a turn gets Mem context. Recall only
  happens when a Mem endpoint is reachable; failures leave the request as it
  came.
- `contextBundle`: default **true**. On a session's first turn, ask Mem for its
  Context Bundle (owner profile, rules and Working Memory) and add its rendered
  markdown. When the bundle is empty, missing or failing, the hook falls back
  to today's Working Memory. A bundle outage never disables Memory recall.
- `maxMemories`: how many search hits to consider, default 5, range 1–20.
- `maxBytes`: recall budget for the block's content, default 6000, range
  512–32768. On the first turn the session context takes up to 45% of it, and
  the rest stays available for Memory.
- `requestTimeoutMs`: deadline for each search, bundle or Working Memory
  request, default 900, range 50–5000. It fits inside Magpie's default 1000 ms
  hook deadline. The host's hook deadline can end it
  earlier. Thread imports keep a separate ten-second deadline because a
  completed reply's notification is not bound to the live request.
- `gatewayTimeoutMs` (Magpie's own option, not this package's): the whole hook
  chain's deadline, default 1000 ms, range 100–10000. A local Mem fits the
  default; over the network, set it to 5000–10000 so the first turn's Context
  Bundle and search can finish.
- `recallBackoffMs`: after a connection failure, timeout or unavailable
  response, skip Mem for this endpoint/credential/Space for this long, default
  30000, range 100–300000. A failing optional bundle backs off only itself; the
  Working Memory fallback keeps being tried. Client cancellation does not
  trigger backoff.
- `capture`: default **false**. Import completed conversations as Mem Threads.
  Set `"capture": true` explicitly to opt in.
- `captureTools`: default **true**. Include client tool results as `tool`
  messages. Turn it off to import only what the user and the assistant wrote.
- `allowInsecureHttp`: default **false**. Permits plain HTTP to a server that
  is not a loopback address. Prefer HTTPS.
- `gatewayKeys`: default **false**. Include requests Magpie marks
  `gateway-key`: every request carrying a gateway key, including keys given to
  other people (shared, LAN, Tailscale). On, those requests receive the
  recalled Memory and Context Bundle; with `capture` on, their conversations
  are saved to your Mem. Off, recall and saving serve only direct local
  requests without a key. `remote` and unknown origins are never included,
  even with this on.
- `installLibrary`: default **true**. Install the `Nowledge Mem` MCP entry and
  the `nowledge-mem` skill into Magpie's Library, given to no agent. Set it to
  false to stop the installer from re-adding them.
- `port`: the loopback port of the page's connection test, default 3479. Change
  it only when another program holds that port; the page reads the same value.

## What recall adds

The latest user turn (Magpie's `ctx.query`, not client environment notices,
bounded to 2000 characters) is sent to `POST /memories/search`. On a session's
first turn the Context Bundle comes with it, or Working Memory when the bundle
is unavailable. The answer is wrapped in a `<nowledge-mem-reference>` block and
appended to that turn:

```
## Context bundle
<Mem's rendered Context Bundle>

## Recalled memories
### <title>
<Memory text>
nowledgemem://memory/<id> · relevance 0.94
```

When the bundle falls back, the heading is `## Working Memory` instead. Each
Memory keeps its title and up to 1000 characters of text, and the whole section
stays within `maxBytes`.

The block says the text is untrusted historical evidence, not instructions.
Recalled text cannot close the block it is in. A turn keeps the block it was
given for the rest of the conversation, so the request prefix stays stable for
the provider's prompt cache; a tool loop or a retry reuses it without asking
Mem again. A turn that already carries this plugin's block, or Mem context
injected by another connector (such as the DeepSeek Harness bundle), is left
alone rather than given a second copy.

Nothing recalled means the request is returned unchanged. Timeouts, an
unreachable server, an unknown Space and an unauthorized key all keep inference
available; the Plugins page shows a fixed outcome code and byte count, never
recalled text or a token.

## What capture imports

With capture on, a completed reply is turned into the conversation the client
sent plus the assistant's reply, and imported with `POST /threads/import`:

- `thread_id`: `magpie-<session>-<digest>`, or a digest of the opening turn for
  a client with no session. It stays the same across turns, so Mem appends
  missing messages instead of creating a Thread per turn.
- `title`: the first line of the message Magpie read as the user's query.
  A Thread keeps the title it opened with, so a client's environment notice
  before the real prompt does not become it.
- `source`: `magpie`; `tool_version`: `magpie-nowledge-mem/<version>`.
- `metadata`: `source_app`, protocol, the harness (`agent`), the host identity,
  an optional agent id, and SHA-256 digests of the session and working
  directory — not their raw values.

Messages are text only. Assistant tool-call steps with no text are not
messages; client tool results are included while `captureTools` is on. The
recalled `<nowledge-mem-reference>` blocks are stripped before import, so
Memory is never learned as a new conversation. A conversation with a
credential-like assignment, URL password, bearer token or common key format in
its text or tool arguments is not captured at all — a best-effort safeguard,
not a guarantee. Each Thread import is one bounded request; conversations over
512 KiB are skipped, and an identical replay of the last successful import is
not sent twice. A failed import fails open and is not retried blindly.

`capture` is the only switch that exports conversation content. Recall works
without it.

## Library: MCP server and skill

Harness plugins bundle tool sets and skills because each one owns a harness.
This gateway plugin installs them into Magpie's Library instead, because Magpie
already has the place where an MCP server and a skill are chosen per agent.

When the plugin host starts, it adds two Library items, given to no agent:

- **MCP server** `Nowledge Mem` at `<serverUrl>/mcp`, carrying the connection's
  key. Its tools are Nowledge Mem's official ones, not a second tool surface.
- **Skill** `nowledge-mem`, a short guide to using those tools.

Nothing is injected until you choose agents. Open Library › MCP and Library ›
Skills, tick the agents that should receive Mem, and Magpie writes the server
and skill into them. With the [MCP hub](https://usemagpie.ai/docs/mcp-hub) on,
each agent still gets a single `magpie` entry.

The installer merges into the same `library.json` the Library page reads. Other
entries and the agents already chosen are kept; a second start updates the URL
and key instead of duplicating. A skill folder that already has edits is left
as it is. If you remove an item, the next plugin host start adds it again;
`installLibrary: false` stops that. Changing the page's URL or key and saving
reloads the host and updates the MCP entry; to apply it to agents that already
received the server, re-open Library › MCP or run `magpie library sync`.

The address itself lives in Library › MCP. The package ships no Magpie tool hook, no slash commands and no system-prompt edit;
the skill is the only prompt-shaped content, and it is off until you give it to
an agent. If you want a custom system prompt for Memory, Magpie's
[system-prompt](../system-prompt) middleware does that on its own.

## Validation

```sh
bun test packages/nowledge-mem                  # offline tests
NMEM_E2E=1 bun test packages/nowledge-mem       # also the live checks, when .env is set
bun packages/nowledge-mem/e2e.run.mjs           # the live checks alone
```

The hook tests fake Mem with `fetch`: no server, no sign-in and no network. The
end-to-end checks talk to a real Mem and are skipped unless `NMEM_E2E=1`; they
read the repository's `.env` (the file wins over an ambient `NMEM_API_URL` or
`NMEM_API_KEY`):

```sh
set -a; . ./.env; set +a
bun packages/nowledge-mem/e2e.run.mjs
```

The checks create a few Memories and Threads per run and delete them afterwards.
They verify that `.env` reaches Mem, that recall returns a seeded Memory and
cites its id, that the Context Bundle arrives on a session's first turn, that
capture creates one Thread and appends only the new messages idempotently, that
the Thread records the harness and host identity, and that a wrong key and an
unknown Space report fixed codes. `e2e.test.mjs` runs them in a process of its
own: the offline tests replace `globalThis.fetch` to keep Cursor's token local
(`packages/cursor/nonet.mjs`), and a live check must not share that process.

## Page

The page uses only Magpie's released `magpie.options` and theme bridge. It
declares no reads and saving stores configuration without probing the
connection or writing Memory. It shows the Server, API key, Space, Agent, the
recall, Context Bundle, capture and keyed-agent access switches, and the MCP
server and skill it installs. It follows Magpie's language (English, Simplified and
Traditional Chinese, Japanese, German) and theme, and preserves options it does
not show.

**Test connection** is a real check, not a saved flag. Magpie's page sandbox
has `connect-src 'none'`, so the page cannot call Mem itself; the package's
small host part serves a loopback page on `127.0.0.1:<port>` and the frame
navigates to it. The **Test connection** button tests the saved options, so
save changes first. The page passes only the way back and the language in
`window.name`; the test page asks for a click, then the service reads the saved
plugin options itself and makes one public health request and one authenticated
Working Memory request. No URL, key or Space travels through the page. It
writes nothing and shows reachability, the key and the Space with a fixed code
and milliseconds. **Back to settings** returns to the page; the test saves
nothing and changes no form values.

The helper binds `127.0.0.1`, answers only when `Host` is `127.0.0.1:<port>` or
`localhost:<port>`, and needs the page's per-process token. Its JSON endpoint
accepts `Origin: null` from the sandboxed page and nothing else, and returns no
`access-control-allow-origin: *`; `POST` and the page's `fetch` are therefore
closed to other sites. The back link is accepted only for a loopback
`/_magpie/plugin/` page. Because the `Host` must be loopback, the test works in
the desktop app, not through a remote `magpie web` proxy.

The test needs the plugin host, which the gateway hook already starts; a
page-only install of an older Magpie version shows the test page failing to
connect rather than a wrong result.
