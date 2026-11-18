# @magpie-community/middleware-factory-identity

An optional [magpie](https://usemagpie.ai) gateway middleware for the OMP default-prompt compatibility report in [#1284](https://github.com/magpie-community/plugins/issues/1284), with background in [oh-my-pi #19553](https://github.com/can1357/oh-my-pi/issues/19553).

Only for a resolved provider whose id is `factory`, it replaces the exact sentence:

```text
You are omp's trusted coding assistant.
```

with:

```text
You are droid's trusted coding assistant.
```

The rest of OMP's instructions stay in place, including engineering guidance, personality and tool/workflow rules. Each matching occurrence inside an eligible instruction field is replaced.

## Install

```sh
magpie plugin add @magpie-community/middleware-factory-identity
```

Use an existing Factory provider and your own account. Unlike `opencode-factory-auth`, this package does not sign in, list models or make requests. It uses the same account and credit pool as that provider, and is inactive until installed and enabled. Disable or remove it from Plugins to restore the original instruction text.

Requires magpie's `onProvider` gateway hook; the independent version has been used with magpie v0.1.4402. Source: [HarryWang29/magpie-factory-identity](https://github.com/HarryWang29/magpie-factory-identity), MIT.

## Scope

- Runs in `onProvider`, after the upstream is selected. A routing group that selects Factory is handled; a try on another provider is unchanged.
- Anthropic: the `system` string or text blocks.
- Chat: `system` and `developer` messages.
- Responses: `instructions` and `system`/`developer` messages in `input`.
- Gemini: text parts in `systemInstruction` or `system_instruction`.
- Historical `system`/`developer` messages are eligible; user messages, assistant replies and tool outputs are never rewritten.
- Tool definitions, call/result pairing, cache markers, signed reasoning and non-text blocks are preserved. The input object is not mutated.

There are no options, dependencies, network calls or account access. Other client identity strings are outside this package's scope.

## Limitations

This is a narrowly scoped prompt change, not a general fix for Factory refusals. The linked reports describe whole-request scanning: if the sentence appears in user/assistant/tool history, this middleware deliberately leaves it there and the request may still be rejected. Upstream acceptance can also change independently of the plugin.

Use a new conversation for a clean trial, and inspect the request sent from magpie to Factory; the request entering magpie still carries OMP's original text. The JSON fixture tests below check transformation boundaries without sending model requests. No universal live-provider acceptance is claimed.

## Tests

```sh
bun test packages/factory-identity
bun scripts/check.mjs factory-identity
```

`cases.json` runs through the repository's shared middleware harness, including resolved-provider routing and the four client API formats.
