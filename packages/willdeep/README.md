# @magpie-community/agent-willdeep

[WillDeep Desktop](https://willdeep.com) as a magpie agent. magpie has no
setup of its own for WillDeep; with this plugin its new sessions run on a
magpie model while the app keeps its own Provider library.

```sh
magpie plugin add @magpie-community/agent-willdeep
```

Install WillDeep Desktop 1.428.0-rc2 or later and launch it once: the app
creates its private `~/.willdeep/integrations/magpie/desktop/` directory.
Then enable the plugin and pick one of magpie's models in WillDeep's row.
magpie writes:

```json
{
  "schema_version": 1,
  "client_id": "willdeep",
  "enabled": true,
  "base_url": "http://127.0.0.1:3425/v1",
  "client_marker": "magpie-willdeep",
  "context_window": null,
  "max_output_tokens": null
}
```

to `~/.willdeep/integrations/magpie/desktop/connection.json`. The full
magpie model id goes into `model`, prefixes included. Only new sessions
without an explicit Provider or model choice use the connection; existing
sessions keep theirs.

Switching WillDeep off in magpie, or running `magpie willdeep default`,
puts the managed fields back. An empty object, or one with only `model`,
means disconnected. A task already running is not cancelled.

Only a loopback `http://` / `https://` gateway with the exact `/v1` path
is accepted, and `gateway.key` must be the public marker
`magpie-willdeep`. Real gateway keys and remote or shared gateways are
refused in this version. Unknown or invalid context and output values
become `null`; the plugin does not invent a window or output limit. It
does not read or write files, use the network, or start processes:
magpie writes the file. Provider preferences, the Keychain and CLI TOML
are untouched.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
