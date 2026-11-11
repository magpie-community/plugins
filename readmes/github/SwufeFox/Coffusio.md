# Coffusio

Coffusio is a provider-neutral Magpie Gateway middleware that adds small,
composable user-level instruction packs to recognized model request bodies. It
does not add a provider, change model identity, grant server permissions, or
enforce behavior outside the prompt. The host's system/developer instructions
and policies remain authoritative.

The Magpie middleware is the prompt/routing half. Coffusio also packages an
optional ColdCoffee-derived stdio MCP toolbox in `src/toolbox/`; it is a
separate process and must be connected separately in Magpie before any of its
tools are available. See [the porting status and feature gaps](docs/PORTING_STATUS.md) for the feature-by-feature comparison.

## Install in Magpie

From `/data` (or any directory containing the `coffusio` folder):

```sh
magpie plugin add ./coffusio
magpie plugin list
magpie plugin options /data/coffusio
```

`package.json` registers `./src/middleware.js` through Magpie's
`magpie.middleware` field. The middleware uses only relative imports bundled
by Magpie and the synchronous `onRequest(body, ctx)` hook; it has no Node/Bun
filesystem, network, or process access. It is ordinary JavaScript because the
Gateway executes middleware with Magpie's `moejs` runtime, not Node.

Example options (Magpie hands this JSON to `ctx.options`):

```sh
magpie plugin options /data/coffusio '{"enabled":true,"profile":"builder","modelProfiles":{},"modelSeats":{},"channel":"auto","workMode":"auto","activationMode":"always","activationHistoryTurns":40,"activationSessionTtlMs":1800000,"enabledPacks":["core","activation","workflow","router","skills","tooling","output","seats"],"maxLeafSkills":4,"maxInstructionChars":6000,"debug":false}'
```

Options are merged with Coffusio's defaults at runtime; omitted fields retain
their defaults. Disable only Coffusio's injection while leaving the plugin
installed with:

```sh
magpie plugin options /data/coffusio '{"enabled":false}'
```

Magpie can also turn the middleware off entirely and back on:

```sh
magpie plugin off /data/coffusio
magpie plugin on /data/coffusio
```

When it is off, Magpie does not run the middleware. When `enabled` is false or
the request does not match, `onRequest` returns `undefined`, which Magpie
defines as leaving the request body unchanged.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master injection switch. |
| `profile` | `standard` | `focus`, `standard`, `deep`, `max`, `builder`, `research`, or `creative`; adjusts response/work style, never permissions. |
| `modelProfiles` | `{}` | Optional exact model-name → profile map for provider/seat-specific style tuning; names are case-insensitive, and the global `profile` is the fallback. This does not enable provider tools or copy ColdCoffee's original seat prompts. |
| `channel` | `auto` | `auto`, `binary`, `game`, `network`, `api`/`cloud`, `lab`, `writing`, `build`, or `research`. A fixed channel limits routing to that family; it does not grant authorization. |
| `workMode` | `auto` | `auto` detects an applicable workflow from the latest user turn; or pin `reverse`, `unlock`, `infil`, `harvest`, or `train` (also accepts `reconstruct`, `compatibility`, `investigate`, `collection`, `training`). These modes add concrete stages and lawful-use/privacy/safety limits; they do not grant permissions. |
| `activationMode` | `always` | `always` injects on eligible user requests; `manual` injects only for a latest user turn that is exactly `冷咖啡` or a configured alias; `conversation` continues injecting while an exact trigger appears in the recent user-role history supplied in the request; `session` does the same plus a best-effort in-process TTL latch. Deactivation aliases always win. An exact trigger in the current turn also adds the truthful activation/help instruction. |
| `activationAliases` | `["cold coffee"]` | Exact case-insensitive aliases. The `冷咖啡` brand phrase is always recognized in manual mode. |
| `activationHistoryTurns` | `40` | In `conversation` mode, examine only this many most recent user turns (clamped to 1–200). Requires Magpie to include that history in each request; it is not a server-side timer/session store. |
| `deactivationAliases` | `["冷咖啡关闭", "coldcoffee off"]` | Exact turn text that clears a `session` latch. |
| `activationSessionTtlMs` | `1800000` | In `session` mode, how long a latch survives after the last trigger (clamped to 60 000–86 400 000). Held in middleware process memory only. |
| `activationMaxSessions` | `1000` | Cap on remembered `session` latches (clamped to 1–100 000); the oldest is evicted first. |
| `modelSeats` | `{}` | Optional exact model-name → seat overlay map: `codex`, `claude`, `grok`, `deepseek`, `glm53`, `gemini`, `doubao`, `workbuddy`, `cursor`, `mimo`, or `kimi`. Seats adjust terminology and emphasis only; they never claim provider identity, tools, or authority, and are not ColdCoffee's original per-provider seat prompts. |
| `modelAllowlist` | `[]` | Exact, case-insensitive Magpie model names; empty means any model. |
| `agentAllowlist` | `[]` | Exact, case-insensitive Magpie agent names; empty means any agent. A non-empty list fails closed if Magpie supplies no agent name. |
| `enabledPacks` | `core`, `activation`, `workflow`, `router`, `skills`, `tooling`, `output`, `seats` | Pack categories to compose. `activation` is used on an exact activation turn; `seats` only applies when `modelSeats` matches; skills are selected per request. |
| `maxLeafSkills` | `4` | Maximum specialist leaf packs selected from one request, clamped to 1–8. |
| `maxInstructionChars` | `5000` | Upper bound for the complete added instruction, including metadata. Validated to 1200–16000 characters so the smallest core pack can fit. Packs are omitted whole rather than cut mid-section. |
| `debug` | `false` | Logs protocol/model/route IDs and prompt size only; never logs user text. |

