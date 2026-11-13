# magpie-gemini-media-tools

Gemini media tools MCP hook plugin for [Magpie](https://github.com/magpie-ai/magpie).

## Features

- `generate_image`: Nano Banana image generation
- `edit_image`: Nano Banana image editing with 1-4 local reference images
- `analyze_media`: Analyze local media or YouTube videos with video metadata support
- `speak_text`: Gemini TTS with OpenAI voice mapping
- Multi-key failover with 429/503 cooldown switching
- Full abort signal passthrough for Magpie's 55-second tool timeout

## Install

```sh
magpie plugin add qq136692547-cmyk/magpie-gemini-media-tools
```

## Configure

Set your Google AI Studio API key in Magpie settings. Multiple keys can be separated by commas, semicolons, or whitespace for automatic failover.

## Options

| Option | Default | Description |
|---|---|---|
| `apiKey` | `AIza...` | Google AI Studio API key(s) |
| `imageModel` | `gemini-nano-banana-2.1` | Model for image generation and editing |
| `mediaModel` | `gemini-3.8-flash` | Model for media analysis |
| `ttsModel` | `gemini-3.8-flash-tts` | Model for text-to-speech |
| `restrictToWorkspace` | `false` | Restrict local file access to workspace directory |

## Tools

### generate_image
Generate images from text prompts using Nano Banana.

### edit_image
Edit images by providing 1-4 local reference images along with a prompt.

### analyze_media
Analyze local media files or YouTube URLs. Supports `start_seconds`, `end_seconds`, and `fps` for video metadata. Files >15MB use the Files API for upload.

### speak_text
Convert text to speech using Gemini TTS. Supports OpenAI voice names (alloy, ash, etc.) which are mapped to Gemini voices.

## Test

```sh
npm test
```

## License

MIT
