# zcode-cli

Runs the ZCode CLI on this computer as a model provider in Magpie (and
OpenCode). Each request runs ZCode's documented headless mode:

```sh
zcode --prompt "<conversation>" --cwd <empty temp folder> --mode plan \
  --output-format stream-json --no-color \
  --disallowed-tools "AskUserQuestion EnterPlanMode ExitPlanMode Agent Task"
```

ZCode's own process signs in and makes every request, with its own headers.
The plugin reads none of ZCode's credentials, sends nothing to Z.ai itself
and stands in for no client. ZCode's `stream-json` output is turned back
into an Anthropic Messages reply: text as text, reasoning as thinking, the
result line's usage as usage.

**[中文 → README.md](README.md)**

## Requirements

- ZCode 3.x with its CLI: `zcode` on PATH, or the ZCode app's bundled
  `Z Code.app/Contents/Resources/glm/zcode.cjs` (run with `node`, or with the
  app itself under `ELECTRON_RUN_AS_NODE`). `ZCODE_CLI` names another one
  (a binary or a `.cjs`).
- ZCode signed in: `zcode login` in a terminal, with a GLM Coding Plan
  account (Z.ai or BigModel) or a Coding Plan API key. ZCode's free Start
  Plan doesn't work in the standalone CLI (zai-org/zai-coding-plugins#44:
  `Z.ai user information is invalid`).

## Models

- `zcode-default`: whatever model ZCode is set to.
- `GLM-5.3`, `GLM-5.3-Flash`, `GLM-5-Turbo`: ZCode has no `--model` flag, so
  the run gets a provider file of its own
  (`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`) holding only
  `defaultModelSelection`. Your `~/.zcode/v2/provider_config.json` is never
  read or written. The plan is `account:zai-individual-coding-plan`; set
  `ZCODE_CLI_PROVIDER=account:bigmodel-individual-coding-plan` for BigModel.

## What it doesn't do yet

- The client's own tools. ZCode works with its own tools, read-only (plan
  mode, `ZCODE_CLI_MODE` changes it), in an empty folder that is deleted
  after the run. The reply is text.
- Sessions. Each request is a ZCode run of its own with the whole
  conversation in its prompt; a conversation too long for a command line is
  written to a file in that folder and ZCode is asked to read it.

## Errors

- `3012` / "unusual activity" is zcode.z.ai's risk control. It answers the
  ZCode app's own requests the same way; only ZCode support lifts it.
- Not signed in: run `zcode login`.