The installed middleware's defaults are in `src/config.js` as well as the
manifest example. Magpie currently passes `{}` when no plugin options have been
saved, so the runtime defaults do not depend on the UI applying the manifest's
example values.

## Activation modes and limits

`manual` is an exact one-request trigger. `conversation` and `session` keep a
conversation active by scanning exact trigger text in the recent user-role
turns Magpie forwards in the request body; a later deactivation turn
(`冷咖啡关闭`) wins over an earlier trigger, so "off" stays off.

`session` additionally keeps an in-process latch with a TTL. Magpie 0.1.x does
not pass a session or user id to middleware (its `ctx` is only protocol, model,
stream, path, agent, options, state, reject), and it may run middleware from a
pool of runtimes, so that latch is best-effort: it is keyed by an explicit
`ctx.sessionId` when a host supplies one, otherwise by a fingerprint of model,
system prompt and first user turn, it is per-process, and it can disappear on
restart or when a request lands in a different runtime. The history scan is what
makes cross-turn activation reliable in that environment; the latch can only end
activation earlier (TTL), never extend it.

Use `always` for automatic injection, or turn the plugin on/off explicitly with
Magpie.

## Offline preview

There is no need to run a gateway to see what would be injected. The bundled CLI
is a local, network-free port of ColdCoffee's explicit-input prompt workbench:

```sh
node src/cli.js --text "冷咖啡 脱壳加固" --channel binary
node src/cli.js --text "冷咖啡 看看这个域名" --protocol responses --json
node src/cli.js --text "随便聊聊" --activation-mode manual --json   # exit 2
```

It supports all four wire protocols, accepts `--options`/`--options-file` plus
per-run `--channel`, `--work-mode`, `--profile`, `--model`, `--session`
overrides, prints the compiled instruction (or the whole injected body with
`--show-body`), and emits exactly one JSON document in `--json` mode, including
errors. Exit codes: `0` injected, `1` invalid arguments, `2` nothing injected.

## Pack system and routing

Pack IDs have their own versions in `src/packs/`; the injected marker records
the versions used. `enabledPacks` composes categories; `router.js` selects up to
`maxLeafSkills` specialist leaves using local phrase rules—no model call or
network request. The matching copy of the latest user text is normalized for
common filler and a small typo table; the actual request body and user text are
not rewritten. Rules prefer the longest matching phrase, then its earliest
occurrence and a stable declaration order. Multiple leaves can be selected.
If no leaf matches, a broad parent can be selected from domain phrases or a
clear artifact cue (for example a binary file extension or URL/IP); otherwise
the general packs remain. This heuristic is not an authorization or safety
decision.

The routing catalog contains all **80 ColdCoffee leaf IDs** and all **208
normalized colloquial phrases** from the upstream route normalizer, across its
six families, plus 26 general-purpose implementation, debugging, testing,
research, writing, and analysis intents. Parent/leaf names and intent
vocabulary are preserved where useful; each leaf has route-specific operational
guidance rewritten for Magpie and scoped to safe, authorized work.

| Coffusio module | ColdCoffee source concept | Coffusio treatment |
| --- | --- | --- |
| `core` | Shared operating spine across seat packs | Rewritten provider-neutral behavior contract: preserve goal, deliver actual work, respect runtime/policy boundaries, maintain supplied context, and avoid fabricated tool claims. |
| `workflow` | `packs/workflows/*.md` workflows | Consolidated into orient → scope → execute → verify → close; does not invent targets, placeholders, tool results, or success. |
| `router` | `routes/ROUTER.md` and `NORMALIZER.md` | Deterministic local phrase matching, known typo normalization, multi-intent routing, parent fallback, and optional fixed domain; no paid classifier or guessed authorization. |
| `skills` | Six `cha-*` parent routes and 80 `routes/leaves/` | Preserves the route tree and names. Binary, game, network, API/cloud, lab, and writing guidance is rewritten; security-sensitive families are limited to owned/authorized, defensive, or local-test contexts. |
| `activation` | `activation-gate.js`, activation reply, and the `冷咖啡` latch | Keeps the exact brand trigger and configurable alias, truthful capability limits, and optional recent-history latch. No external group/service/API text is copied. |
| `workMode` | Cross-task `reverse` / `unlock` / `infil` / `harvest` / `train` modes | Auto-detects a suitable mode from the latest turn or accepts a pinned mode; adds concrete stages, expected checks, and defensive/lawful-use limits independently of `channel` and response `profile`. |
| provider-neutral packs | `packs/*.md` per-model templates and `seat-packs.js` | Replaces duplicated provider-specific text with one pack compiler. No model identity, provider role, or server authority is impersonated. |
| `tooling` / `output` | Artifact-first, tool execution, closeout conventions | Rewritten as scoped use of actually available tools, evidence-based verification, completion criteria, and concise artifact delivery. |

