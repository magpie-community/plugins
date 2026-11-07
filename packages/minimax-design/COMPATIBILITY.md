# Compatibility record

**This plugin is Windows only.** Its `config` and `dir` fields lean on `%APPDATA%` and `%LOCALAPPDATA%`, environment variables that don't exist on macOS or Linux — there the paths would expand to `/@hilo/desktop/hub-config.json` and `/Programs/MiniMax Design`, where nothing is written and Design is never detected.

## Windows — verified

- Windows 11 (workstation), MiniMax Design 3.0.17, official magpie 0.1.20xx (Oct 2026).
- Verified with real end-to-end use: connect writes `config.customModels.user-custom-magpie` into `hub-config.json` with magpie's full model list; Design's model menu shows the Magpie entry; real inference requests flow through magpie's gateway and are attributed to `minimax-design` in Usage; existing custom-model entries are preserved.
- Magpie's own agent-plugin sandbox checks also passed: dotted nested key paths with intermediate-object creation, object values and object-array values, `$VAR` expansion (`$APPDATA`, `$LOCALAPPDATA`), preservation of unrelated keys.

## macOS — not supported in this version

MiniMax Design ships for macOS 13+, and its userData path there would be electron's default `~/Library/Application Support/@hilo/desktop/hub-config.json` — but that path is unconfirmed, and the agent-plugin `config` field takes a single path with `~`/`$VAR` expansion, so one package can't carry both. If you can test on macOS, open an issue or PR with the observed path and a verification note and the plugin can grow a per-platform form.
