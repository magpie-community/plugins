# @magpie-community/agent-cteno

[Cteno](https://cteno.cn) (`cteno-host-cli` and the Cteno desktop app) as a
Magpie agent. With this plugin installed, Cteno appears on Magpie's **Agents**
page so you can pick any of Magpie's models or routing groups for it, and
switch it off to put Cteno's `profiles.json` back.

```sh
magpie plugin add @magpie-community/agent-cteno
```

## How it works

Cteno stores its BYOK model profiles in `profiles.json` inside its OS app-data
folder (`com.cteno-host.gui`, or `$CTENO_APP_DATA_DIR` when set):

- **macOS**: `~/Library/Application Support/com.cteno-host.gui/profiles.json`
- **Windows**: `%APPDATA%\com.cteno-host.gui\profiles.json`
- **Linux**: `$XDG_DATA_HOME/com.cteno-host.gui/profiles.json` (or `~/.local/share/com.cteno-host.gui/profiles.json`)

Magpie's `moejs` agent sandbox edits a single static JSON file by object keys,
so `cteno.agent.js` writes the selected model and gateway address to
`~/.config/magpie-cteno/connection.json`, and the package's Bun host bridge
(`index.mjs` + `bridge.mjs`) updates Cteno's `profiles.json`:

- Upserts only the `"id": "magpie"` entry in `profiles[]` (under the `"Magpie"`
  picker section, speaking Anthropic Messages to `gateway.v1` with Cteno's
  per-agent gateway key `magpie-cteno`), and sets `"default_profile_id": "magpie"`.
- Leaves every other profile and top-level setting (`subscription_compress`,
  `light_model`, media backends, `base_url_schema`) untouched.
- Requires Cteno 2.10.14 or later (which uses `base_url` as stored); Cteno
  reads `profiles.json` at start-up, so restart Cteno after connecting or
  switching models.

## Disconnect & clean restore

Switching Cteno back to its own model, disabling the plugin, or removing it
restores `profiles.json` byte for byte when nothing else modified the file
meanwhile (or deletes `profiles.json` if the plugin created it and no user
profiles were added). If you added or edited other profiles in Cteno while
connected, only the `"magpie"` profile is removed and your edits stay.
