# Gemini Decision for Magpie

A provider exposing Google's native **Gemini Decision 1** through Magpie's
**System One** interface (the OpenRouter Decisions schema). Use it as a
chat routing group's classifier or as a member of a decision-model group
with other System One providers.

**Provider id:** `gemini-decision`. **Model:** `gemini-decision/gemini-decision-1`.

Magpie already speaks System One for compatible decision providers. Google
uses a different endpoint and a few different field shapes, which this
plugin converts. The plugin calls
`POST https://generativelanguage.googleapis.com/v1beta/decisions` and
returns native probabilities — output tokens are always zero.

## Install and sign in

From the npm registry:

```sh
magpie plugin add @magpie-community/opencode-gemini-decision-auth
magpie plugin login gemini-decision
```

From a source checkout of this repository:

```sh
magpie plugin add ./packages/gemini-decision
magpie plugin login gemini-decision
```

Sign in with a Google AI Studio API key. Note that the
Decisions API is rolled out per Google Cloud project — some projects
report a zero quota; test a fresh key with one direct curl before adding
it. Register several keys in magpie for failover and pooling. Per
[Google's rate-limit documentation](https://aistudio.google.com/docs/rate-limits#gemini-decision),
the free tier allows 200 requests/minute and 10,000 requests/day
(Tier 1: 1,500 RPM, 50,000 RPD; higher tiers scale further), and input
tokens are free of charge on the free tier — the paid tier is $0.10
per 1M input tokens, with zero output tokens either way. Limits apply
per project, not per key.

### Credentials and compatibility

The plugin receives the selected account's API key from the host's
`getAuth` callback on every request; account/key rotation, failover and
sign-out are handled by magpie, not by this plugin. Keys are kept by the
host (`plugin-auth.json`, permissions 0600).

The plugin is a single zero-dependency ESM file (`index.mjs`) in the
OpenCode 1.x plugin shape that magpie's host runs. It is a decision
provider: ordinary chat clients never see its model; consumers call
`POST <gateway>/v1/systemone` explicitly.

## Use System One

Send this request to `http://127.0.0.1:3425/v1/systemone`:

```json
{
  "model": "gemini-decision/gemini-decision-1",
  "state": "Customer support ticket: my card was charged twice.",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which department should handle this ticket?",
      "criteria": {"billing": "Payments and refunds", "technical": "Product bugs"}
    },
    "urgent": {"type": "noul", "instructions": "Is this blocking the customer right now?"},
    "severity": {
      "type": "score",
      "instructions": "How severe is the issue?",
      "criteria": ["Cosmetic", "Workaround exists", "Fully blocked"]
    }
  }
}
```

## Protocol conversion

The OpenRouter Decisions schema and Google's native schema share the same
question primitives (`noul`/`choice`/`score`) and answer shapes. The
plugin only bridges these differences:

| System One (OpenRouter) | Gemini Decisions API | Plugin handling |
| --- | --- | --- |
| `state` (string) | `input` | Passed as-is |
| `state` (object) | `input` | JSON-serialized into a text block |
| `state` array of strings and media parts | `input` content blocks | Strings become text blocks; `image_url`, `input_audio`, `video_url` and `input_file` parts become native `image`/`audio`/`video`/`document` blocks (data URLs split into bytes + mime type; https URLs passed as `uri`; `detail` maps to `resolution`; audio `format` maps to a mime type) |
| `assets` media map | (no equivalent) | Entries are resolved into blocks wherever `state` references their key (plain string or `{"type":"asset"}`); the field itself is dropped |
| noul `criteria` `{true, false}` | `{true_description, false_description}` | Keys renamed |
| criteria value `null` (self-explanatory option) | empty string | Converted |
| Question keys like `tool:Agent` | keys must match `[A-Za-z0-9_-]{1,64}` | Illegal characters become `_` (collisions get a numeric suffix); answer keys are restored to the originals in the response — fully transparent |
| Model name | `gemini-decision-1` | Provider prefix stripped, then normalized |
| `Authorization: Bearer` | `x-goog-api-key` | Swapped by the loader |

Answers need no conversion and are passed through byte-identical when no
question key needed sanitizing. Upstream status codes, error bodies and
headers are forwarded untouched; a `401` adds `X-Magpie-Sign-In: expired`
so magpie marks the account. Nothing is logged: no request bodies, no
states, no keys.

### Not supported

- **`box` questions** (visual object localization): Google's Decisions API
  has no box question type. Requests containing one are rejected upstream
  with a 400.
- `output_modalities` other than decisions: the model generates zero text.

## Models and limits

One model: `gemini-decision-1` (context 262,144 tokens, input text,
image, audio, video and PDF documents; input costs $0.10 per 1M tokens
on the paid tier and is free of charge on the free tier).
[Google's rate limits](https://aistudio.google.com/docs/rate-limits#gemini-decision)
are per project: free tier 200 RPM / 10,000 RPD, Tier 1 1,500 RPM /
50,000 RPD, Tier 2+ unlimited RPD.
Free-tier traffic may be used by Google to improve its products — don't
send sensitive data on it.

## Testing

```sh
node test/run.mjs
```

34 cases run against a local mock upstream (no network, no real key):
config registration, state conversion, model normalization, noul criteria
key mapping, null-criteria fallback, question-id sanitizing round-trips
(including collisions and the 64-character limit), usage mapping, media
and assets conversion, the live models hook (pagination, `models/` prefix
stripping, decision-model filtering), auth header, error passthrough, 404
for unknown paths, and the export contract.

## License

MIT. The Gemini icon is from lobehub-icons (MIT).
