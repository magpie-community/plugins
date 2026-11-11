# magpie-muse-bridge

<img src="./assets/meta.svg" alt="Meta" width="48" height="48">

A [magpie](https://github.com/yetone/magpie) provider plugin built on the
**official Muse Code SDK** and the real `muse serve` host.

Each conversation keeps one SDK-owned `muse serve --preset empty` process.
The empty preset removes built-in tools; the client's tools are supplied as a
MCP server in that conversation's private host settings. Muse handles upstream authentication and model calls.
An explicit `exec` mode retains the original per-turn CLI implementation.

The SDK uses the CLI's configured credential. On November 4, 2026, the bridge
passed real-account tests on the **Macmini** with Muse 1.4.14 and
`muse-wonder-1.0`: text generation with usage, a follow-up recalling history,
and an MCP `tool_use → tool_result → end_turn` round trip. The existing Muse
browser sign-in was used with `META_API_KEY` unset. See the
[Macmini verification record](docs/diagnostics/2026-11-04-macmini.md).
Meta's subscription
documentation limits subscription credentials to Muse Code; SDK login reuse
alone does not establish subscription eligibility for third-party gateway use.
An API key in `META_API_KEY` takes precedence over browser login and may be billed
pay-as-you-go. See [Meta's authentication](https://dev.meta.ai/docs/muse-code/auth)
and [subscription documentation](https://dev.meta.ai/docs/muse-code/subscriptions).

```
Client (OpenCode, Claude Code, Amp, ...)
  │  Anthropic Messages (POST /v1/messages)
  ▼
magpie gateway → muse-bridge provider → this plugin
  │  @muse-code/sdk → muse serve --preset empty   (MSP over stdio)
  │  MCP server "magpie" → client tools as mcp__magpie__<tool>
  ▼
real muse CLI → Meta Muse Code backend
```

## Requirements

- Muse Code CLI (`muse`), signed in through the CLI. SDK mode is tested with
  **Muse 1.4.14**, paired with pinned **`@muse-code/sdk` 1.4.14**. The SDK is
  Developer Preview. Hosts must support `serve --preset` and grant `sessionMcp`.
- Node.js 20+ or Bun. Node and Bun both run the deterministic SDK/MCP tests.
- magpie with OpenCode provider plugin support. Tested with **magpie 0.1.1734**.

## Install

From a local checkout:

```sh
cd magpie-muse-bridge
npm ci
cd ..
magpie plugin add ./magpie-muse-bridge
magpie plugin login muse-bridge
```

The Magpie account picker offers **Sign in with Muse** and **Use existing Muse
sign-in**. **Sign in with Muse** also asks how to sign in, so UI paths that open
that method directly still offer **Use existing Muse sign-in** and **Sign in
with Muse in browser**. Reusing the login checks `muse usage` without opening a
browser or asking for a key. Choosing the browser option starts the official
`muse login` process and shows its
HTTPS approval link and copyable device code. Magpie waits for the same CLI to
finish and verifies the account with `muse usage`; it stores only a non-secret
`muse` connection marker. The second method only verifies an existing CLI login.
In a terminal you can select them explicitly:

```sh
magpie plugin login muse-bridge 1  # choose existing login or browser/device approval
magpie plugin login muse-bridge 2  # reuse existing Muse sign-in
```

The login is shared with your official Muse CLI. The bridge does not implement
Meta OAuth or store tokens in Magpie. Login runs with a private settings context
and the shared `auth.json` link, so Magpie's upstream rewrite cannot create a
proxy loop. Credential refreshes are synchronized at turn completion, failure,
and host exit, including immediate plugin-process exit.

If `META_API_KEY` is set on the Magpie host, it still takes precedence for model
requests after browser login. The sign-in UI warns about this; remove the key
from that host's environment to use the browser account. Magpie disconnects with
`magpie plugin logout muse-bridge`; it removes the marker but preserves the
shared Muse login. Run **`muse logout` yourself** to clear that CLI login too.
Finish or cancel active Muse turns before changing accounts through the plugin.

Browser sign-in uses the CLI's human-readable URL/code display, not a stable
JSON interface. Parsing, cancellation, timeout, rejection, duplicate sign-ins,
and marker storage are tested with a local fake Muse executable, including the
installed Magpie 0.1.1825 host. The exact display and Keychain behavior of a real
Meta sign-in have **not** been tested. If the CLI's display changes or Magpie is
too old to cancel the flow, a bounded timeout cleans it up; use `muse login` in
a terminal and then the existing-login method.

Models show up as `muse-bridge/<model>`:
`muse-wonder-full-1.0`, `muse-wonder-1.0`, `muse-spark-1.3`, `muse-spark-1.2`.
Thinking variants map to MSP `turn/start.reasoningEffort` (minimal … max).
The requested model must appear under Meta in the host's `model/list` catalog;
an unavailable model is rejected instead of silently switching providers.

To explicitly keep the original CLI transport, set `MUSE_BRIDGE_TRANSPORT=exec`
in the environment of the Magpie plugin host and restart that host.

## Subscription allowance

The account's allowance appears in **Providers** and **Usage**, and through
`magpie quota muse-bridge --json` or the gateway's `/v1/magpie/quotas` endpoint.
The plugin reads the official `muse usage --json` command without a model turn,
using the same isolated settings and shared CLI login as its sign-in check.
When Muse reports them, Magpie shows the tier, current-window and weekly **used
percentages**, reset times and the reading's **As of** timestamp. Muse does not
report absolute token limits here. A missing duration is not assumed to be
five hours, and unavailable usage is never treated as zero or unlimited.

If Muse returns `server_sent_no_usage`, the account instead says **Muse has not
returned usage data for this subscription yet**. This can happen before use in
a new window. The plugin preserves the login and does not make a model request
to generate usage. API-key connections and accounts without a reported allowance
also get an explicit explanation. Refreshing uses Magpie's normal quota cache.

## How it works

- **One host per conversation.** The SDK initializes MSP, verifies the
  `sessionMcp` grant, creates a session, and submits turns. A second user message
  reuses the same live host/session. A stopped idle host can resume the durable
  session. If a host restarts and the session is definitively missing, the same
  request creates a new session and replays caller history before any new turn
  is submitted. A session owned by another host is never replayed automatically.
  Schema fingerprint/version mismatches warn; missing capabilities fail.
   Edits, compaction, aborted turns, workspace changes, and changed tool
   definitions create a fresh session with caller history rendered once. A model
   change uses MSP `session/setModel` on the existing session; reasoning effort
   remains a per-turn request option. Ambiguous
   turn admission is not automatically retried.
   Tool definitions are compared canonically, so JSON key ordering alone does
   not rebuild a session; an actual MCP name, description or schema change still
   does because MSP 1.4.14 has no supported session MCP hot-reload method.
- **Real tool round trips.** When the model calls a tool, muse's MCP
  `tools/call` stays pending, and the HTTP response ends with
  `stop_reason: tool_use`. The next request's `tool_result` answers that exact
  call and the same muse run continues. Tools called together in one model
  step are handed over in one response. Tool errors, images in tool results, and
  context notices (`<system-update>`, task notifications) work the same way
  they do in the antigravity bridge.
- **Isolation.** Each conversation gets its own `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, and `XDG_STATE_HOME`. Its private `settings.json` declares
  only the bridge MCP server, so your own MCP servers stay out, and magpie's rewrite of
  your muse `endpoint_transport` to its gateway can't loop back. Sessions don't
  appear in your `muse resume` list. `auth.json` is a symlink to your real one
  (`${XDG_CONFIG_HOME:-~/.config}/muse/auth.json`). If muse replaces the link
  with a regular file, the bridge copies it back atomically and restores the
  link promptly after turns and host exit. `MUSE_AUTH_PATH` is a bridge-side
  override for that shared file, not a documented Muse CLI option. SDK hosts run with `--preset empty`, user-input
  requests withheld, and Contributor mode off. The reminder roster is empty to
  prevent extra observer model calls. The session's
  `allowAll` approval mode applies only to the bridge MCP tools; actual operations
  and permissions stay in the requesting client. Unexpected approvals/questions
  fail the turn. `MUSE_LOGIN=0` prevents interactive sign-in.
- **Errors you can act on.** The HTTP response waits for muse's first event
  (up to 15 s). A failure before any output, such as a lapsed sign-in, returns
  401 with `X-Magpie-Sign-In: expired`, or 429 for quota, instead of an error
   inside a 200 stream. A model-access refusal or an empty model catalog returns
   404 (`not_found_error`) if detected before the stream starts. A later refusal
   retains HTTP 200 and emits an SSE `not_found_error`. Both preserve the sign-in
   and tell you to verify model access in the official CLI.
- **Usage.** MSP `session/tokenUsage` supplies counted-once prompt tokens per
  completion, aggregated for the turn without adding `turn/completed.usage` twice.
  The final HTTP `message_delta` uses Anthropic's convention (`input_tokens`
  excludes cache reads/writes). Reasoning
  tokens go in `output_tokens_details.thinking_tokens`.

## Limitations

- **No system-prompt replacement.** The public MSP contract has no system-prompt
  override. Caller `system` instructions are embedded in the initial user input;
   they are not system-role equivalent. Muse's own instructions remain and may load
   personal rules/skills. The bridge doesn't claim full raw-model API equivalence.
   The SDK also exposes no supported flag or session method to remove Muse's core
   native prompt. The bridge already uses `--preset empty`, an empty reminder
   roster, `--disable-request-user-input`, contributor mode off, and an untrusted
   isolated workspace to avoid optional tools, observers, workspace skills and
   extra client-side context. Removing the remaining native prompt would require
   unsupported Muse internals or a different runtime.
- **Reasoning text isn't shown.** SDK mode currently forwards agent-message text;
  it does not expose internal reasoning or reminder output as assistant text.
- **Images:** base64 PNG, JPEG, GIF, and WebP in the current user message go to
  native MSP image parts (`--image` in exec mode). Images earlier in a replayed history become a text marker.
  Document blocks return 400.
- **User text beside a live `tool_result`** returns 400, the same as the
  antigravity bridge. Send it after the tool continuation completes.
- **Process limits:** hosts stay live until conversation eviction (30-minute
  idle expiry, up to 32 cached conversations). Only four foreground runs are
  admitted by default. A cold host still has a startup cost; follow-up turns
  avoid it. Native MCP timeouts are configured above the bridge's tool-result
  wait budget. Host settings are used because the public MSP per-session MCP
  schema has no timeout field; each host serves only its owning conversation.
- **One account**, whichever one `muse login` signed in.
- **macOS Keychain:** Muse may keep part of its credential in the Keychain.
  Reusing the real login with isolated bridge settings passed on the Macmini
  in the logged-in GUI user session. SSH can lack Keychain access even while
  that login works in the GUI; run manual tests in the GUI user session in
  that case. Login failures retain Muse's own diagnostic message.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MUSE_PATH` | `muse` on `PATH`, `~/.local/bin/muse` | CLI to run |
| `MUSE_AUTH_PATH` | user's Muse `auth.json` | optional bridge-side shared credential file override; CLI authentication and Keychain access remain CLI-owned |
| `MUSE_BRIDGE_TRANSPORT` | `sdk` | `sdk` uses the official MSP SDK; `exec` explicitly selects the legacy CLI transport. No automatic fallback. |
| `MUSE_BRIDGE_MAX_ACTIVE` | 4 | muse runs in flight at once |
| `MUSE_BRIDGE_TURN_TIMEOUT_MS` | 600000 | silence from muse before a turn fails |
| `MUSE_BRIDGE_TOOL_TIMEOUT_MS` | 1800000 | bridge wait for a tool result; both transports set native MCP `tool_timeout_sec` to this budget plus 60 seconds |
| `MUSE_BRIDGE_FIRST_EVENT_MS` | 15000 | how long the HTTP answer waits for muse's first event |
| `MUSE_BRIDGE_BASE_URL` | unset | explicit upstream override for testing; SDK sets `endpoint_transport.base_url`, exec passes `--base-url`. Do not point back at this Muse provider. |
| `MUSE_BRIDGE_LOGIN_DISCOVERY_MS` | 30000 | maximum wait for the CLI's displayed approval URL/code; may only shorten this budget |
| `MUSE_BRIDGE_LOGIN_TIMEOUT_MS` | 540000 | total device-login deadline, including an abandoned callback; may only shorten this budget |

## Development

Manual verification runs on the **Macmini**, using its existing real Muse
browser sign-in. That is the acceptance environment for subsequent changes;
the earlier `large-vps` results remain historical diagnostics. The Macmini's
logged-in macOS user session must have access to Muse's Keychain credential.
An SSH Keychain-access error is not evidence that the account is signed out.
Use an isolated checkout and preserve the existing Muse/Magpie configuration.
GitHub Actions also runs the deterministic suites automatically.

```sh
npm run check
npm test                             # deterministic SDK, auth and owned-process cleanup tests
npm run test:bun                     # the same suites under Bun
MUSE_TEST_MAGPIE_AUTH=1 node test-auth-magpie.mjs # installed Magpie + fake Muse, isolated config; no real login
MUSE_TEST_BIN=/path/to/muse node test-sdk.mjs # real SDK host + local fake Meta; no paid model calls
MUSE_TEST_SLOW=1 MUSE_TEST_BIN=/path/to/muse node test-sdk.mjs # also hold an MCP call for 75 seconds
MUSE_TEST_BIN=/path/to/muse npm run test:exec # original exec regression suite
MUSE_TEST_SLOW=1 MUSE_TEST_BIN=… node test-real-muse.mjs   # adds a 75 s tool wait
MUSE_TEST_MAGPIE=1 MUSE_TEST_BIN=… node test-magpie-backend.mjs   # real model via a local magpie; spends tokens
MUSE_TEST_LIVE=1 npm run test:live       # real Meta account: text, follow-up, MCP; spends quota
```

`test:live` requires a saved Muse browser sign-in and rejects `META_API_KEY`, so
an environment API key cannot mask the subscription login. It
defaults to `muse-wonder-1.0`; select another model with `MUSE_TEST_MODEL`. Each
request is bounded to 60 seconds. It stops at the first failure, checks SSE
errors even when HTTP is 200, and never counts a login/usage check as successful
inference. It runs the local plugin so it can dispose the conversation and any
pending MCP calls on failure, and prints the selected `sdk` or `exec` transport.

The GitHub repository carries the `magpie-plugin` topic for Magpie's plugin
discovery. The embedded Meta SVG in `package.json` → `magpie.icon` supplies the
discovery, installed-plugin, and provider icon without an external image fetch.

If the live test reports `model ... does not exist or you lack access`, run the
same model directly on the same host:

```sh
muse exec --preset empty --model muse-wonder-1.0 --contributor-mode off "Reply OK"
```

If that also fails, model access is blocked upstream of the bridge. `muse usage
--json` can succeed with `server_sent_no_usage` even when Meta's model catalog is
empty; that result confirms neither model availability nor successful inference.
Refresh the official Muse login with `muse login` and check that it is the same
Meta account whose model/subscription access you verified. Preserve the upstream
`request_id` if reporting the issue to Meta. Repeated retries or changing bridge
transports do not establish model access.

In the November 4 check, the CLI logged a successful credential refresh. In an
isolated copy of the login with its cached API key removed, `muse usage --json`
reacquired the same key; Meta still returned an empty catalog and a direct model
request still failed. This rules out neither stale OAuth state nor an account
mismatch; the account's actual subscription status cannot be inferred from the
empty catalog alone. A subsequent fresh browser sign-in succeeded in the native
CLI logs, but the model catalog remained empty and direct Wonder requests still
failed with Contributor mode both off and on. Reauthentication did not restore
model access on that VPS. A later Macmini check passed text, follow-up and MCP
round trips using its own existing browser sign-in. Subsequent acceptance tests
use the Macmini; the VPS account/environment issue remains a historical finding.

`test-sdk.mjs` always tests streaming, usage, conversation reuse, divergent-history
replay, tool results/duplicate conflicts, changed tool schemas and images. Its
deterministic host also tests auth/quota errors, host death, unsupported requests,
capability denial and cancellation without any Muse installation. With a real
Muse binary it additionally checks the actual upstream tool schemas and durable
resume after host shutdown.

The three legacy `test:exec` files drive a **real muse binary** against a local fake
Meta upstream (`test-harness.mjs`: `/muse-code/models` plus streamed
`/v1/responses`, served over raw TCP so hang-ups are seen under Bun too) with
`META_API_KEY=dummy`, so they need no Meta sign-in and send nothing off the
machine. They were originally tested with Muse 1.4.13.

- `test-real-muse.mjs` (9) covers:
  - plain turns, session resume, and replay after diverged history
  - MCP tool round trips, including two calls in one step
  - OpenCode-style JSON schemas and a tool result after 75 s
  - 401 mapping, auth.json write-back, and sign-in failure
- `test-failures.mjs` (9) covers:
  - client aborts before output, mid-text, during a pending MCP call, and
    during a tool-result continuation
  - muse exiting at start, killed mid-stream, and killed while the client
    runs a tool
  - 429 retried, and persistent 429 mapped to HTTP 429
- `test-edges.mjs` (10) covers:
  - turn and tool-result timeouts
  - `MAX_ACTIVE` 503
  - images, current turn via `--image` and older ones as markers
  - tool results: `is_error`, `<system-update>` after a tool_result, renamed
    `tool_use_id` fallback, and duplicate / stale tool results (409)
  - idle eviction with history replay, and 401 fast-fail

Every failure case checks three things: muse and its MCP helper have exited,
the bridge holds no turn or tool call, and the next turn recovers.

`test-magpie-backend.mjs` is opt-in. It points muse at a magpie gateway
(`MUSE_TEST_MAGPIE_ORIGIN`, default `http://127.0.0.1:3425`, no auth) to run
a real model: a plain turn, an MCP tool round trip, and a second turn. A small
forwarder in the test flattens muse's `namespace` tools first. magpie's
`/v1/responses` returns namespaced calls as `{name, namespace}` (Codex's
form), but muse 1.4.13 only matches the flat `mcp__<server>__<tool>` name.

The plugin was also installed in an isolated **magpie 0.1.1734** host (separate
XDG dirs and gateway port). `plugin add` and keyless `plugin login` passed.
Requests to the gateway's `/v1/messages` completed a plain-text turn and a
`tool_use → tool_result → end_turn` round trip, using the real muse against the
fake upstream. Real Meta inference and MCP tool execution subsequently passed
through the plugin on the Macmini, as recorded above; that run used the plugin
directly and did not test Magpie's gateway HTTP translation.

## License

MIT
