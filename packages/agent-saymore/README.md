# @magpie-community/agent-saymore

Select a [Magpie](https://usemagpie.ai) model for [Saymore](https://github.com/PraxisGrove/Saymore)'s existing text-polishing provider on macOS.

## Requirements — important

**This plugin requires a Saymore release that supports `integrations.magpie` configuration import. It is not supported by current Saymore releases.** The import interface is under development; this package does not bundle that native implementation.

The plugin itself only licenses and publishes the small Magpie Agent adapter under MIT. Saymore has its own source-available license.

A supported Saymore build must:

1. Preserve the `integrations` root object and any unrelated values it contains.
2. Import a valid `integrations.magpie` payload with `profile: "portable"` into a separate `magpie` text-polishing provider. That provider must not match an existing Custom provider merely because it has the same endpoint.
3. Consume the one-shot handoff without changing another provider or enabling text polishing.
4. Keep the imported settings when the provider is not active, and invalidate the currently active Magpie provider if a changed handoff arrives.

Without that application-side integration, the Magpie connection alone is not a usable text-polishing setup. Windows and Saymore development-profile paths are not supported by this initial package.

## Install after a compatible Saymore release is available

```bash
magpie plugin add @magpie-community/agent-saymore
```

For a local checkout of the community package repository:

```bash
magpie plugin add ./packages/agent-saymore
```

These commands change the plugins installed in Magpie. Install only if you intend to make that change.

## Connect

1. Set up the desired upstream model or routing group in Magpie.
2. Close Saymore, select the model in Magpie's **Agents → Saymore** row, and reopen Saymore.
3. In **Models → Text polishing → Magpie**, choose the model and explicitly test and enable the provider.

The adapter writes only these keys to Saymore's production macOS config:

```text
~/Library/Application Support/Saymore/config.json
```

- `integrations.magpie.model`
- `integrations.magpie.base_url`
- `integrations.magpie.api_key`
- `integrations.magpie.profile`

It does **not** write `llm_providers[0]`, `active.llm`, or `enabled`. Magpie supplies the selected model ID and its scoped gateway key, and restores the original key values when disconnected. Saymore must consume the handoff at startup; after it is consumed, disconnecting cannot reverse the imported provider's already persisted configuration. Switch providers in Saymore instead.

No text is sent by selecting a model. In a compatible Saymore build, only a successful connection test and explicit provider enablement permits the existing polishing flow to submit dictated text. The remote upstream behind Magpie may charge for requests.

## Development checks

```bash
bun test saymore.test.mjs
bun /path/to/community-plugins/scripts/check.mjs agent-saymore
```

The tests execute the module and inspect its returned keys. They do not install it in your active Magpie profile, access Saymore's real config, or make model-generation requests. Real Magpie host verification must use a disposable HOME and no user-provided model credentials.
