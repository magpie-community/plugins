# Magpie agent plugin for Eta

![Eta](./icon.svg)

Use Magpie's models and routing groups in Eta's existing model picker, without rebuilding Magpie or configuring an address or key in Eta.

## Install and use

Requires [Eta 0.1.164 or later](https://github.com/Lingwcy/eta/releases/tag/v0.1.164) and an official Magpie version supporting agent plugins (`magpie.agent`). Tested against the unmodified host at **v0.1.3233**; the earliest compatible release has not been established.

1. Keep this plugin in a permanent folder. In Magpie's Plugins page, add its absolute folder path (not the individual module). This lets Magpie read the **Eta** display name, icon and bilingual summary from the package. Alternatively, run:

   ```sh
   magpie plugin add /absolute/path/to/magpie-agent-eta
   ```

   In a checkout of the community plugins repository, the folder is `packages/eta`. No Node runtime, build step, source patch or external setup tool is needed. Local plugins reference their files in place: do not delete or move the installed folder.

   Once published and listed, the package is `@magpie-community/agent-eta`, displayed as **Eta** under Plugins → Discover → Agents. The community release workflow distributes it after review and merge.

   If you previously imported `eta.agent.mjs` alone, disconnect Eta and remove that single-file plugin entry before adding the package folder; do not install both at once. Standalone files still work, but the installed-plugin row cannot read their package name or summary and may show the filename instead.

2. In Magpie's Agents page, connect **Eta** to Magpie and choose which models and routing groups Eta may see. Installing the plugin exposes the Eta entry even before Eta's first launch; it does not automatically connect it.
3. Keep Magpie running on the same computer. Fully quit and reopen Eta, then select a model from the **Magpie** group. Your current selection, direct providers and saved conversations are unchanged.

After changing model visibility, restart Eta to reload its catalog. After changing the gateway port, reapply Eta's Magpie provider in Magpie before restarting Eta: the tested host does not automatically rewrite this plugin's gateway address on every port change.

## Disconnect or remove

Disconnect Eta on Magpie's Agents page, or disable/remove this plugin on its Plugins page, then restart Eta. Magpie restores the previous values of the integration keys and retains unrelated fields. If there were no previous values, it may leave an empty JSON object; Eta treats that as disconnected. Re-enabling the plugin does not silently reconnect Eta: connect it again in Magpie.

The host identifies ownership by the gateway key. Replacing the key yourself makes the connection yours and prevents automatic restoration. Changes to Magpie-managed fields while retaining its key may be overwritten by synchronization or restoration; keep custom settings outside those fields. Existing Eta credentials are never edited.

## Configuration and limits

Magpie writes `~/.config/eta/magpie.json` on all platforms. Eta prefers this stable plugin path; only when it is absent does it read the older `$XDG_CONFIG_HOME/eta/magpie.json` location. Do not delete the restored object if you still have an old XDG configuration you do not want to reactivate.

The versioned contract is:

```json
{ "version": 1, "baseUrl": "http://127.0.0.1:3425", "apiKey": "magpie-eta" }
```

The address and key are examples; the plugin uses Magpie's configured origin and Eta-scoped gateway key. Eta fetches the visible catalog from `/v1/models` rather than copying model lists into this file, and calls OpenAI Chat Completions through Magpie. Route IDs stay intact.

Only same-machine HTTP loopback gateways are supported, not remote gateways or WSL routing. A missing/unavailable Magpie does not silently switch Eta to a direct provider. This plugin does not configure remote Bots. Native desktop interaction and paid upstream model acceptance have not been verified by the automated host tests.

## License

MIT.
