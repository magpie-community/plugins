# @magpie-community/agent-coda

Adds [Coda Bot](https://codabot.app) to Magpie's **Agents** page. The model picked on Coda Bot's row becomes Coda Bot's default model, and Magpie's whole model catalog, routing groups included, is synced to Coda Bot, so each Coda bot, group chat member and local team can pick its own Magpie model (`custom:magpie:<id>`).

The agent declares no `effort`: each Coda bot keeps its own thinking level, chosen from the levels the model's `efforts` list offers.

## Install and use

Requires the Coda Bot desktop app **0.0.2-dev.7 or later**, on the same computer as Magpie. Tested with Magpie **v0.1.3937** on macOS (connecting and chatting); Windows and Linux are untested.

```sh
magpie plugin add @magpie-community/agent-coda
```

1. Connect **Coda Bot** on Magpie's Agents page and pick a model.
2. Coda Bot needs no restart: once its window is back in front, Magpie's models show up in its model pickers, and new turns use the selected model.

## Disconnect or remove

Disconnecting Coda Bot on the Agents page restores `~/.coda/magpie.json` to what it was before, or removes it if there was none. Coda Bot then drops the `custom:magpie:*` models, and a bot that was on one of them goes back to a default model it can still run.

- **Disconnect before uninstalling** this plugin, so Magpie restores the file.
- **Quitting Magpie without disconnecting** leaves the file in place: Coda Bot keeps listing Magpie's models, but requests to them fail until Magpie runs again or Coda Bot is disconnected.

## The file Magpie writes

Magpie writes `~/.coda/magpie.json` in the home folder of the user Magpie runs as. If `CODA_BOT_HOME` points Coda Bot elsewhere, Coda Bot reads `$CODA_BOT_HOME/magpie.json` first and falls back to `~/.coda/magpie.json`.

```json
{
  "defaultModel": "deepseek/deepseek-chat",
  "url": "http://127.0.0.1:3425",
  "baseUrl": "http://127.0.0.1:3425/v1",
  "apiKey": "<magpie-agent-token>",
  "gateway": {
    "version": 1,
    "url": "http://127.0.0.1:3425",
    "baseUrl": "http://127.0.0.1:3425/v1",
    "models": [
      {
        "id": "deepseek/deepseek-chat",
        "name": "DeepSeek Chat",
        "vision": false,
        "efforts": [],
        "nativeEndpoints": ["/v1/chat/completions"],
        "contextWindow": 128000,
        "maxOutputTokens": 8192
      }
    ]
  }
}
```

- `url`, `baseUrl` and `apiKey` are top-level keys, so Magpie can tell from the gateway key that the file is still its own, and see when the endpoint changed.
- Coda Bot uses the file only when `gateway.version` is `1` and `url` and `baseUrl` are the same loopback origin (`127.0.0.1`, `localhost` or `[::1]`), with `baseUrl` under `/v1`.
- Each model is called on the API its `nativeEndpoints` names: `/v1/messages` as Anthropic Messages, `/v1/responses` as OpenAI Responses, `/v1/chat/completions` as OpenAI Chat Completions. Coda Bot sends `User-Agent: CodaBot/<version>` on these requests only.
- A `defaultModel` missing from `gateway.models` is ignored, and Coda Bot keeps its own default.

## Limits

- Only a gateway on the same computer: no remote gateway, LAN or WSL address.
- Magpie's models are not offered to Coda Bot's web relay sessions.

## License

MIT
