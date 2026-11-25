# magpie-agent-musepi

MusePi as an agent on magpie's Agents page: pick one of magpie's models for it,
and switch it off to put MusePi's own config back.

把 MusePi 加到 magpie 的 Agent 页：选一个 magpie 的模型，关掉即恢复原有配置。

## Install

```sh
magpie plugin add github:MuseLinn/magpie-agent-musepi
```

Then connect MusePi on the Agents page and pick a model. Over the app:
Settings → Plugins → add the same address.

## What it writes

- `~/.musepi/agent/models.yml` — provider `magpie`: the gateway's address, the
  key magpie keeps for MusePi, and magpie's catalog as that provider's models
  (window, output budget, per-million price, image input, thinking ladder, and
  the API magpie relays each model on). Also
  `compat.promptCacheSessionHeader: x-session-affinity`, which keeps a
  conversation on the upstream that already holds its cached prefix: the same
  session read 8–13% of its prompt from cache without it and 80% with it.
- `~/.musepi/agent/config.yml` — `modelRoles.default`, the model a new session
  starts on, as `magpie/<provider>/<model>`.

Disconnect puts back what those files had; an empty table magpie made stays.

## Notes

- **Default folder only.** A named profile (`MUSEPI_HOME`, `MUSEPI_PROFILE`),
  `PI_CONFIG_DIR`, or a Linux XDG data root moves MusePi's files, and magpie
  would write where MusePi does not look.
- **MusePi 0.7.7 and earlier reject this provider set.** `models.yml` is
  validated exactly, so `promptCacheSessionHeader` fails the whole file — every
  provider in it disappears. Update MusePi, or delete that line; the only thing
  lost is the session pinning.
- **The model list is a snapshot** of magpie's catalog when the agent last
  connected. MusePi re-reads `models.yml` when its model menu opens; older
  builds read it at session start.
- MusePi's own models stay one click away in the row's picker — every model
  `models.yml` declares under another provider, not its bundled providers.
- The thinking level on magpie's row is asked at the gateway and writes
  nothing to MusePi's files; the session's own level, `auto` included, stays.
- Each model is written with the API magpie relays it on; a model relayed only
  on Chat cannot carry Claude's thinking between tool turns.
- Image input is written when magpie knows the model takes images; video is
  left to MusePi's own inference, and image generation is not wired.
- **Older magpie (0.1.4295)** removed `modelRoles.default` on disconnect;
  current builds restore it.

## Develop

```sh
node --test "test/*.test.mjs"
magpie plugin add .       # connect it from the folder itself
```

## Publish

The repository needs the `magpie-plugin` topic for magpie to list it under
Plugins → Discover → Unofficial. Design notes are in `docs/design.md`, verified
runs in `VERIFICATION.md`.

On npm as `@musepi/magpie-agent-musepi`:

```sh
magpie plugin add npm:@musepi/magpie-agent-musepi
```

The GitHub address above works without it.
