# 100milionseek

A [magpie](https://usemagpie.ai) provider plugin for
[100milionseek](https://100milionseek.top) — the relay that gives every key a
free **DeepSeek V4.1 Flash** allowance of 100 million tokens a day.

What the plugin adds beyond a plain `providers.json` entry:

- **The daily allowance, read for real.** The service only ever reports what is
  left in `x-quota-*` response headers, so `usage` reads one response and turns
  it into the window magpie shows and routes on. Nothing is made up: when the
  numbers cannot be read, the window shows no percentage instead of 0%.
- **A working reset time.** When the day is spent the service answers 429
  without a `Retry-After`; the plugin writes one from the reset instant so the
  key sits out until 00:00 UTC rather than for magpie's default guess.
- **The judge model as a classifier.** `jev-1.13-free` is a System One model
  (`POST /v1/systemone`, one probability per question). The plugin rewrites its
  answer into the shape magpie reads, so it can route
  [routing groups](https://usemagpie.ai/docs/zh/plugins#decide).
- **Live load.** `/api/status` is polled every two minutes and the upstream's
  inflight/capacity ratio is reported per model, so *Settings › Models › Routing
  › busy models go later* can move work off a saturated relay.

## Install

```sh
magpie plugin add ./100milionseek
# or, once published: magpie plugin add 100milionseek
magpie plugin login hundred-milion-seek
```

Then pick `hundred-milion-seek/DeepSeek V4.1 Flash (free)` as an agent's model.

### Provider id

The plugin signs in to the provider id **`hundred-milion-seek`**, not
`100milionseek`, so it can sit beside a hand-written `100milionseek` provider in
`providers.json` without either one taking the other's id. Agents address it as
`hundred-milion-seek/<model>`.

If you would rather it took over an existing id, rename the hand-written
provider first, or sign in with `magpie plugin use` after adding both. Two
plugins claiming one id serve it one at a time — the chosen one, else the one
added last.

## Sign-in

One API key, from <https://100milionseek.top> (it starts with `hms-`). The key is
checked with `GET /v1/models` before it is saved:

- rejected by the service → the sign-in fails with the service's own words;
- service unreachable → the key is kept anyway, so a network blip cannot lock
  you out.

Keys are stored by magpie in `plugin-auth.json` under `hundred-milion-seek`, and
one key is one account: sign in again with a second key and it is kept as
`hundred-milion-seek#xxxxxx`, each with its own allowance and its own
concurrency slots. `magpie plugin logout hundred-milion-seek` forgets it.

## Models

| Model | What it is |
| --- | --- |
| `deepseek-v4.1-flash-free` | The chat model. 198K context, 64K output, streaming, tool calls, OpenAI-compatible. |
| `jev-1.13-free` | The judge. Answers `POST /v1/systemone` with a probability per question; hidden from agents, used only by routing groups. |

Both draw on the same daily allowance (the judge at 0.2 tokens per token asked).
The list is fixed rather than fetched, because the sizes and the judge's role
are not in `GET /v1/models`; when an account's listing names a model the plugin
does not know, it is described with the chat model's shape instead of dropped.

Five requests at a time per key, which is the service's own limit — the plugin
declares it as `maxConcurrency`, so magpie queues rather than collects 429s.

## What it does not do

No check-in: the service has no daily-claim endpoint (signing up is a mailbox and
a Cloudflare Turnstile), so there is no `checkin` hook. No sign-in state to
refresh either — an API key does not expire, and a 401 means the key was
revoked, which the plugin reports as `signIn: "expired"`.

## Layout

```
index.mjs          the entry magpie loads
opencode.mjs       the OpenCode 1.x face
opencode2.mjs      the OpenCode 2.x face (byte-identical to the community copy)
src/index.mjs      the plugin: config, auth, provider.models
src/models.mjs     the model table, in both the small and the full shape
src/quota.mjs      x-quota-* headers → a usage window
src/systemone.mjs  the judge's answer → the shape magpie reads
src/load.mjs       /api/status → a load percentage
test/              the tests, run by `npm test`
```

## Development

```sh
npm test          # every test, no network
npm run check     # syntax check + tests
```

The tests use a `fetch` double; nothing talks to the service. To try the real
thing without touching your own magpie:

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
      MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./100milionseek
m plugin --json
m plugin login hundred-milion-seek
m provider test hundred-milion-seek
m quota
```

## Licence

MIT.
