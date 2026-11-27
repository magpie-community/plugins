# levin-harness-connector

English | [简体中文](README.zh-CN.md)

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

**Do not install this plugin from magpie's own plugin browser.** magpie's
*Plugins -> add plugin* installs the package and stops there: the agent module
refuses to load until `slot.js` has been pinned, and magpie has no way to run
the pin. The result is a plugin listed as installed, an error in
`magpie plugin` ("didn't load: not pinned yet") and no Levin row on the Agents
page. The installers below do the missing step. There is one script per
platform, because that step needs a filesystem and magpie's plugin runtime does
not have one.

Levin Harness ships for macOS, Windows and Linux. Each installer adds the plugin
to magpie, finds the copy magpie installed, pins which of Levin Harness's model
entries magpie may write, and reloads the plugin. Running it again only re-pins.

### macOS

magpie from a **.dmg** is an app: its command line is
`/Applications/magpie.app/Contents/MacOS/magpie`, and `magpie` is usually **not** on
PATH. The script looks there itself, so no setup is needed first.

```sh
curl -fsSL https://raw.githubusercontent.com/YaoYinYing/levin-harness-connector/main/install.sh | sh
```

Needs Node.js 18+ (`node --version`). Run it in Terminal, not inside another
app's sandbox: macOS blocks a sandboxed process from reading Levin Harness's
`config.json`.

### Windows

Lévin Harness has a Windows build: the GitHub releases carry
`Levin-Harness-<version>-x64.exe` next to the arm64 `.dmg`. Install that first,
then run the script below — it has **not** been run on a real Windows machine
yet, so treat it as reviewed-but-unproven.

magpie on Windows is `magpie.exe` (the app) or `magpie-cli.exe` (the command line
build). Neither is on PATH unless you put it there, so the script looks in the
usual places and in your Downloads folder.

In **PowerShell**:

```powershell
irm https://raw.githubusercontent.com/YaoYinYing/levin-harness-connector/main/install.ps1 | iex
```

Because the one-liner runs with `iex`, flags are not available; clone once if you
want `-Create`, `-List`, `-Link`, `-Spec` or `-Magpie`:

```powershell
git clone https://github.com/YaoYinYing/levin-harness-connector.git
cd levin-harness-connector
powershell -ExecutionPolicy Bypass -File .\install.ps1 -List        # see the entries
powershell -ExecutionPolicy Bypass -File .\install.ps1             # pin one
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Create     # make one first, Levin closed
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Link       # + a `magpie` command
```

