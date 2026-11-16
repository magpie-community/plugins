# magpie-model-watch

Gateway hooks for [Magpie](https://usemagpie.ai). It reports the **real outcome of every model call** that already goes through your Magpie gateway — model name, HTTP status and latency — to a local observability bridge, so you can see which models actually work. **Zero extra requests, zero quota spent**: the data comes from calls you were already making. Provider errors and quota events are forwarded into the same timeline.

> This plugin needs a receiver. By default it posts to `magpie-bridge` at `http://127.0.0.1:8787`. Any HTTP endpoint accepting the same payloads works; see [the bridge](https://github.com/cpufreestyle/magpie-bridge) (or point `bridgeUrl` at your own collector). If nothing is listening, the plugin is completely silent — it never affects your requests.

## Install

From the Magpie plugin store (`Plugins → Discover`), or by name:

```bash
magpie plugin add magpie-model-watch
```

From source:

```bash
magpie plugin add github:cpufreestyle/magpie-model-watch
```

Then enable it in `Plugins`. Turning a plugin on/off reloads the plugin host (a brief gap, in-flight requests are unaffected).

## Options

Set with `magpie plugin options magpie-model-watch '{"bridgeUrl":"http://127.0.0.1:9999"}'`.

| Key | Default | Meaning |
|---|---|---|
| `bridgeUrl` | `http://127.0.0.1:8787` | Receiver base URL |
| `token` | empty | Bearer token for the receiver (also sent as `?token=`) |
| `reportSuccess` | `true` | Report successful calls (set `false` to only report failures) |
| `reportErrors` | `true` | Report failed calls |
| `maxPerMinute` | `120` | Soft per-minute cap on forwarded records |

## What it sends

- `POST {bridgeUrl}/probe/report` with `{"events":[{"model","code","status","source":"hook"}]}` per completed call.
- `POST {bridgeUrl}/event` with `{"event","source":"magpie","level","detail","models"}` for Magpie's own error/quota notices.

Only the model slug, status code, latency and event type are sent. **No conversation content. No prompts. No keys.**

## Design / safety

- `onRequest` always returns `undefined` — the request is never modified.
- All HTTP is fire-and-forget with a 1.5 s timeout and a serialized queue; it never throws into the gateway and never waits on a slow receiver. A dead bridge is invisible to Magpie.
- Every field is guarded; a Magpie version that exposes fewer fields simply skips that record.
- No runtime dependencies.

## Verify

```
curl -s http://127.0.0.1:8787/probe/status
```

You should see entries with `"source": "hook"` after normal usage.

## License

MIT
