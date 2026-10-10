# Comate provider plugin for Magpie

This plugin makes the Comate models available through Magpie's existing
provider gateway. Clients that use standard Chat Completions, Responses,
Anthropic Messages, or Gemini `generateContent` APIs can select a Comate model
through Magpie; the gateway translates those requests to the model's
OpenAI-compatible Chat API before the plugin calls Comate's local service.

## Install and sign in

From the `magpie-community-plugins` checkout, install the local package by its
absolute path and sign in:

```sh
magpie plugin add "$(pwd -P)/packages/comate"
magpie plugin login comate
```

The same plugin can be added from Settings → Plugins. Choose **Comate account
(this computer)** to read the license from the Comate app already signed in on
this computer, or **Comate license (paste)** to enter a license and, if needed,
the local service port. The plugin reads but does not modify Comate's settings
or service-discovery files. Magpie stores a pasted license with its plugin
sign-in.

The supplied candidate is installed from a local checkout or an offline ZIP.
Installation by npm package name requires the maintainer's first npm publication;
the market entry becomes available after the community pull request is merged.

The plugin discovers Comate's settings in the platform's normal location:

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

After sign-in, select a model under `comate/<model ID>`. The plugin refreshes
the model list from Comate's local `/list-model` endpoint when available and
uses a small fallback catalog if the local service cannot be reached during
discovery.

## Offline release packages

The offline build outputs are `comate-0.2.0-windows.zip` and
`comate-0.2.0-macos.zip`. Each ZIP has an `INSTALL.md`, a platform installer,
and a `payload/` directory. Extract the archive into a directory you plan to
keep, then run `install.ps1` (Windows) or `install.command` (macOS) from that
directory. The installer registers the extracted `payload/` path with
`magpie plugin add`; it does not copy the files. Keep the extracted directory
in place while Magpie uses the plugin. Installation does not sign in. Pass
`-Login` to `install.ps1` or `--login` to `install.command` only if you also
want the installer to start `magpie plugin login comate`.

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
npm run test:integration
```

These commands require the package source checkout; tests are not included in
the offline ZIP payload. The `npm` commands run local Node scripts and do not
download or publish the package.

The integration test starts Magpie's production Bun plugin host and points it
at synthetic services bound to loopback with temporary settings and service
files. It does not use a real Comate license or modify real Comate files. Set
`MAGPIE_BUN` to the Bun executable and either `MAGPIE_CHECKOUT` to a Magpie
source checkout or `MAGPIE_HOST` to its `internal/plugin/host.js` file. The
test reports a skip when Bun or the production host is unavailable; when both
are available it runs the production host integration.

From the community repository root, the package hook check is:

```sh
bun scripts/check.mjs comate
```

The adapter implementation is in [`index.mjs`](./index.mjs), Comate request
and stream contracts in [`protocol.mjs`](./protocol.mjs), and cross-platform
local discovery in [`discovery.mjs`](./discovery.mjs).
