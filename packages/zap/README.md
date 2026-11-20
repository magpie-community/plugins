# magpie-agent-zap

[Zap](https://github.com/zerx-lab/zap) (the OpenWarp fork of Warp) as a [magpie](https://usemagpie.ai) agent. Pick one of magpie's models on the Agents page and Zap's BYOP provider follows it — every request stays on localhost: Zap → magpie's gateway → the model, no cloud in between.

```
magpie plugin add ./agent-zap   # a folder is loaded where it is
```

Zap keeps its BYOP providers in `~/.zap/settings.toml`, which magpie's agent bridge cannot write (JSON/YAML/env only). This plugin therefore works in two halves:

1. magpie manages a small JSON outbox, `~/.zap/magpie-bridge.json`: the gateway address, the picked model and magpie's whole model catalog.
2. a Bun module in magpie's plugin host mirrors the outbox into `~/.zap/settings.toml`:

```toml
[agents.byop]
last_used_model_id = "byop:6d616770-6965-4000-8000-7a6170000001:tokenservice/kimi-k3"

[[agents.warp_agent.providers]]
id = "6d616770-6965-4000-8000-7a6170000001"
name = "Magpie"
kind = "open_ai_compatible"
api_type = "open_ai"
base_url = "http://127.0.0.1:3425/v1"

[[agents.warp_agent.providers.models]]
name = "Kimi K3 · tokenService"
id = "tokenservice/kimi-k3"
context_window = 1048576
image = true
# … one table per model magpie offers
```

Behavior worth knowing:

- **No API key needed.** Zap talks to magpie's gateway on loopback, which answers without a token, so nothing is added to Zap's keychain.
- **Your own providers are never touched.** Only the block with the managed `id` is rewritten; a hand-made provider on the same gateway URL — and the keychain entry its `id` keys — stays exactly as it was.
- **Byte-exact surgery.** No whitespace normalization anywhere: multi-line strings, blank runs and every other table keep their exact bytes across connect/disconnect.
- **Your picks in Zap stay yours.** Selecting another provider's model in Zap is left alone; only picks made in magpie move `last_used_model_id`.
- **Self-healing.** If a running Zap re-saves `settings.toml` from stale in-memory state, the managed provider is restored within ~1.5 s. Restart Zap after connecting so it loads the provider once.
- **Switching off** removes the managed provider and puts `last_used_model_id` back to what it was before — including when the plugin itself is switched off or removed while connected: the watcher leaves a tombstone of the managed block in `~/.zap/magpie-bridge.state.json`, and the next tick (from any later host start) cleans the file.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
