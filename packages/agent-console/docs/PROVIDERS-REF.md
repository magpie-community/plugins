# Provider Integration Reference (Paseo / T3 Code) and How the 8 Agents Are Wired

> Based on the Paseo and T3 Code source code plus local `devin --help` and `opencode --help` (2026-10-30). Only the ideas were referenced; no code was copied.

## 1. How the two projects integrate Agents

Both use the same structure: **one "driver" per Agent**. The driver starts the CLI, sends and receives messages, and translates events into a common format. By transport there are three kinds:

| Kind | Description | Examples |
|---|---|---|
| CLI stream-json | Spawn the user's CLI and speak its line-delimited JSON protocol | Claude (`claude -p --input-format stream-json --output-format stream-json`) |
| Private protocol | The CLI has its own JSON mode, different per vendor, each needs its own driver | Codex `codex app-server`, Pi `pi --mode rpc`, OpenCode `opencode serve` (HTTP) |
| **ACP (common protocol)** | Agent Client Protocol, a standard: `initialize → session/new → session/prompt`, with standard fields for permissions, models and thinking level. **One generic driver is shared by several Agents** | Cursor `cursor-agent acp`, Copilot `copilot --acp`, Devin `devin acp`, Kimi `kimi acp`, OpenCode `opencode acp` |

- Paseo: `generic-acp-agent.ts` (generic ACP, about 190 lines) + a very thin subclass per ACP Agent (Cursor 95 lines, Copilot 235 lines) that only adds vendor-specific bits (e.g. Cursor's model-list extension method `cursor/list_available_models`, the Fast toggle).

## 2. How "low / medium / high" (thinking level) works

**Key point: the level options belong to the model, not to the Agent.** Different models support different levels, and the dropdown changes when the model changes.

| Agent | Where the levels come from | How they take effect |
|---|---|---|
| Claude (Paseo) | Built-in model list: regular models `low/medium/high/max`, newer models add `xhigh`; some models also support `off` (no thinking); default `high` (`medium` for a few models) | The SDK's `effort` only applies when a session is created → after a change, **the session is rebuilt on the next turn**, with a "takes effect next turn" hint |
| Codex | Ask app-server `model/list`: each model carries `supportedReasoningEfforts` and `defaultReasoningEffort` | Each `turn/start` carries `effort` |
| Pi | `off/minimal/low/medium/high/xhigh/max`, filtered by the model's `thinkingLevelMap` | RPC command `set_thinking_level` |
| ACP (Cursor/Copilot/Devin…) | The Agent reports a `thought_level` option in `configOptions` (which levels exist, which is default) | ACP standard `session/set_config_option` |

T3 Code works the same way: each model has a set of option descriptors (e.g. a `reasoningEffort` dropdown); the UI can show them as text or as "signal bars", with shortcuts to step up/down.

## 3. How this plugin wires the 8 Agents

| Agent | Transport | Launch command |
|---|---|---|
| Claude Code | SDK | — |
| Codex | Private protocol (app-server) | `codex app-server` |
| OpenCode | ACP | `opencode acp` |
| Devin CLI | ACP | `devin acp` |
| Cursor | ACP (+ `cursor/list_available_models`, parameterized model picker) | `cursor-agent acp` |
| Copilot | ACP | `copilot --acp` |
| Pi | ACP (via the `pi-acp` adapter) | `pi-acp` |
| dsh | ACP | `dsh --profile acp` |

One generic ACP driver covers most Agents; vendor-specific behavior (Cursor's model list and effort option, Copilot's modes) lives in thin per-provider adapters.

## 4. Implementation notes

1. **Thinking level is per model**: a provider's `listModels()` returns each model's `thinkingOptions` + default level; the frontend dropdown follows the selected model; changing the level while running shows a "takes effect next turn" hint where needed.
2. **Generic ACP driver**: configurable launch command; implements `initialize / session/new / session/load (resume) / session/prompt / session/cancel / session/request_permission / session/set_mode / session/set_config_option`; events are mapped onto the existing timeline.
3. **Thin ACP adapters** only add the special cases: Cursor's model list, Copilot's modes, etc.
