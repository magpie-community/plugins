# @magpie-community/agent-willdeep-cli

[WillDeep CLI](https://github.com/niuwoai/willdeep-rs) as a magpie agent.
magpie has no setup of its own for WillDeep CLI; with this plugin its new
sessions run on a magpie model and keep their own Profile and approval
settings.

```sh
magpie plugin add @magpie-community/agent-willdeep-cli
```

Install WillDeep CLI 0.142.0-rc1 or later and make sure magpie's process
can find the `willdeep` command on its `PATH`. Open the CLI or its TUI
once so it creates its private support directory. Then enable the plugin
and pick one of magpie's models in WillDeep CLI's row. magpie writes:

```json
{
  "schema_version": 1,
  "client_id": "willdeep-cli",
  "enabled": true,
  "base_url": "http://127.0.0.1:3425/v1",
  "client_marker": "magpie-willdeep-cli",
  "context_window": null,
  "max_output_tokens": null
}
```

to `~/.willdeep/integrations/magpie/cli/connection.json`. The full magpie
model id goes into `model`, prefixes included. Only new sessions without
an explicit Profile or model choice use the connection; existing sessions
keep theirs. Explicit approvals, sandbox and Worker settings still follow
the client's own rules.

Switching WillDeep CLI off in magpie, or running
`magpie willdeep-cli default`, puts the managed fields back. An empty
object, or one with only `model`, means disconnected; a model alone is
never used as the client's default. A task already running is not
cancelled. The CLI's TOML and Desktop's provider library and Keychain are
not edited.

The plugin uses only the standard home. With a custom `WILLDEEP_HOME`,
install a local copy whose `config` points at the matching absolute path;
the plugin expands `~` and `$VAR`, not `${VAR:-default}`. Disconnect the
old target before switching copies, so the old path cannot keep a live
connection.

Only a loopback `http://` / `https://` gateway with the exact `/v1` path
is accepted, and `gateway.key` must be the public marker
`magpie-willdeep-cli`. Real gateway keys and remote or shared gateways are
refused in this version. Unknown or invalid context and output values
become `null`; the plugin does not invent a window or output limit. It
does not read or write files, use the network, or start processes: magpie
writes the file.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
