# magpie-jev-context

A magpie decision-provider plugin that wraps Jev and adds context to every
System One request: the current time, static JSON data, and the output of
trusted local scripts. It is meant for magpie routing groups that use Jev as
their classifier, including `effort=auto`.

The plugin is a provider plugin, not gateway middleware. magpie's own
classifier requests bypass `onRequest` middleware, but they do go through a
plugin provider's `/systemone` fetch. That is the supported place to add
context without patching magpie.

## What it adds

The plugin leaves magpie's prompt alone except for one extra state field and
one sentence appended to each question's `instructions`:

```json
{
  "state": {
    "message": "明天下午三点提醒我",
    "context": {
      "current_time": "2026-11-20T08:00:00.000Z",
      "local_time": "2026-11-20 16:00:00",
      "timezone": "Asia/Hong_Kong",
      "utc_offset": "UTC+08:00",
      "weekday": "Friday",
      "unix_time": 1763625600,
      "data": { "project": "demo" },
      "scripts": { "git": "## main\n M README.md" }
    }
  }
}
```

The note tells Jev to use `context` when the message depends on time, dates,
schedules, or the supplied facts. Without a note, a model may ignore extra
state fields. The field name is configurable with `contextKey`.

The plugin does not replace magpie's intent, level, or effort questions. It
only enriches their state and instructions, so magpie's normal answer parsing
still works.

## Install

1. Add the plugin from GitHub or its folder:

   ```sh
   magpie plugin add github:4fuu/magpie-jev-context
   ```

2. Add the **Jev Context** provider in magpie and sign in with a TypeSafe API
   key. The key is stored by magpie's normal plugin sign-in, not in this
   repository.

3. In a routing group, use:

   ```sh
   magpie group set <group> classifier=jev-context/jev-latest effort=auto
   ```

   `effort=auto` is optional; without it the plugin still adds context to
   intent classification.

4. Send a message. The classifier's `/systemone` request now passes through
   the plugin. The request archive, if enabled, shows the enriched body.

## Provider menu and editor page

The plugin adds **Jev Context** to magpie's Plugins group and **Edit Jev
context** to every provider's row menu. The menu opens the editor page and
tells it which provider was picked; the page is the Jev Context provider's
editor, so a click from another provider says so instead of editing it.

magpie does not show `magpie.panels` provider panels in a plugin provider's
account editor (the account editor returns before its panel slot), so this
uses a page and a provider action rather than a panel.

The page edits time, timezone, data, scripts, prompt, upstream URL and
upstream model from magpie itself. It saves its values in the plugin's own
options (`options.config`). Those values override `jev-context.json`; `data`
and `scripts` in the page replace the file's own. **Use config file** removes
the override and goes back to `jev-context.json`.

Saving options restarts the plugin host because this is also a provider
plugin. The page uses an explicit Save button, not autosave. The file remains
useful for headless setups and for keeping a config under version control.

## Configuration

The plugin reads `jev-context.json` from magpie's config folder by default.
Set `JEV_CONTEXT_CONFIG` to use another path.

```json
{
  "upstream": "https://api.typesafe.ai/v1",
  "upstreamModel": "jev-latest",
  "time": true,
  "timezone": "Asia/Hong_Kong",
  "data": {
    "project": "demo"
  },
  "scripts": [
    {
      "name": "git",
      "command": "git status --short --branch",
      "timeoutMs": 1000,
      "maxBytes": 2000
    }
  ],
  "prompt": "Use context.scripts.git when the message depends on the repository.",
  "controlFile": "jev-context.control.json",
  "timeoutMs": 7000
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `upstream` | `https://api.typesafe.ai/v1` | TypeSafe base URL. `/systemone` is appended. |
| `upstreamModel` | `jev-latest` | Model sent upstream, whatever model the caller names. |
| `time` | `true` | Add current time fields. |
| `timezone` | system zone | IANA zone such as `Asia/Hong_Kong`. |
| `data` | `{}` | Static JSON merged into `context.data`. |
| `scripts` | `[]` | Trusted commands whose stdout becomes `context.scripts.<name>`. |
| `prompt` | `""` | Extra sentence appended to each question's instructions. |
| `cwd` | magpie config folder | Default working directory for scripts. |
| `env` | `{}` | Extra environment variables for scripts. |
| `timeoutMs` | `7000` | Upstream request timeout, and the default script timeout. |
| `maxOutputBytes` | `4000` | Default script stdout limit. |
| `controlFile` | `jev-context.control.json` | Per-machine control file next to the config. `false` disables it. |
| `contextKey` | `context` | State field the context is written to. |
| `authHeader` | `authorization` | Upstream auth header. |
| `authScheme` | `Bearer` | Prefix for the API key. Empty sends the key raw. |
| `headers` | `{}` | Extra upstream headers. |

