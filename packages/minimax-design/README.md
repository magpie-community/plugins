# @magpie-community/agent-minimax-design

[MiniMax Design](https://design.minimax.io) (the local multimodal creation studio, electron app id `@hilo`) as a magpie agent. MiniMax Design supports custom text models over the OpenAI-compatible, OpenAI Responses and Anthropic protocols; magpie's gateway translates all three, so one switch points Design at magpie.

```sh
magpie plugin add @magpie-community/agent-minimax-design
```

**Windows only.** The paths below lean on `%APPDATA%` and `%LOCALAPPDATA%`, which other systems don't set. Quit MiniMax Design first, switch the agent on in magpie's Agents page, then start Design and pick a model under the **Magpie** entry in its model menu. Disconnecting in magpie removes the entry magpie wrote — the whole entry, not just its fields — and leaves the rest of Design's configuration untouched.

## How it works

Design keeps its custom models in `%APPDATA%\@hilo\desktop\hub-config.json`, under `config.customModels.<id>`:

```json
{
  "protocol": "openai-compatible",
  "providerName": "Magpie",
  "baseUrl": "http://127.0.0.1:3425/v1",
  "apiKey": "magpie-minimax-design",
  "models": [{ "id": "...", "contextWindow": 1000000, "maxOutputTokens": 65536, "reasoningLevels": ["low", "high"] }]
}
```

The agent is a switch (no model picker): Design picks its model in its own UI. Connecting writes the single entry `config.customModels.user-custom-magpie` — one key holding the whole object, so disconnecting takes the entry out whole rather than leaving an emptied `{"user-custom-magpie": {}}` behind. `apiKey` is a Design-specific key, so Usage attributes requests to this agent. `models` is mapped from magpie's current model list (`id` → `id`, `context` → `contextWindow`, `output` → `maxOutputTokens`, `efforts` → `reasoningLevels`); when magpie's models change, magpie re-calls connect and the list refreshes itself. Reasoning levels are filtered to the ones Design's model menu knows (`low`, `medium`, `high`, `xhigh`, `max`); models whose efforts are all something else (e.g. `none`) get no `reasoningLevels` field.

## Notes

- Quit Design before switching: a running Design writes its in-memory configuration back over the file. Restart Design after a change.
- Design accepts the non-UUID entry id `user-custom-magpie` (verified on 3.0.17).
- See [COMPATIBILITY.md](COMPATIBILITY.md) for verified versions and platforms.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
