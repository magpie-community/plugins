# magpie-agent-mycode

A [magpie](https://usemagpie.ai) **agent plugin** for
[MYCode](https://github.com/MCapricorns/mycode). It adds MYCode to magpie's
Agents page and writes the gateway binding into `~/.mycode/settings.json`, so
MYCode runs every turn through magpie.

## Install

```sh
magpie plugin add github:MCapricorns/magpie-mycode
```

Or open **Plugins → Add a plugin** in the magpie app and paste the same
`github:MCapricorns/magpie-mycode` value.

Then open **Agents**, pick **MYCode**, and pick a model. MYCode reads the
binding when a session starts, so start a new session after switching.

Remove it with `magpie plugin rm magpie-agent-mycode`; that disconnects MYCode
and restores the keys it had before.

## What magpie writes

| Key | Value |
| --- | --- |
| `magpie.enabled` | `true` while magpie serves the model |
| `magpie.baseUrl` | the gateway, ending in `/v1` (`http://127.0.0.1:3425/v1`) |
| `magpie.apiKey` | the key magpie made for MYCode (`magpie-mycode`) |
| `magpie.model` | the model picked in magpie (`provider/model`) |

Nothing else in `settings.json` is touched. Picking MYCode's own model again (or
switching the row off) restores the three keys and removes `magpie.model`.

## About `settings.json`

MYCode reads the file as a **strict** document:

- The `formatVersion`, `kind` and `revision` keys are part of the format.
  magpie's surgical edit keeps them; a hand-written replacement must too.
- Keys MYCode's build does not know — `providers`, `web` from older versions —
  make the file read as damaged. MYCode then repairs it on the next start:
  the previous bytes are kept beside it as `settings.json.broken-<nanos>` and
  everything it still understands (including the whole `magpie` block) is
  salvaged into the rewritten file. The retired keys are dropped.
- MYCode owns the file's permissions (owner-only, protected DACL on Windows).
  An external editor that replaces the file wholesale changes the ACL; MYCode
  re-protects the file when it next republishes, without losing the `magpie`
  block.

## What magpie's Library writes

Because the plugin declares `library`, MYCode also accepts magpie's Library:

| Library item | File |
| --- | --- |
| Instructions / rules | `~/.mycode/AGENTS.md` |
| MCP servers | `~/.mycode/mcp.json` (`{"mcpServers": {…}}`) |
| Skills | `~/.mycode/skills/<name>/SKILL.md` |

That is how web search reaches the model: magpie adds its `anysearch` MCP
server, and MYCode has no built-in search of its own.

## How magpie finds it

The repository is tagged
[`magpie-plugin`](https://github.com/topics/magpie-plugin), which puts it under
**Plugins → Discover → Unofficial**, and `package.json` at the root says what
it is:

```json
{
  "name": "magpie-agent-mycode",
  "magpie": {
    "agent": "./agent.js",
    "icon": "data:image/svg+xml;base64,…"
  }
}
```

- `magpie.agent` names the module whose `agent` export describes MYCode.
- `magpie.icon` is the card's picture, a `data:image/…` URI or an `https://`
  URL; `icon.svg` here is the same mark, taken from MYCode's own logo.
- There is no `main` and no `exports`: an agent-only package, so magpie lists
  it under Agents instead of as a provider plugin, and `agent.js` is what it
  loads. (Published to npm from here, the same fields would still apply.)

The agent row's picture comes from `icon` in `agent.js` itself, which is the
same data URI, so the row has it without magpie's market having answered yet.

## Requirements

- MYCode on `PATH` as `mycode`, or `~/.mycode` present.
- magpie running: the app, `magpie tray`, or `magpie serve`.

## Layout

```text
agent.js        the agent declaration and connect()
icon.svg        MYCode's mark, as the source of the inlined data URI
package.json    "magpie": { "agent": "./agent.js", "icon": "data:image/…" }
LICENSE         Apache-2.0
```

## License

Apache-2.0. See [LICENSE](LICENSE).
