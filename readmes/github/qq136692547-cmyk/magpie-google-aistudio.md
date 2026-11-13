# magpie-google-aistudio

Google AI Studio provider plugin for [Magpie](https://github.com/magpie-ai/magpie).

## Features

- Official Google AI Studio API key provider
- Multi-key pool with round-robin rotation and 429/503 cooldown
- `thought_signature` cache with SSE streaming bypass capture
- OpenAI-compatible chat, embeddings, images, TTS and transcriptions
- Gemini 3.8 TTS, Gemini 3.5 Transcribe, Nano Banana image generation

## Install

```sh
magpie plugin add qq136692547-cmyk/magpie-google-aistudio
```

## Configure

Set your Google AI Studio API key in Magpie settings, or provide it per-request:

```json
{
  "apiKey": "YOUR_GOOGLE_AI_STUDIO_API_KEY"
}
```

Multiple keys can be comma, semicolon, or whitespace separated for automatic failover.

## Options

| Option | Default | Description |
|---|---|---|
| `thought_signature_cache` | `true` | Cache and auto-inject `thought_signature` for multi-turn tool calls |
| `strip_unsupported_params` | `true` | Remove OpenAI-only parameters that Gemini does not support |

## Test

```sh
npm test
```

## Live Test

Set `GOOGLE_AI_STUDIO_API_KEY` environment variable and run:

```sh
npm run test:live
```

## License

MIT

Inspired by [MoozIiSP/magpie-google-aistudio](https://github.com/MoozIiSP/magpie-google-aistudio).
