# magpie-breeze-blue

## 1. What it is

`magpie-breeze-blue` is a [Breeze Blue](https://breezeblue.ai/) TTS provider plugin for Magpie. It turns Magpie gateway's OpenAI-compatible `POST /v1/audio/speech` requests into Breeze's [`/v1/text-to-speech/{voice_id}`](https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech) requests, and shows the Breeze balance on Magpie's provider card and usage through `auth.usage`.

- provider id: `breeze`
- display name: `BreezeBlue`
- models: listed from Breeze's `/v1/models` (currently `breeze-tts-2` and `breeze-tts-2-multilingual`), each with `text` input and `audio` output; falls back to the `breeze-tts-2` declaration when there is no API key or the vendor list cannot be read (request failure, non-2xx, unparsable or empty payload)
- UI copy: `en` / `zh` / `zh-TW` / `ja` / `de`, falling back to English
- only network target: `https://api.breeze.blue`
- icon: `magpie.icon` points to BreezeBlue's official `https://breezeblue.ai/favicon.png`; it is not bundled here. The icon belongs to BreezeBlue; remove the field or use your own icon if the vendor objects.
- README languages: `README.md` (English), `README.zh-CN.md`, `README.zh-TW.md`, `README.ja.md`, `README.de.md`

## 2. Installation

Run this in the project folder:

```bash
magpie plugin add ./            # local folder
# or after publishing: magpie plugin add magpie-breeze-blue
magpie plugin login breeze
```

Enter your [Breeze API key](https://docs.breezeblue.ai/authentication) (`brz_…`). Magpie keeps the key; nothing is written into this project.

## 3. Using `/v1/audio/speech`

Magpie's gateway listens on `http://127.0.0.1:3425` by default. `breeze/breeze-tts-2` is declared audio-only, so it does not appear in `/v1/models` or Magpie's chat model picker; `/v1/audio/speech` still resolves it by `provider/model`. The body is OpenAI TTS-compatible:

```json
{
  "model": "breeze/breeze-tts-2",
  "input": "Good night.",
  "voice": "voc_...",
  "response_format": "mp3",
  "instructions": "Say it softly.",
  "speed": 1.05
}
```

`voice` must be a real [Breeze voice id](https://docs.breezeblue.ai/api-reference/voices/list-voices) (`voc_…`) in your account; this project hardcodes no user's voice.

The matching `curl`:

```bash
curl http://127.0.0.1:3425/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"model":"breeze/breeze-tts-2","input":"Good night.","voice":"voc_...","response_format":"mp3","instructions":"Say it softly.","speed":1.05}' \
  --output out.mp3
```

### 3.1 Parameters

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `model` | yes | — | Model id, e.g. `breeze/breeze-tts-2-multilingual`; a `provider/` prefix is ignored and the remaining id is sent as Breeze's `model_id` |
| `input` | yes | — | Text to read; a blank string returns 400 |
| `voice` | yes | — | Breeze voice id, e.g. `voc_...`; URL-path encoded |
| `response_format` | no | `mp3` | See 3.2 for the mapping; unknown values use `mp3` |
| `speed` | no | `1` | Clamped to 0.5–2; not sent when 1 |
| `instructions` | no | not sent | Tone or emotion instructions |
| `language_code` | no | `zh` | Breeze extension, two-letter ISO 639-1 code |
| `model_id` | no | from `model` | Breeze extension; overrides `model` |
| `guidance_scale` | no | `1` | Breeze extension, clamped to 1–10; not sent when 1 |
| `use_speaker_boost` | no | `false` | Breeze extension; sent only when `true` |

`voice_settings` appears in the Breeze request body only when `speed`, `guidance_scale`, or `use_speaker_boost` has a non-default value.

### 3.2 Format mapping

| `response_format` | Breeze `output_format` |
| --- | --- |
| `mp3` | `mp3` |
| `wav` | `wav_24000` |
| `opus` | `opus` |
| `aac` | `aac_24000_128` |
| `flac` | `flac_24000` |
| `pcm` | `pcm_24000` |
| other values | `mp3` |

On success the plugin returns Breeze's audio bytes and `content-type` unchanged; it defaults to `audio/mpeg` when Breeze gives none.

### 3.3 Errors

When Breeze returns `{code, detail, error}`, the plugin keeps the HTTP status and converts the body to OpenAI's shape:

```json
{
  "error": {
    "message": "voice not found",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_voice"
  }
}
```

Local validation failures return 400; paths other than `/v1/audio/speech` return 404; methods other than POST return 405. No error ever puts the API key into a message or log.

## 4. Balance

`auth.usage` requests Breeze [`GET /v1/balance`](https://docs.breezeblue.ai/api-reference/account/get-account-balance) and returns a Magpie wallet window:

```js
{
  plan: 'BreezeBlue',
  windows: [{ name: 'Balance', balance: 1635.6, unit: 'Credits' }]
}
```

When `settlement_pending` is `true`, the window carries `aside: true` so routing does not treat it as an allowance that runs out immediately. A failed read returns `windows: []` and an `error` string; nothing is thrown to Magpie.

The balance appears only on Magpie's provider card and usage. The usage card also shows a daily-credits window pointing at [`breezeblue.ai/app`](https://breezeblue.ai/app) for manual claiming.

### 4.1 UI languages

- `Balance`, `Credits`, and `Manual` are Magpie's English canonical names, translated by Magpie into the current UI language; `display` stays a language-neutral URL.
- `auth.methods[].labels` provides sign-in copy for `zh`, `zh-TW`, `ja`, and `de`; other languages fall back to the English `label`.
- `magpie.summary` provides the plugin summary for `en`, `zh`, `ja`, and `de`; Magpie's Discover card selects by two-letter language code, so `zh-TW` falls back to `zh`.

## 5. Network and security

- The plugin talks only to `https://api.breeze.blue`: `/v1/text-to-speech/{voice_id}`, `/v1/models`, and `/v1/balance`.
- The custom `fetch` handles only `/v1/audio/speech`; every other path returns a JSON error and is never forwarded to Breeze.
- Requests to Breeze carry only Breeze's `xi-api-key`; headers such as Magpie's `authorization` are not forwarded.
- The API key never appears in logs, error messages, or response bodies.
- The package has no npm runtime dependencies.

## 6. Compatibility

Developed and verified against Magpie `0.1.4280` and its plugin interfaces (`config` / `auth.loader` / `auth.usage` / `provider.models`); older versions are unverified.

The test runner requires Node.js 18 or newer; the plugin itself runs in Magpie's plugin host.

## 7. Development and tests

```bash
node --test
```

The tests use `node:test` and inject `fetchImpl` to cover request mapping, error pass-through, and balance parsing without touching the real Breeze network.

## 8. License

MIT, see `LICENSE`.