Where it looks for magpie: PATH, then `%LOCALAPPDATA%\Programs\magpie\`,
`%LOCALAPPDATA%\magpie\`, `%ProgramFiles%\magpie\`, `%ProgramFiles(x86)%\magpie\`,
`%USERPROFILE%\magpie\`, and the release downloads in `%USERPROFILE%\Downloads\`.
Point it somewhere else with `-Magpie "C:\path\to\magpie.exe"`.

Levin Harness keeps its config at `%APPDATA%\levin-harness\config.json`; `pin-slot.mjs` looks
there because the Windows `node.exe` reports `platform === "win32"`. Run the pin
from **PowerShell** (or cmd) with the Windows Node — from Git Bash it also works,
since Node still reports win32, but not through a WSL `node`, which reports
linux. If magpie runs on Windows, use the Windows script: WSL is a separate
machine to magpie.

`-Link` writes `%LOCALAPPDATA%\Microsoft\WindowsApps\magpie.cmd`, which is already on
PATH: no new folder to add, and it survives moving `magpie.exe`.

### Linux

Levin Harness publishes Linux packages: `Levin-Harness-<version>-amd64.deb`,
`.rpm` and an AppImage (plus arm64 builds) on its GitHub releases. Install one,
run it once so it writes `~/.config/levin-harness/config.json`, then:

```sh
curl -fsSL https://raw.githubusercontent.com/YaoYinYing/levin-harness-connector/main/install.sh | sh
```

Magpie's command line on Linux is the `magpie-cli-linux-amd64` release asset;
either put it on PATH as `magpie`/`magpie-cli`, drop it in `~/.local/bin`, or pass
`MAGPIE=/path/to/magpie-cli`.

This path is tested end to end on a real Debian 13 x86_64 machine (see
[Verified](#verified)): a headless Levin Harness was started under `xvfb-run`, its
config was created, the installer added the plugin and pinned the entry, and
connect / switch-model / disconnect round-tripped with the config restored byte
for byte.

WSL counts as Linux here. If magpie runs on Windows, a Levin inside WSL is a
different install from the one magpie sees, so keep both on the same side.

### What the installers pass on

| flag (`install.sh`) | flag (`install.ps1`) | what it does |
| --- | --- | --- |
| `--link` | `-Link` | put a `magpie` command on PATH (`~/.local/bin` on macOS/Linux, `WindowsApps` on Windows) |
| `--create` | `-Create` | no usable entry yet: append one to Levin Harness's config first (**quit Levin Harness**), keeping a `config.json.bak-…` |
| `--list` | `-List` | print Levin Harness's model entries and their ids, then stop |
| `--dry-run` | — | say what the pin would write, change nothing |
| `MAGPIE=…` | `-Magpie …` | where magpie lives, if it is not in a usual place |
| `SPEC=…` | `-Spec …` | install from another repo or a local folder |

With `curl … | sh` a flag goes to the script like this:
`curl -fsSL …/install.sh | sh -s -- --link`.

### Where each side keeps its files

| | Lévin build | Lévin's `config.json` | magpie's plugins |
| --- | --- | --- | --- |
| macOS | arm64 `.dmg` | `~/Library/Application Support/Levin/config.json` | `~/.config/magpie/plugins/node_modules/` |
| Windows | `x64.exe` | `%APPDATA%\levin-harness\config.json` (unverified on Windows) | `%USERPROFILE%\.config\magpie\plugins\node_modules\` |
| Linux | `amd64.deb`, `.rpm`, AppImage | `~/.config/levin-harness/config.json` (**verified**, Debian 13) | `~/.config/magpie/plugins/node_modules/` |

On every platform `$LEVIN_HARNESS_CONFIG_DIR/config.json` wins if it is set (Levin Harness
honours it too), and `pin-slot.mjs --config <path>` overrides everything. When it
cannot find the file, it prints every path it tried.

### Then, in the app

**magpie → Agents → the Levin Harness row → pick a model.** Levin Harness reads its
model when a session starts, so send the next message or open a new chat.

Undo: pick Levin Harness's previous model in that row, or

```sh
magpie levin-harness default
```

Levin Harness's `config.json` comes back byte for byte (magpie stashes each key it
wrote; verified in a sandbox). On Windows use the full
`"$env:LOCALAPPDATA\Programs\magpie\magpie.exe" levin-harness-connector default`,
or the `-Link` shim `magpie levin-harness default`.

### If you must do it by hand

Only for debugging an install. Adding the plugin in magpie's UI is not enough
(see above), so the steps are exactly what the installer runs:

```sh
magpie plugin add github:YaoYinYing/levin-harness-connector
node ~/.config/magpie/plugins/node_modules/levin-harness-connector/tools/pin-slot.mjs
magpie plugin off levin-harness-connector
magpie plugin on  levin-harness-connector
```

On Windows the plugin folder is
`%USERPROFILE%\.config\magpie\plugins\node_modules\levin-harness-connector` and
`magpie` is `magpie.exe`.

Mind the two names magpie uses. The **package** name, `levin-harness-connector`,
is what `plugin add/off/on/list` take. The **agent** id, `levin-harness`, is what
model selection takes:

```sh
magpie levin-harness group/superman     # pick a model for this agent
magpie levin-harness                    # show it
magpie levin-harness default            # disconnect, restore Levin Harness's config
```

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

Real Linux machine, not emulation: Debian 13 (trixie) x86_64, Levin 2.1123.1
(`amd64.deb`, unpacked with `dpkg-deb -x`, started under `xvfb-run`), magpie
0.1.3830 (`magpie-cli-linux-amd64`):

- Levin created `~/.config/levin-harness/config.json` holding `llmConfigs: []`,
  i.e. the fresh-install case the installer has to handle.
- `sh install.sh --create` appended one entry at `llmConfigs[0]`, kept the array a
  JSON array, wrote a `.bak-<timestamp>`, pinned
  `CONFIG = ~/.config/levin-harness/config.json` plus the entry id into `slot.js`,
  and reloaded the plugin. `magpie ls` then listed the agent row.
- `magpie levin-harness magpie/lab/mm1` wrote `api`/`baseUrl`/`apiKey`/`model`
  into that entry with the array intact; `... mm2` changed only the model;
  `magpie levin-harness default` left the file identical to a copy taken before
  connecting (`diff` empty).
- The CLI takes the agent id, `levin-harness`, for model commands, and the package
  name, `levin-harness-connector`, for `plugin` commands; the wrong one just
  prints the list of known agent ids.


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
