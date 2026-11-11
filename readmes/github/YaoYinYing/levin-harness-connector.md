# levin-harness-connector

A [magpie](https://usemagpie.ai) **agent plugin**: Levin Harness becomes its own row on
magpie's **Agents** page, with Levin Harness's name, Levin Harness's icon, and its
usage counted under its own name.

## Why it is needed

magpie credits a request to an agent by the key it carries, and only falls
back to the first word of `User-Agent` when there is none. Levin Harness is
built on the pi SDK, so its requests carry `User-Agent: pi/1.4.0 (darwin;
node/…; arm64)` — magpie sees `pi`, and Levin Harness's calls land in pi's
usage, pi's request ledger and pi's routing rules. (Verified against this
machine's `~/.config/magpie/usage.jsonl`: 298 of 300 recent rows said
`"agent":"pi"`.)

magpie's own rule: a request with `Authorization: Bearer magpie-levin-harness` is
recorded as `levin-harness`. This plugin points one of Levin Harness's model
entries at magpie's gateway with exactly that key, and declares an agent
(`id: "levin-harness"`) so magpie's Agents page, model picker and usage page
have a row, a name and an icon for it.

## Install

magpie installed from a **.dmg** is an app: its command line lives at
`/Applications/magpie.app/Contents/MacOS/magpie` and `magpie` is usually **not
on PATH**. The script below finds it there, so plain shell commands are enough.

```sh
curl -fsSL https://raw.githubusercontent.com/YaoYinYing/levin-harness-connector/main/install.sh | sh
```

It:

1. finds magpie on PATH, then in `/Applications/magpie.app` and `~/Applications/magpie.app`
   (override with `MAGPIE=/path/to/magpie.app/Contents/MacOS/magpie`);
2. runs `plugin add github:YaoYinYing/levin-harness-connector`;
3. finds the copy magpie just installed under `~/.config/magpie/plugins/node_modules/`;
4. pins the Levin Harness model entry magpie may write, by its id;
5. turns the plugin off and on so the new pin is read.

Run it again any time — it only re-pins.

| flag | what it does |
| --- | --- |
| `--link` | also symlinks `~/.local/bin/magpie` → the app's own binary, so `magpie …` works in a shell |
| `--create` | no usable entry yet: append one to Levin Harness's config first (**quit Levin Harness**), keeping a `config.json.bak-…` |
| `--list` | print Levin Harness's model entries and their ids, then stop |

Two loose ends worth knowing:

- With `curl … | sh` a flag goes to the script like this:
  `curl -fsSL …/install.sh | sh -s -- --link`.
- If `~/.local/bin` is not on your PATH, add it (`export PATH="$HOME/.local/bin:$PATH"`
  in `~/.zshrc`) to use plain `magpie` afterwards. magpie's own app never needs this.

### The plain-`magpie` alternative

The app window can add the plugin without any shell: **Plugins → add plugin**,
paste

```
https://github.com/YaoYinYing/levin-harness-connector
```

The pin still needs a terminal (only Node can read Levin Harness's `config.json`):

```sh
node ~/.config/magpie/plugins/node_modules/levin-harness-connector/tools/pin-slot.mjs
/Applications/magpie.app/Contents/MacOS/magpie plugin off levin-harness-connector
/Applications/magpie.app/Contents/MacOS/magpie plugin on levin-harness-connector
```

Then, in the **magpie window** → *Agents* → the Levin Harness row → pick a model.
Levin Harness reads its model when a session starts, so send the next message or open
a new chat.

Why the pin needs a normal shell: it reads and writes Levin Harness's `config.json`, which
macOS protects. Run it from Terminal (with Full Disk Access if it asks), not
from inside an app sandbox.

### By hand

```sh
git clone https://github.com/YaoYinYing/levin-harness-connector.git
cd levin-harness-connector
MAGPIE=/Applications/magpie.app/Contents/MacOS/magpie
"$MAGPIE" plugin add .
node tools/pin-slot.mjs          # --list first, if you want to see the entries
```

or, without cloning, add the GitHub link in the app (*Plugins → add plugin*) and run
`node tools/pin-slot.mjs` inside the installed copy at
`~/.config/magpie/plugins/node_modules/levin-harness-connector`.

Disconnect: pick Levin Harness's previous model in that row, or

```sh
magpie levin-harness-connector default        # /Applications/magpie.app/Contents/MacOS/magpie …
```

Levin Harness's `config.json` comes back byte for byte (magpie stashes each key it wrote;
verified in a sandbox).

## Why `pin-slot` exists

magpie's agent plugins run in `moejs` inside magpie's own process — no Node, no
`fs`, no `process.env` — and they may write **only key paths that already
exist** in a JSON file (`internal/edit`: a gjson path that matches is replaced
in place, one that does not is created).

Levin Harness keeps its models in an array, `llmConfigs`. Measured on magpie
0.1.3686, an agent plugin writing to a non-existent position is destructive:

| the plugin writes | the file becomes |
| --- | --- |
| `llmConfigs.0.model` (array has ≥1 entry) | fine |
| `llmConfigs.<index>.model` (index too big) | `"llmConfigs": {"<index>": {…}}` — **every model gone** |
| `llmConfigs.#(id=="missing").model` | `"llmConfigs": {"#(id==\"missing\")": {…}}` — **every model gone** |

So the plugin never adds anything: it writes one entry that exists, addressed
by its own `id`, which Levin Harness keeps when models are reordered:

```js
llmConfigs.#(id=="<uuid>").model
```

`tools/pin-slot.mjs` puts that id into `slot.js`, and checks it is really in
`config.json` before writing it — a typo cannot reach magpie. With
`ENTRY_ID = null` (the state of this repository) `agent.js` throws and magpie
loads nothing, so a fresh clone cannot damage a config either.

| command | what it does |
| --- | --- |
| `node tools/pin-slot.mjs` | pin the entry that points at `localhost:3425` (magpie's gateway) |
| `--list` | print the entries: index, id, name, model |
| `--id <uuid>` | pin one entry by id |
| `--create` | append such an entry to `config.json` first (Levin closed), then pin it |
| `--config <path>` | read another `config.json` (tests, a copy) |
| `--dry-run` | say what it would do, write nothing |

`--create` appends textually: it finds the array's closing bracket, inserts one
member, and leaves every other byte — comments, key order, indentation — as it
was, with a `config.json.bak-<timestamp>` copy beside it.

Re-pin after deleting that model in Levin Harness, or after installing on another
machine.

## What it writes

On connect, into the pinned entry:

| key | value |
| --- | --- |
| `name` | `Levin Harness` (magpie restores the old name on disconnect) |
| `api` | `openai-responses` |
| `baseUrl` | magpie's gateway, e.g. `http://localhost:3425/v1` |
| `apiKey` | `magpie-levin-harness` |
| `model` | magpie's model id, e.g. `group/superman` |
| `contextWindow`, `maxTokens`, `supportsImageInput` | only when magpie knows them for that model |

Nothing else in the file is touched; `isDefault`, other providers and
`mcpServers` stay as they were.

## Icon

`icon-data.js` holds Levin Harness's app icon (128 px PNG) as a `data:` URI, which
`agent.icon` references. magpie decodes it once into
`~/.config/magpie/icons/<hash>.png` and uses it on the agent row, in its model
picker and on the usage page. `icon.png` is the same picture, for the README
and for the GitHub repository card.

The icon is Levin Harness's application icon and belongs to Levin Harness; it is
here only to label Levin Harness's own row, as other magpie agents do. Swap it for
your own picture if you publish a fork.

## Limitations

- **The request's own User-Agent stays `pi/…`.** magpie routes and attributes by
  the key first, so usage, the request ledger and routing rules say
  `levin-harness`; a vendor or a gateway middleware that looks at `User-Agent`
  directly still sees pi. Removing that string for good is a change in Levin Harness,
  not in a plugin.
- **`name` is written, `isDefault` is not.** magpie does not choose which of
  Levin Harness's entries is default; it only fills the one row you picked the
  model for.
- **One entry, and it must exist.** Deleting that model in Levin Harness leaves
  the plugin pointing at a missing id, which is exactly the destructive case —
  re-pin. `agent.js` guards the "never pinned" case, not the "pinned, then
  deleted" one: `node tools/pin-slot.mjs` after deleting.
- **Levin Harness reads its model at session start**, so an open chat keeps the
  model it began with.

## Verified

Sandboxed magpie 0.1.3686 against a copy of a real config (array of model
entries, another provider, `mcpServers`), from this repository's own files:

- No pin → `agent plugin … didn't load: … no model entry pinned yet`;
  `magpie ls` has no Levin Harness row; `config.json` unchanged.
- `node tools/pin-slot.mjs --list` prints index, id, name, model for every entry; the
  pin picks the entry that points at `localhost:3425` and writes its id to
  `slot.js` only.
- `magpie levin-harness magpie/lab/mm1` → the pinned entry gets
  `name`/`api`/`baseUrl`/`apiKey`/`model`; `llmConfigs` is still an array of 3;
  the other two entries and `mcpServers` untouched.
- Switch model → disconnect (`magpie levin-harness default`) → `diff` against
  the file before connecting: empty.
- `--create` on a 2-entry array → 3 entries, still an array, other bytes
  identical, `config.json.bak-<timestamp>` written.
- Icon: the `data:` URI is decoded once to
  `~/.config/magpie/icons/05565db4c1c2acb6.png`.
- Attribution: `POST /v1/chat/completions` with
  `Authorization: Bearer magpie-levin-harness` and `User-Agent: pi/1.4.0 …` produces
  `"agent":"levin-harness"` in `usage.jsonl`.

## License

MIT — see [LICENSE](LICENSE).
