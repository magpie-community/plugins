# magpie-mask-context

A [magpie](https://usemagpie.ai) gateway middleware that explains **masking placeholders** to the model: what tokens like `{{API_KEY_a1b2c3d4}}` are, why they appear, and how to treat them — copy them exactly, never guess the real value.

[中文说明](README.zh-CN.md)

## The problem

magpie's local masking (Settings → Privacy) replaces sensitive values — API keys, passwords, tokens, emails, phone numbers, your own masked terms — with stable placeholders of the form `{{TYPE_hash8}}` before a request leaves your machine, and restores the real values in everything the model outputs. The model, however, is never told about any of this. Without context it may reformat a placeholder, translate it, invent a plausible-looking key instead, or ask the user what it hides — and every one of those breaks the round-trip.

## What this does

This middleware appends a short note (≈120 tokens) to the **end** of each request's system prompt, teaching the model the convention:

- those tokens are stable placeholders created by your local privacy gateway;
- the same real value always maps to the same placeholder;
- treat a placeholder as the value itself and copy it **character for character**;
- never guess, invent, translate, reformat, or try to restore it, and never ask what it is;
- ordinary IDs (UUIDs, hex hashes) are not placeholders.

The note is written conditionally ("tokens **like** this are placeholders"), so it is harmless when masking is off or a request carries no placeholders. Appending after the agent's own prompt keeps it as the prompt-cache prefix.

| API | Where the note goes |
|---|---|
| Chat | appended to the first `system` / `developer` message (added if none) |
| Anthropic | appended to `system` (string or blocks) |
| Responses | appended to `instructions` |
| Gemini | appended to `systemInstruction` / `system_instruction` parts |

## Install

From magpie's **Plugins → Discover** (search "mask-context"), or:

```
magpie plugin add github:aqiu817/magpie-mask-context
```

Options live under **Plugins → Installed → Options**, or:

```
magpie plugin options magpie-mask-context '{"lang": "zh"}'
```

## Options

```json
{ "mode": "on", "prompt": "", "lang": "en",
  "agents": [], "models": [], "debug": false }
```

| Option | Meaning |
|---|---|
| `mode` | `"on"` (default) appends the note to every request; `"off"` disables the middleware. |
| `prompt` | Replaces the built-in note entirely. |
| `lang` | `"en"` (default) or `"zh"` for the built-in note. |
| `agents` | When given, only these magpie agent ids get the note (e.g. `["dsh", "codex"]`). |
| `models` | When given, only models whose names start with one of these prefixes get the note. |
| `debug` | Logs each append (visible in magpie's CLI output as `plugin: …`). |

## Why unconditional (measured, not guessed)

On magpie 0.1.3329, gateway middleware runs **before** masking: a probe middleware saw raw `sk-…` values, while the Go-side masker masks after routing, on the way out. The middleware sandbox also has no `fetch`, no `Bun`, no module imports — there is no way to probe the privacy settings or detect placeholders from inside. So the note is appended unconditionally, phrased conditionally to stay harmless. (Probe method: `ctx.reject(403, msg)` echoes diagnostic text back to the client — handy trick for debugging middleware.)

## Verification

- `node test.mjs` — 29 unit tests: four APIs × system shapes × options × defenses.
- Live smoke (magpie 0.1.3329, free-tier model):
  - marker injected via options was confirmed by the model ("Yes");
  - with the default note, a `.env` task got "I only see the masked placeholders, never the real values" — no guessing, no inventing, no asking;
  - asked to quote a masked email exactly, the model returned `{{EMAIL_e5f6a7b8}}` character for character.

## License

MIT
