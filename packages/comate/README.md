# Comate provider plugin for Magpie

This experimental plugin translates Comate's local text service into
OpenAI-compatible Chat Completions for Magpie's provider gateway. Magpie can
translate Responses, Anthropic Messages and Gemini requests into that format.
Real Codex and Claude Code tool-call-and-continuation acceptance is still
pending. The last previously reported full live API run failed the Responses
required-tool case with a 502; it was not an all-API pass.

The candidate is not yet listed in the market or published on npm. See
[VALIDATION.md](./VALIDATION.md) in the source checkout for evidence, remaining
requirements and the real-client acceptance procedure.

## Install and sign in

The distribution channel is the normal npm package. After a community npm
owner publishes the first version and the review prerequisites are met:

```sh
magpie plugin add @magpie-community/opencode-comate-auth
magpie plugin login comate
```

For development before publication, use an absolute source-checkout path:

```sh
magpie plugin add "$(pwd -P)/packages/comate"
magpie plugin login comate
```

After publication and listing, the plugin can also be added from Settings →
Plugins. Choose **Comate account (this computer)** to read the license from
the Comate app already signed in on
this computer, or **Comate license (paste)** to enter a license and, if needed,
the local service port. The plugin reads but does not modify Comate's settings
or service-discovery files. Magpie stores a pasted license with its plugin
sign-in.

The discovery code uses these platform paths (path fixtures do not prove
that the app or service works on those platforms):

- Windows: `%APPDATA%\Comate\User\settings.json`
- macOS: `~/Library/Application Support/Comate/User/settings.json`
- Linux: `$XDG_CONFIG_HOME/Comate/User/settings.json`, defaulting to
  `~/.config/Comate/User/settings.json`

The local `zulu serve` port is read from `~/.comate/zulu-serve.pid`; when that
file is absent, the plugin uses a pasted port or the documented fallback
port `8741`. Portable or test setups may set absolute `COMATE_SETTINGS_PATH`
and `COMATE_PID_PATH` values and a numeric `COMATE_PORT`. Requests are sent to
IPv4 loopback only, and redirects are rejected. The plugin does not contact a
remote Comate API itself; Comate's local service owns any connection it makes
to its own backend.

Native Windows discovery and tool turns have not been tested. Linux also
has no real desktop acceptance evidence. Neither is advertised as verified.

After sign-in, select the exact model ID returned by the current account's
local `/list-model` endpoint under `comate/<model ID>`. There is no built-in
fallback catalog. The old hex-suffixed seed IDs had no established
account-independent provenance, so they have been removed. If discovery is
unavailable, only explicitly configured models remain; no account's IDs are
invented for another account. Display-name and model-type aliases are scoped
to each plugin instance and current credential/local endpoint, and replaced
on refresh. A failed refresh discards that credential's aliases.

Only positive integer `limit.context`, `limit.input` and `limit.output` values
in a live model record are carried into model metadata. Missing context or
output limits remain `0` (the host's unknown sentinel). No real `/list-model`
response with verified context limits is available for this revision; these
field mappings are covered by synthetic tests only. A real account response
must establish the field names, units and values before claiming a usable
context size. A name such as "128k" is not evidence of the account's window.

## Function tools

Function tools use prompt-based emulation over Comate's text interface.
Magpie passes the conversation, function names, descriptions, and schemas to
Comate as text. When Comate returns the complete request-specific tool marker
block with valid JSON arguments and offered function names, the plugin emits
standard OpenAI `tool_calls`; Magpie translates them to the calling API's
format. The calling client executes the function and returns its result in the
next request.

This is not native Comate tool execution. The adapter accepts standard
function tools, supports `auto`, `none`, `required`, and named function choices,
and rejects `strict: true`. It checks that names were offered and arguments
are JSON objects, but does not validate arguments against the full JSON
Schema. Model compliance with the prompt protocol is not guaranteed, and the
adapter does not repair malformed tool blocks or silently convert them into a
successful required call. For `required` and named choices, streamed ordinary
text is held until tool-call validation, and Comate reasoning text is discarded
instead of returned. If the required block is missing or malformed, the stream
ends with an API error and no successful completion. A Comate-native `TOOL`
stream element is not treated as a standard function call.

No forked gateway change is required. The plugin's non-stream path collects
the entire Comate SSE response and returns 502 if the task fails, even after
partial text. A streamed response can already have emitted text before an
upstream failure; Magpie retains its normal partial-text behavior. A reply
with only reasoning before failure is already a 502 under the upstream rule.
Required/named tool validation holds text until completion as described above.

The current adapter accepts text inputs only: `text`, `input_text`, and
`output_text` parts, plus the legacy untagged `{ "text": "…" }` shape. It
rejects image, audio, video, file, function, tool-result, and unknown content
parts, and returns a 400 for an empty text request. Reasoning text is returned
when the local service emits it, but `reasoning_effort` is not forwarded and
cannot be selected through this adapter. Generation controls such as
`temperature`, `top_p`, penalties, stop sequences, and `max_tokens` or
`max_completion_tokens` are also not forwarded; they do not affect Comate
generation here.

## Development checks

The package uses Node's built-in test runner and no npm dependencies:

```sh
cd packages/comate
npm test
MAGPIE_CHECKOUT=/absolute/path/to/magpie npm run test:integration
```

These commands require the package source checkout; tests and the host helper
are not included in the npm package. The `npm` commands run local Node scripts
and do not download or publish the package.

The integration test starts Magpie's production Bun plugin host and points it
at synthetic services bound to loopback with temporary settings and service
files. It does not use a real Comate license or modify real Comate files. Set
`MAGPIE_BUN` to the Bun executable and either `MAGPIE_CHECKOUT` to a Magpie
source checkout or `MAGPIE_HOST` to its `internal/plugin/host.js` file. The
test runs only with an explicitly specified host/checkout and available Bun.
It never searches neighbouring directories. With no explicit path, or with
missing prerequisites, it reports a skip. This fixture-backed host test does
not count as real Comate, Codex, Claude Code or native Windows validation.
Use an unmodified upstream Magpie checkout; no gateway patch is needed.

From the community repository root, the package hook check is:

```sh
bun scripts/check.mjs comate
```

The adapter implementation is in [`index.mjs`](./index.mjs), Comate request
and stream contracts in [`protocol.mjs`](./protocol.mjs), and cross-platform
local discovery in [`discovery.mjs`](./discovery.mjs).
