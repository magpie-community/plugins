# Claude Code Guard

Claude Code's auto mode classifier, answered by a model that only answers
questions. Provider id: `cc-guard`, model: `cc-guard/auto-mode`.

In auto mode Claude Code sends each action to a classifier model before it
runs: an Anthropic Messages request whose system prompt carries the block
rules and whose user message carries the session transcript. A decision model
such as jev answers questions rather than chat, and magpie refuses a chat
request to a model named `jev-*`, so neither can be the classifier directly.
This plugin reads the rules and the transcript out of the request, asks the
decision model one question through magpie's own gateway, and returns the
`<block>` verdict Claude Code parses.

The rules aren't copied into the plugin. HARD BLOCK, SOFT BLOCK and ALLOW are
parsed from the request's own system prompt, so a Claude Code update or a
change to the auto mode config changes them here too.

## Install

```sh
magpie plugin add @magpie-community/opencode-cc-guard-auth
magpie plugin login cc-guard
```

Anything typed in the key field signs in. The plugin keeps no credential of
its own: it calls magpie's gateway with the token in its options.

Point Claude Code at it, in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_AUTO_MODE_MODEL": "cc-guard/auto-mode",
    "CLAUDE_CODE_AUTO_MODE_SERVER": "0"
  }
}
```

`CLAUDE_CODE_AUTO_MODE_MODEL` needs Claude Code v2.1.302 or later. With
`CLAUDE_CODE_AUTO_MODE_SERVER` left unset, sessions Anthropic's server reviews
never send a classifier request, so the model is never asked. Restart Claude
Code after changing either.

To check which model reviewed, start a session with `claude --permission-mode
auto --debug-file classifier-debug.log`, have it run something that isn't
read-only, and look for `classifier_request_started`: `model=` should be
`cc-guard/auto-mode`.

## The verdict

One call asks three things: which rule best describes the action, whether the
user's own messages explicitly ask for that exact action, and whether they
explicitly forbid it.

- Stage 1 (the request stops at `</block>`) ignores user intent and the ALLOW
  exceptions. It blocks when any HARD rule matches, or when the SOFT rules
  together carry at least half the probability.
- Stage 2 applies both. A HARD rule blocks no matter what the user asked. A
  SOFT rule is cleared when the user explicitly named the action, or when an
  ALLOW exception fits it better. An action the user explicitly forbade is
  blocked when it also reaches a block rule's territory.
- Both stages ask the same question, so the second reuses the first answer
  for ten minutes instead of calling the model again.

When the decision model can't be reached, or the prompt carries no rule
section, the plugin answers 503. Claude Code treats that as a classifier that
couldn't judge the action and denies it, so a broken guard blocks rather than
lets the action through.

A request that isn't a classifier request gets a 400. The model isn't for
chat.

## Options

```sh
magpie plugin options opencode-cc-guard-auth '{"gateway":"http://127.0.0.1:3425","model":"group/jev","token":"magpie"}'
```

| Option | Default | Meaning |
| --- | --- | --- |
| `gateway` | `http://127.0.0.1:3425` | The magpie gateway the decision model is asked through |
| `model` | `group/jev` | The model asked. A routing group uses the account and key already configured for it |
| `token` | `magpie` | Bearer token for that gateway, the same value as Claude Code's `ANTHROPIC_AUTH_TOKEN` |
