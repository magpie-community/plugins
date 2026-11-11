<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/shypie-icon-dark.svg">
    <img src="../assets/shypie-icon.svg" width="88" alt="ShyPie">
  </picture>
</p>

# Operations

Installation, configuration, verification and troubleshooting for the Magpie
middleware.

## Install

```sh
magpie plugin add @magpie-community/middleware-privacy-gate
magpie plugin
```

Confirm that Magpie's built-in **JS gateway plugins** plugin is on
(**Settings → Plugins → Built-in**, id `middleware`). If it is off, no
middleware runs.

## Recommended baseline

For a gateway where only Magpie-routed DSH traffic should carry PII as text:

```json
{
  "binaryPolicy": "guide",
  "allowModels": ["deepseek/*", "copilot/*"],
  "localModels": ["ollama/*", "lmstudio/*"],
  "localProviders": ["ollama", "lmstudio"],
  "guideTools": []
}
```

Use `"binaryPolicy": "fail"` if you want a hard 403 instead of a withhold-and-
prompt response.

`guideTools` should stay empty unless a matching local MCP extractor is actually
configured for the agent. The middleware cannot execute a tool; it only names it
in the guide prompt.

## Verify

1. Save options:

   ```sh
   magpie plugin options privacy-gate '{"binaryPolicy":"guide"}'
   magpie plugin
   ```

2. Send a request with an image part to a non-local model.
   - `guide`: HTTP 200, the model asks how to process the file locally, and no
     image bytes appear at the provider.
   - `fail`: HTTP 403 and a `privacy-gate:` message.

3. Send a text-only request through the same model. It should pass.

4. Send a request whose text contains a 600-character base64 run. It should be
   rejected with a BLOB message even if there is no image part.

5. Check Magpie's plugin log for counts and the `usage` line. The middleware
   never logs request content — only provider/model/status/blocked counters.

## Troubleshooting

### I get a 403 for an image

Expected in `fail` mode. Either extract the image locally and send text, or set
`binaryPolicy: "guide"` so the model receives metadata and a local-processing
prompt instead.

### Guide mode returns 200 but the model cannot see the file

Correct. The middleware never forwards the bytes. The model must use a local
MCP/extractor that the agent has configured. Without one, the response is advice,
not extraction.

### An image reaches a local but non-local provider

Set **both** `localModels` and `localProviders`; with only `localModels`,
`onProvider` blanks the content rather than sending it.

### A legitimate request is rejected with BLOB

A long hash, minified line or base64-ish text can exceed the 400-character
threshold. Raise `blobBase64Chars` / `blobHexChars` deliberately and understand
that a larger document can then pass. Do not disable the gate.

### The request went through even though the gate is on

Check the Magpie log for `onRequest: took too long`. Magpie drops a hook after
250 ms and forwards the original request. This is the engine's fail-open
behavior, tracked in [magpie#5305](https://github.com/yetone/magpie/issues/5305).
The middleware's own budgets reduce the chance of a timeout but cannot change
that outcome.

## Update and rollback

Update through Magpie's plugin manager (`magpie plugin update`) and re-check the
saved options after a version change.

To roll back to the strictest behavior, remove the options (`{}`) or set
`binaryPolicy: fail` and clear `localModels`/`localProviders`. Removing the
plugin leaves agents without the structural check; text masking is unaffected.

## Companion deployment

The DSH half is `@shypie_privacy/dsh-privacy-gate` 0.3.0. It performs local
image/PDF extraction before the DSH transcript and enforces the DSH
`llm/stream` egress guard. This Magpie gate then covers every other agent behind
the same gateway.

## Support

- [README](../README.md)
- [Design](./design.md)
- [Brand assets](../BRAND.md)
- Magpie engine timeout: [magpie#5305](https://github.com/yetone/magpie/issues/5305)
