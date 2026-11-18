# magpie-agent-musepi

MusePi ([musepi](https://github.com/)) as an agent on magpie's Agents page:
pick one of magpie's models for it, and switch it off to put its config back.

把 MusePi 加到 magpie 的 Agents 页：给它选 magpie 的模型，关掉即恢复原来的配置。

## Install

```sh
magpie plugin add github:MuseLinn/magpie-agent-musepi
```

Then connect MusePi on magpie's Agents page and pick a model. A new MusePi
session uses it.

Over the window: Settings → Plugins → add the same address.

## What it writes

magpie edits two files under MusePi's default agent folder:

- `~/.musepi/agent/models.yml` — its provider `magpie` (the gateway's
  address, the key magpie keeps for MusePi, and magpie's catalog as that
  provider's models). Each model carries its window, output budget,
  magpie's per-million price, image input when magpie knows it takes one,
  and the thinking ladder magpie reports (`thinking.efforts` on Chat and
  Responses; Anthropic keeps `reasoning` alone so MusePi picks its own
  adaptive/budget shape);
- `~/.musepi/agent/config.yml` — `modelRoles.default`, the model a new
  session starts on, as `magpie/<provider>/<model>`.

Disconnect puts back what those files had. An empty table magpie made
(`providers: {}`, `modelRoles: {}`) stays, as magpie leaves it for every
agent.

## On magpie's row

The model list offers MusePi's own models too: every model `models.yml`
declares under a provider other than `magpie` appears as a direct pick, so
switching back from magpie is one click there. Picking one writes
`modelRoles.default` without magpie's prefix, and MusePi asks that provider
with its own key (magpie shows it as not through magpie). A provider's
`label` names it in that list; without one its id does.

Only what `models.yml` declares is visible: MusePi's bundled providers (a
signed-in Anthropic, Copilot, …) live in its own catalog, not that file, so
only the model MusePi is currently on is carried as the current value.

## Limits

- **Only the default folder is wired.** A named profile (`MUSEPI_HOME`,
  `MUSEPI_PROFILE`), `PI_CONFIG_DIR`, or a Linux XDG data root moves
  MusePi's files; magpie's `agent.config` is one fixed path, so it would
  write where MusePi does not look. Start MusePi on its default folder, or
  wait for the multi-folder support.
- **Back up `modelRoles.default` before connecting (magpie 0.1.4295).**
  Disconnecting removes that role instead of restoring it: magpie's
  `connect.was` stash records a `model` key that a `startup` agent does not
  have. The other roles are untouched. Verified 2026-11-17; see
  `VERIFICATION.md`.
- **The model list is magpie's.** MusePi shows what magpie's catalog had
  when the agent last connected. Current MusePi re-reads `models.yml` when its
  model menu opens, so a re-connect shows up there; a build from before that
  reads it at session start, so start a new session.
- **A failing model may fall back silently.** MusePi resolves an unavailable
  model to another one it can reach, so a reply can arrive from a model you
  did not pick. Check magpie's Usage page when a model's answer looks wrong.
- **Thinking level.** magpie's row offers a thinking level (none → max) that
  magpie asks the gateway for on the way out; it writes nothing to MusePi's
  files. MusePi's own per-session level, including its `auto`, stays yours and
  is not overridden by this field.
- **Thinking signatures.** Each model is written with the API magpie relays
  it on (`anthropic-messages`, `openai-responses`, or `openai-completions`).
  A model relayed only on Chat cannot carry Claude's thinking between tool
  turns; magpie reports `native_endpoints` per model and this plugin follows
  them.
- **Video input is left to MusePi.** MusePi takes `text`, `image` and `video`,
  but magpie's plugin facts only say whether a model takes images. The plugin
  writes `image` when magpie knows it; it cannot write `video` without taking
  the guess away from MusePi, so a video-capable model keeps MusePi's own
  id-based inference.
- **Image generation is not wired.** magpie's `connect` lists chat models
  only; image models (`/v1/images/generations`) are a separate set the plugin
  contract does not carry, and MusePi's `models.yml` has no image API. Drawing
  goes through MusePi's own image providers.

## Design

`docs/design.md` is why this plugin exists and what magpie's agent contract
allows; `docs/plan.md` is the task list it was built from, with the verified
results recorded in `VERIFICATION.md`.

## Develop

```sh
node --test "test/*.test.mjs"
magpie plugin add .       # connect it from the folder itself
```

## Publishing

A GitHub repository needs the **`magpie-plugin`** topic for magpie to list
it under Plugins → Discover → Unofficial (searched every 10 minutes, no
review, sorted by stars). Being in the community's `registry.json`
(`magpie-community/plugins`) is a further step: it makes the plugin
installable by short name and suggested as an agent.

Neither is needed to install it: `magpie plugin add github:MuseLinn/magpie-agent-musepi`
works regardless. Published on npm too:

```sh
magpie plugin add npm:@musepi/magpie-agent-musepi
```
