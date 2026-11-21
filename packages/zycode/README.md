# @magpie-community/agent-zycode

[zycode](https://github.com/zy1233/pi-python) (the ACP agent `pi-agent-cli-lc`,
the terminal UI `zypi` and the VS Code extension `zycode.zycode`) as a magpie
agent. magpie has no setup of its own for zycode; with this plugin it is on
magpie's Agents page like the agents magpie ships with. Unofficial.

```sh
magpie plugin add @magpie-community/agent-zycode
```

Then pick one of magpie's models in zycode's row. zycode keeps its model in
the `[model]` table of `~/.pi-python/agent.toml` and its keys in
`~/.pi-python/local.env`. magpie edits `local.env`, and the host part of this
package copies the result into `[model]`, because magpie cannot edit TOML.

`~/.pi-python/local.env`, written by magpie:

```sh
MAGPIE_ZYCODE_MODEL=deepseek/deepseek-flash    # magpie's model
MAGPIE_ZYCODE_API_KEY=magpie-zycode            # zycode's own key, so Usage names it
MAGPIE_ZYCODE_BASE_URL=http://127.0.0.1:3425/v1
```

`~/.pi-python/agent.toml`, written by the host part:

```toml
[model]
provider = "openai"
id = "deepseek/deepseek-flash"
base_url = "http://127.0.0.1:3425/v1"
api_key_env = "MAGPIE_ZYCODE_API_KEY"
```

Only those four keys of `[model]` are set. `thinking_level`, `permission`,
`[[models]]`, comments and every other key stay as they are. If there is no
`agent.toml`, or it has no `[model]` table, one is made.

Picking zycode's own model again, or switching the plugin off or removing it,
puts `agent.toml` back as it was before: byte for byte when nobody changed it
meanwhile. If you or zycode (`--setup`) changed the file while it was
connected, only the lines magpie wrote are put back (or taken out), and your
change stays. The file as it was is kept in `~/.pi-python/.magpie-zycode.json`
(mode 0600) until then.

Restart zycode after a change: it reads `agent.toml` and `local.env` when it
starts. Its `/model` picker then lists the one model magpie set.

What it does not do:

- It writes `agent.toml` only when its `[model]` table is plain: a `model = {…}`
  inline table, `model.id = …` keys, `[model.x]` tables, a `[model]` key that
  spans several lines, or a symbolic link in place of `agent.toml` make it
  stop and change nothing. magpie's log then says once why:
  `zycode bridge paused, agent.toml left as it is: …`.
- It follows `~/.pi-python`. A `PI_HOME` that points elsewhere is not read.
- zycode's own thinking level is not touched: set `thinking_level` in
  `agent.toml` as before.
- zycode sends the OpenAI SDK's User-Agent, so Usage names its requests by the
  key `magpie-zycode`.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