### Optional MCP toolbox

The middleware does not itself run tools, but Coffusio includes the portable
ColdCoffee toolbox as a separately connectable stdio MCP server. It advertises
22 tools by default (25 when the relay is configured; the two IDA tools stay
hidden unless explicitly enabled): bounded DNS, TCP and HTTP inspection;
same-origin crawling and limited path/input checks; binary metadata/byte/text/
diff helpers; copy-based byte patching; hash matching against caller-supplied
candidates; plan/start/list workflows; and task status, listing, cancel, pause
and resume. It also exposes `resources/list` + `resources/read` (toolbox
catalog, network policy, workflow catalog, active tasks, relay status) and
`prompts/list` + `prompts/get` (authorized review, binary triage, network
triage, write a workflow). There is no PCAP/log parser in this toolbox and no
desktop UI.

Start the sidecar with an explicit workspace and exact target allowlist, then
register that command as a stdio MCP server in Magpie:

```sh
node /path/to/coffusio/src/toolbox/mcp.js \
  --workspace /path/to/authorized/samples \
  --allow-host example.com
```

Network calls are denied without `--allow-host`; private, reserved, loopback,
and link-local addresses are denied unless the operator additionally supplies
`--allow-private` for a controlled local test. State-changing HTTP methods are
blocked unless `--allow-active` is set. IDA tools are hidden unless
`--enable-ida` is passed and then restricted to loopback port `13337`. The
sidecar confines file operations to the configured workspace. See
`src/toolbox/SKILL.md` for procedures and scope limits. Installing the
middleware does not automatically start or connect this sidecar.

#### Optional model relay (bring your own endpoint)

ColdCoffee's paid relay service is not redistributed. Coffusio instead ships a
thin OpenAI-compatible client that is **off unless configured**, only talks to
hosts you allowlist, requires HTTPS (plain HTTP is accepted for loopback only),
refuses credentials in the URL or query strings, caps prompts and responses,
and reports that a call is an external request not stored locally:

```sh
export COFFUSIO_RELAY_BASE_URL="https://relay.example.com/v1"
export COFFUSIO_RELAY_API_KEY="..."        # never logged or echoed
export COFFUSIO_RELAY_MODEL="your-model"   # optional default
export COFFUSIO_RELAY_ALLOW_HOSTS="relay.example.com"
export COFFUSIO_RELAY_ALLOW_PRIVATE=0      # 1 only for loopback test endpoints
```

It adds `relay_status`, `relay_list_models` and `relay_complete`. Any request it
sends leaves your machine; review the endpoint's terms and data handling before
enabling it. `relay_complete` is excluded from custom workflow steps so a
workflow cannot chain silent external calls.

The original desktop UI cannot be hosted inside Magpie's `onRequest`
middleware. Original instructions for licensing/DRM bypass, game cheating or
anti-cheat evasion, credential attacks, exploit chains, and stealth are not
copied; related routes are narrowed to defensive review, authorized targets,
local fixtures, supported development, or remediation.

## Protocol handling

The middleware uses Magpie's `ctx.protocol` when available and injects only
into a recognized body shape:

- OpenAI Chat Completions: adds a separate `system` message after existing
  leading `system`/`developer` messages.
- OpenAI Responses: appends to `instructions` and considers only user-role
  input items when routing.
- Anthropic Messages: appends to `system` (a string or a new text block).
- Gemini: appends to `systemInstruction.parts` (also accepts the snake-case
  `system_instruction` form).

Existing user content, conversation history, tools, images, generation
parameters, and unknown body fields are left intact. The middleware changes
only the relevant instruction field, returns a shallow copy, and does not touch
headers or API keys. It recognizes its own marker to avoid duplicate injection.
Unknown/malformed shapes fail open by returning `undefined`.

## Local tests

```sh
npm test
```

The tests use mock request objects and do not require provider credentials.
Magpie compiles this middleware with `moejs`; the module uses only relative
imports and standard synchronous JavaScript. `tests/` is deliberately not
included in the installed plugin package.
