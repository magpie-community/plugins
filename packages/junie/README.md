# @magpie-community/agent-junie

Junie CLI through Magpie's OpenAI-compatible gateway, without LiteLLM or a
background plugin runtime. This follows the community Cowork package: an
ordinary agent module plus an explicit catalog seed script.

## Install and connect

Install from Magpie's Plugins tab, or with the CLI:

```sh
magpie plugin add @magpie-community/agent-junie
```

After installation, `seed.mjs` is at
`~/.config/magpie/plugins/node_modules/@magpie-community/agent-junie/seed.mjs`.
If `XDG_CONFIG_HOME` is set, replace `~/.config` with that directory.
The seed command requires Node.js 18 or later. With Junie closed, connect a
model and seed the catalog before starting Junie:

```sh
magpie junie <provider/model>
JUNIE_SEED="${XDG_CONFIG_HOME:-$HOME/.config}/magpie/plugins/node_modules/@magpie-community/agent-junie/seed.mjs"
node "$JUNIE_SEED" --eco on
junie
```

The commands below use `JUNIE_SEED` set above. `magpie junie <provider/model>` writes
`~/.junie/magpie/connection.json`: its `id` is Magpie's selected model ID,
`baseUrl` ends in `/v1/chat/completions`, and `apiKey` is the Junie agent's
gateway key. This connection file is outside Junie's model discovery folders.

The seed script reads that connection's endpoint and key, fetches `/v1/models`
with Junie's User-Agent, and writes one native JSON profile per advertised
model into `~/.junie/magpie/models/`. Stable profile IDs are derived from the
gateway IDs; the original wire IDs are preserved inside the profiles. Their
display names end in `· Magpie` in Junie's `/model` picker.

The script adds its discovery directory to `config.json`'s `model-locations`.
On every seed it sets `settings.json`'s `modelForLaunch` to the ordinary
profile for Magpie's selected model, clears an incompatible remembered
provider/Mix, and marks default-model onboarding complete. Junie stores
these settings as strings. The picker contains exactly the advertised models,
without an additional selected-model alias.

To choose an individual catalog model as the launch default:

```sh
node "$JUNIE_SEED" --model provider/model --eco on
```

You can also choose an individual model in Junie's `/model`. Running the seed
again copies Magpie's current selection back to the launch default, unless
you explicitly override it with `--model`.

## Refresh and remove

Run the seed script again when Magpie's catalog changes, then restart Junie.
Junie discovers the local profiles; it does not poll Magpie itself. There is
no background refresh process. Missing catalog entries are removed only if
the seed script owns their files. The new launch default must exist in the catalog.
An empty, invalid, partial or unavailable catalog leaves the existing files
in place. A user edit to a generated profile is reported instead of overwritten.

```sh
node "$JUNIE_SEED"
node "$JUNIE_SEED" --remove
magpie junie default
```

`--remove` removes generated profiles and restores unchanged settings using
`~/.junie/magpie/seed-state.json`. Unrelated settings, native profiles and
new discovery folders remain. ECO cleanup deletes only the generated models'
preference entries, preserving later edits to native models across repeated seeds.
Run one seed command at a time, with Junie
closed, to avoid concurrent settings writes. The journal and generated
profiles contain gateway credentials and are created with private permissions.

Magpie restores the separate connection file's managed keys when disconnected.
That file is not a model profile and does not appear in Junie's picker.
Disconnecting Magpie alone leaves the seeded profiles and discovery directory
installed. Run `seed.mjs --remove` first to remove them and restore the launch settings.

## ECO mode and limitations

`--eco on|off` saves per-model preferences in `ecoModePerModel` and
`acpEcoModePerModel`, preserving other models' preferences. Without this
option, existing preferences are kept and new profiles get an `on` preference.

**Native ECO is unavailable for custom profiles in Junie 3893.6.** Saving
`on` does not enable it, and it is not equivalent to lowering reasoning
effort. In that build, `ModelOption.Custom` inherits an empty
`ecoModeEfforts` set, so the ECO availability gate rejects it. The ACP model
picker confirms that a custom model has no ECO option. This is a Junie
capability limit, not a setting the plugin can override.

The agent module uses Junie's default `~/.junie` paths, including Library
instructions, MCP and skills. The seed script honors `JUNIE_HOME`; when
using a relocated Junie home, provide its `magpie/connection.json` first.
Project configuration and CLI flags can override user defaults. Keep Magpie
running while using the generated models.

## Validation

```sh
bun test packages/junie/junie.test.mjs
```

References: [custom models](https://junie.jetbrains.com/docs/custom-llm-models.html),
[configuration](https://junie.jetbrains.com/docs/junie-cli-configuration.html),
[Cowork seed](../cowork/seed.mjs), and the
[agent contract](https://github.com/yetone/magpie/blob/main/internal/agent/plugged.go).
The agent uses the [official Junie website icon](https://junie.jetbrains.com/favicons/favicon.svg).