`upstream` is read when the plugin host loads the account. Restart magpie after
changing it. Other fields are read on every request.

## Per-call replacement

A direct `/v1/systemone` caller can put a reserved `jev_context` object in
`state`:

```sh
curl -s http://127.0.0.1:3425/v1/systemone \
  -H 'Authorization: Bearer magpie' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "jev-context/jev-latest",
    "state": {
      "message": "把发布说明写到明天下午的版本里",
      "jev_context": {
        "now": "2026-11-21T06:00:00Z",
        "timezone": "Asia/Shanghai",
        "data": { "release": "2026.11.21" },
        "scripts": ["git"],
        "prompt_append": "The release date is fixed; do not infer it."
      }
    },
    "questions": {
      "intent": { "type": "choice", "instructions": "Which kind of request is this?" }
    }
  }'
```

The `jev_context` object is removed before the request goes upstream. Its
fields:

- `now` or `current_time`: ISO time or Date-parseable string.
- `timezone`: IANA zone for this call.
- `time`: `false` to omit time fields.
- `data`: merged over configured data.
- `scripts`: names of configured scripts to run; an empty array runs none.
- `replace`: `true` to ignore configured data and scripts.
- `prompt`: replace the configured prompt for this call.
- `prompt_append`: append to the effective prompt.

Precedence is config, then control file, then the call's `jev_context`.

For a caller's own request body, `request` in the CLI applies the same
injection without sending anything:

```sh
jev-context request request.json
```

## Control file and scripts

The control file is for a local script that wants to change the next
classifier calls without editing the config:

```sh
jev-context control '{"data":{"deploy":"staging"},"scripts":["git"]}'
jev-context control clear
```

A call's `jev_context` overrides it. Because magpie's internal classifier
request does not carry caller headers or a session, a script cannot pass a
private header into that request. Use the control file, a per-call `state`
field when calling `/v1/systemone` yourself, or a message-keyed lookup inside
your own wrapper.

Scripts are defined only in the config. A request can select a configured
script by name, but cannot define a new command. That keeps a `/systemone`
caller from turning the plugin into arbitrary command execution. Scripts run
with the plugin host's user permissions, so only configure commands you
trust. Output is truncated and failures appear in `context.script_errors`
without failing the whole classification.

Scripts receive:

- `JEV_CONTEXT_MESSAGE`: the request's message.
- `JEV_CONTEXT_NOW`: the effective time as ISO.

## Development

```sh
bun install
bun test
bun run check
```

The tests cover time formatting, data merging, script output, control-file
precedence, per-call replacement, prompt injection, and the plugin's upstream
request. They do not call the live TypeSafe API.

## Limits

- Only requests that select this plugin's model are enriched. A group still
  pointed at `typesafe/jev-latest` bypasses it.
- The plugin adds one network hop. Keep scripts fast; the classifier timeout
  is magpie's, 8 seconds by default.
- Context is sent to the configured upstream. Do not put secrets in `data` or
  script output unless that upstream is allowed to see them.
- `upstream` changes require a host restart because the provider loader's base
  URL is cached by magpie.
