# Magpie Agent for Yan Agent

Magpie Agent adapter for **Yan Agent on Windows**. This is a Magpie plugin, not a Yan native plugin.

## Requirements

- Magpie with third-party Agent plugin support.
- A Yan build containing the version-1 `magpie.json` runtime integration. An older installed Yan 1.8.0 build may not contain it; installing this adapter does not upgrade Yan.
- Standard Windows data directory: `%APPDATA%/yan-agent/YanData`.

## Install in Magpie

```sh
magpie plugin add https://github.com/666-gy/magpie-agent-yan
```

Alternatively clone this repository and use `magpie plugin add "<absolute repository directory>"`.
Choose Yan Agent in Magpie's Agents page and select a model, then start a new run in Yan.
The `package.json` declares `magpie.agent`; `yan.agent.js` exports `agent` and `connect` with no Node APIs or dependencies.
The repository name follows the `magpie-agent-<agent>` convention; plugin loading depends on the manifest and exports, not the repository name alone.

## Behaviour and safety

Magpie writes only `%APPDATA%/yan-agent/YanData/magpie.json`, not Yan's main `config.json`.
Yan snapshots that file at run admission. Existing runs do not hot-switch.
Full model IDs, including multi-part route/group IDs, are retained. Model metadata controls image input, reasoning and context; unknown groups are not assumed multimodal.
Only the OpenAI-compatible Magpie gateway is used; Magpie handles upstream protocol conversion.

Disconnect using Magpie to restore its field backups. To explicitly disable the override, delete `magpie.json` or set `enabled:false`; subsequent runs use Yan's original selection.
If a prior active Magpie configuration was backed up, disconnect may restore that prior override.
Malformed active configuration blocks new runs with a redacted error.
Side Chat keeps its independent model selection; Yan settings continue to show the original configuration.

The dedicated gateway key is plaintext in the Magpie-owned file. Do not commit it, paste it into issues, or share it. Custom userData paths require changing `agent.dir` and `agent.config`.
No image/video role bindings, Skill/MCP synchronization or automated installation is included.

## Validation status

The parent Yan integration passed 47 focused tests, including 5 Magpie-specific tests, and relevant syntax checks.
Real Magpie discovery, embedded runtime execution, backup restoration and streaming/tool-call traffic have **not** been end-to-end verified.
No plugin was installed and no real credentials or paid model were used during publication.

Official references: [Agent plugin protocol](https://usemagpie.ai/docs/plugins#agents) · [Kilo example](https://github.com/magpie-community/plugins/blob/main/packages/kilo/kilo.agent.js).

Yan-native companion: [Magpie-for-Yan-Agent](https://github.com/666-gy/YanPlugin-magpie-for-yan-agent).
