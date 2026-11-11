# magpie-vertex-ai

A [magpie](https://usemagpie.ai) / OpenCode provider plugin for **Google Vertex AI**. Sign in with a service-account JSON (or Application Default Credentials) and the plugin exposes every model your GCP project can actually call — Gemini chat and image models, TTS, Veo video, Lyria music, embeddings, audio transcription, MaaS partner models (DeepSeek, Qwen, GLM, Kimi, MiniMax, gpt-oss, Grok, Gemma) and Claude — as one provider.

- Provider id: `vertex-ai`. Every model is addressed as `vertex-ai/<key>` (`vertex-ai/gemini-3.8-flash`, `vertex-ai/veo-3.1-generate-001`, ...).
- Pure ESM `.mjs`, no runtime dependencies, runs on Bun inside magpie's plugin host.
- How it works: magpie routes every request for the provider's models to the plugin's `fetch` at a sentinel base URL; the plugin maps the path to the right Vertex endpoint for the model family (`:streamGenerateContent`, `:rawPredict`, the OpenAI-compatible `endpoints/openapi` surface, ...), mints an OAuth access token from the stored credentials (scope `cloud-platform`), tries the model's serving regions in order, and streams the reply back in the protocol the agent speaks.

## Why `vertex-ai` and not `google-vertex`

`google-vertex` is the id of magpie's built-in Vertex preset (`magpie provider add google-vertex ...`). A plugin whose `auth.provider` equals a preset id is force-renamed by magpie (to `google-vertex-plugin`), which breaks model addressing and sign-in. `vertex-ai` is free. There is also no `vertex-ai` entry on models.dev, so the plugin declares the provider and its full model catalog itself in its `config` hook.

## Install

```sh
magpie plugin add github:HzTTT/magpie-vertex-ai
# or a local checkout: magpie plugin add /path/to/magpie-vertex-ai
magpie plugin login vertex-ai
```

## Sign in

### Method 1 — Service account / credentials JSON (recommended)

Three prompts:

1. **Credentials** — a path to a JSON file (e.g. `~/.config/gcp/vertex-sa.json`; `~` and `$VARS` are expanded) or the JSON itself pasted on one line. Leave empty to use `$GOOGLE_APPLICATION_CREDENTIALS`. Accepted shapes: `type: "service_account"` and `type: "authorized_user"` (a `gcloud auth application-default login` user file).
2. **GCP project id** — empty falls back to `project_id` in the credentials, then `quota_project_id`, then `$GOOGLE_CLOUD_PROJECT`.
3. **Region** — `auto` (recommended: each request uses the first region that serves the model) or a fixed Vertex region.

### Method 2 — Application Default Credentials

Reads `$GOOGLE_APPLICATION_CREDENTIALS`, else `~/.config/gcloud/application_default_credentials.json` (create it with `gcloud auth application-default login`). Same project and region prompts.

### What is stored, and token renewal

magpie saves the sign-in in its config folder (`~/.config/magpie`, or `$XDG_CONFIG_HOME/magpie`) in `plugin-auth.json` (mode 600, same shape as OpenCode's `auth.json`): the full credentials JSON text is kept in the account's `refresh` field, and the minted access token plus its expiry in `access` / `expires`. magpie renews the token through the plugin's `auth.refresh` hook before it runs out (5-minute lead); the hook mints a fresh token from the stored credentials, bypassing caches. Credentials Google no longer accepts (`invalid_grant`, ...) surface as an expired sign-in, so you know to log in again. Within a process, concurrent requests share one minted token per credentials identity (single-flight).

### Required IAM

- `roles/aiplatform.user` on the project (or an equivalent role with Vertex inference permissions).
- The **Cloud Text-to-Speech API** enabled for Chirp 3 HD voices — `chirp3-hd` calls `texttospeech.googleapis.com` directly, not Vertex.
- Claude models additionally require the project's billing account to be eligible for Anthropic models on Vertex; otherwise every request is rejected with Anthropic's terms-of-use error.

## Models

### Model families

| Family | Example models | How to call | What you get |
|---|---|---|---|
| Gemini chat | `gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-2.5-pro`, `gemini-2.5-flash` | chat, from any agent — magpie translates chat-completions / Responses / Anthropic requests into Gemini `streamGenerateContent`. A request that reaches the plugin as `/chat/completions` (e.g. `magpie provider test vertex-ai <model>`) goes to Vertex's OpenAI-compatible endpoint as `google/<id>` | streamed text, thinking and tool calls; attachments (image, audio, video, pdf) where the model takes them |
| Gemini image | `gemini-3-pro-image`, `gemini-nano-banana-2.1`, `gemini-2.5-flash-image`, `gemini-3.1-flash-image` | chat | the image is written to disk and the reply carries a markdown `![image](file:///...)` link plus the absolute path. Gemini-protocol agents additionally receive the raw `inlineData` part; magpie drops inline media for chat-completions, Anthropic and Responses clients, so there only the text link survives |
| Gemini TTS | `gemini-2.5-flash-tts`, `gemini-2.5-pro-tts`, `gemini-3.1-flash-tts-preview` | chat | a WAV file (Vertex returns 24 kHz PCM, wrapped in a RIFF header) with a `file://` link; voice via `ttsVoice` |
| Chirp 3 HD | `chirp3-hd` | chat | an MP3 from the global Cloud Text-to-Speech API; voice `chirpVoice`, language `chirpLanguage` (defaults to `en-US`, or `cmn-CN` when the prompt text is CJK) |
| Veo | `veo-3.1-generate-001`, `veo-3.1-fast-generate-001`, `veo-3.1-lite-generate-001`, `veo-3.0-generate-001`, `veo-3.0-fast-generate-001`, `veo-2.0-generate-001` | chat | an MP4 file with a `file://` link. The job is submitted with `:predictLongRunning` (a rejected job is an HTTP error), then polled; poll progress is emitted as reasoning text ("Veo generating... Ns") plus SSE keepalives so long generations do not time out. Attaching one image to the prompt sets the first frame, a second the last frame (Veo 3 only). Results returned as `gcsUri` are reported, not downloaded |
| Lyria | `lyria-002` | chat | a ~30-second instrumental WAV with a `file://` link. Lyria only accepts US-English prompts and its language check rejects short fragments ("calm lo-fi piano loop"); describe the music in a full sentence (genre, mood, instruments, tempo). Markdown and links are stripped from the prompt |
| Embeddings | `text-embedding-005`, `gemini-embedding-001`, `gemini-embedding-2`, `text-multilingual-embedding-002`, `multimodalembedding` | `POST /v1/embeddings` (OpenAI shape, `model` = the API id) | an OpenAI embeddings response: `data[].embedding` as floats, or base64 float32 with `encoding_format: "base64"`; `dimensions` / `task_type` are forwarded where the model takes them; inputs are batched (up to 250 per `:predict` for text-embedding models, 1 for `gemini-embedding-001` / `gemini-embedding-2` / `multimodalembedding`) with results in input order |
| Transcription | `gemini-3.5-transcribe-preview` for `json` and `text`; `srt`, `vtt` and `verbose_json` run on `gemini-2.5-flash`, because the transcribe-only model returns no timestamps | `POST /v1/audio/transcriptions` / `/v1/audio/translations`, multipart form (`file`, `model`, optional `language`, `prompt`, `temperature`, `response_format`) | an OpenAI transcript. `response_format`: `json` (default), `text`, `srt`, `vtt`, `verbose_json` — the timed formats get segments. Audio must be 15 MB or less (Vertex inline ceiling). `/translations` answers in English |
| MaaS partners | `deepseek-v3.2-maas`, `deepseek-r1-0528-maas`, `deepseek-ocr-maas`, `qwen3-coder-480b-a35b-instruct-maas`, `qwen3-235b-a22b-instruct-2507-maas`, `glm-5-maas`, `glm-5.2-maas`, `kimi-k2-thinking-maas`, `minimax-m2-maas`, `gpt-oss-120b-maas`, `grok-4.1-fast-reasoning`, `grok-4.20-non-reasoning`, `gemma-4-26b-a4b-it-maas` | chat (chat-completions protocol) | streamed completions via Vertex's OpenAI-compatible endpoint (`.../endpoints/openapi/chat/completions`); the request body is passed through unchanged except `model`, rewritten to `publisher/id` (and `stream_options.include_usage` defaulted when streaming) |
| Claude | `claude-opus-4-8`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-haiku-4-5@20251001`, `claude-opus-4-5@20251101`, `claude-3-opus@20240229` | chat with the Anthropic protocol (magpie sends `/messages`) | an Anthropic Messages reply via Vertex `:rawPredict` / `:streamRawPredict`; the plugin adds `anthropic_version: "vertex-2023-10-16"`, moves the `anthropic-beta` header into the `anthropic_beta` body field, and drops the `web_search_...` server tool magpie injects (Vertex does not offer it) |

Model keys never contain `/`: a MaaS key drops the publisher (`vertex-ai/deepseek-v3.2-maas` calls `deepseek-ai/deepseek-v3.2-maas`), and a versioned Claude id (`claude-opus-4-5@20251101`) gets the key `claude-opus-4-5`. Any model can also be addressed as `key@region` when region variants are enabled.

### Regions and discovery

- The built-in catalog (`lib/catalog.mjs`) lists each model's serving regions (Gemini 3.x and most MaaS models on `global`, Veo and Gemini 2.5 Pro on `us-central1`, Claude 3 Opus on `us-east5` / `europe-west1` / `europe-west4` / `asia-southeast1`, and so on).
- **Region failover**: per request the plugin tries the pinned region (when you called `key@region`), else the login region when the model serves there, else every catalog region in order (`global` first, then `us-central1`, then the rest). It moves on for 404 / 429 / 5xx, and for 400 / 403 bodies that say the model is not available or not servable in that region; otherwise the last upstream error is returned.
- **Background discovery**: on the first models listing the plugin probes, per project, which models the account can actually call. It lists every Vertex publisher in every serving region, then probes each model per region: `countTokens` for Gemini, `:embedContent` for `gemini-embedding-*` and `:predict` for other embeddings, a 1-token chat for MaaS, `count-tokens` for Claude, a metadata GET for Veo/Lyria, the voices list for Chirp. A region counts only on HTTP 200; 429/5xx are retried once. Because `countTokens` ignores model-level gates, each Gemini chat model then gets one 1-token `generateContent` (Gemini TTS: a one-word synthesis) in its first region. A model whose only failures were transient (quota 429, network, 5xx) is kept and marked `transient: true` rather than dropped: at its catalog regions when it is in the built-in catalog, otherwise at the regions that listed it. Verdicts are cached at `<magpie config>/vertex-ai/catalog-<project>.json` (written atomically). Most probes are free; the billed ones are tiny (1-token chats, single-word TTS, embedding probes). While enabled (`autoDiscover`), the file is refreshed in the background when missing or older than `discoverTtlHours`, and reloaded as soon as it changes. Only models the discovery proved callable, or kept as transient, are offered.
- **Manual discovery**: `bun scripts/discover.mjs --credentials <file> [--project <id>] [--dir <magpie config dir>]` (dir defaults to `$XDG_CONFIG_HOME/magpie` or `~/.config/magpie`). It prints a table of callable models with their regions and why unavailable models failed.

## Options

Set with `magpie plugin options magpie-vertex-ai '<json>'` (or Plugins -> Installed -> Options in the app). Defaults, as read by the code:

| Option | Default | Meaning |
|---|---|---|
| `include` | all models | Array of exact model keys or `/regex/` strings; only matching keys are offered |
| `exclude` | none | Same shape; matching keys are removed after `include` is applied |
| `regionVariants` | false | Also expose one `<key>@<region>` model per serving region of every model |
| `location` | `auto` | Preferred region when the login did not fix one; `auto` uses the first region that serves the model |
| `autoDiscover` | true | Start background catalog discovery when the cache file is missing or stale |
| `discoverTtlHours` | 24 | Cache age in hours after which discovery runs again |
| `mediaDir` | `<magpie config>/vertex-ai/media` | Where generated images, audio and video are written (created on demand) |
| `ttsVoice` | `Kore` | Prebuilt voice name for Gemini TTS models |
| `chirpVoice` | `Achernar` | Chirp 3 HD voice name; the request uses `<language>-Chirp3-HD-<chirpVoice>` |
| `chirpLanguage` | `en-US` (`cmn-CN` for CJK text) | BCP-47 language code for Chirp 3 HD |
| `veo.durationSeconds` | 8 | Clip length in seconds |
| `veo.aspectRatio` | `16:9` | Clip aspect ratio |
| `veo.resolution` | `720p` | Only sent to Veo 3+ models (Veo 2 rejects it) |
| `veo.generateAudio` | true | Only sent to Veo 3+ models |
| `veo.negativePrompt` | none | Forwarded as `negativePrompt` |
| `veoPollMs` | 10000 | Poll interval (ms) for the Veo operation |
| `veoTimeoutSec` | 900 | Seconds before the Veo poll gives up |
| `lyria.negativePrompt` | none | Forwarded as `negative_prompt` |

## Limitations

- magpie routes `/v1/images/generations` (and `/v1/images/edits`) and `/v1/videos` only to its built-in providers; a plugin's `fetch` never sees those endpoints. Imagen and Veo are therefore exposed as **chat models**. (Imagen is not included at all: no Imagen model was provisioned on the author's project, so the `:predict` path was never exercised.)
- magpie has no `/v1/audio/speech` endpoint, so TTS is exposed as chat models that return a file.
- Gemini Live / native-audio models (BidiGenerateContent over WebSocket) are not exposed: magpie has no WebSocket passthrough and `generateContent` rejects those models.
- Generated media is written to the local disk (`mediaDir`) and returned as `file://` links; nothing is uploaded anywhere, and the files are not cleaned up automatically. Inline media parts reach only Gemini-protocol agents (see the table above).
- `/v1/audio/transcriptions` and `/v1/audio/translations` need magpie v0.1.1233 or later; earlier gateways have no audio route and return 404.
- Catalog limits (context / output tokens) are best-effort values from Google's docs; where the docs publish nothing, defaults are used.
- A bare `magpie provider test vertex-ai` reports `codeassist 404 · has no endpoint`: magpie cannot send its Gemini (CodeAssist) probe to any plugin provider. Name models instead (`magpie provider test vertex-ai gemini-3.8-flash`); those go through `/chat/completions` and work.

## Development

```sh
bun test
```

Tests mock all upstream calls by passing a fake `ctx.fetch`; nothing hits the network.

To try the plugin against a live magpie without touching your own setup, run magpie in a sandbox (from the magpie plugin docs):

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add /path/to/magpie-vertex-ai
m plugin --json
m plugin login vertex-ai
m provider test vertex-ai
m provider test vertex-ai gemini-3.8-flash
```

## License

MIT

## 中文：安装与登录

- 安装：`magpie plugin add github:HzTTT/magpie-vertex-ai`（或本地文件夹路径）。提供者 id 为 `vertex-ai`，模型形如 `vertex-ai/gemini-3.8-flash`。
- 登录：`magpie plugin login vertex-ai`。方式一「Service account / credentials JSON」：输入凭据 JSON 的路径或整段 JSON（留空则读 `$GOOGLE_APPLICATION_CREDENTIALS`），GCP 项目 id（留空取凭据里的 `project_id`），区域（推荐 `auto`，自动选择首个可用区域）。方式二「Application Default Credentials」：使用 `gcloud auth application-default login` 生成的凭据，同样填项目和区域。
- 存储：magpie 把账号写入其配置目录（默认 `~/.config/magpie`）下的 `plugin-auth.json`（权限 600），凭据 JSON 全文存在账号的 `refresh` 字段，`access` / `expires` 存访问令牌；令牌到期前 5 分钟由 magpie 经 `auth.refresh` 自动续期。
- IAM：项目上需要 `roles/aiplatform.user`；使用 Chirp 3 HD 需启用 Cloud Text-to-Speech API；Claude 还要求结算账号有 Vertex 上的 Anthropic 使用资格。
- 选项：`magpie plugin options magpie-vertex-ai '{"include":["/^gemini-/"],"regionVariants":true}'`（`include`/`exclude` 写完整模型名或 `/正则/`）；后台发现会按项目缓存到 `<magpie 配置目录>/vertex-ai/catalog-<project>.json`（TTL 默认 24 小时），也可手动 `bun scripts/discover.mjs --credentials <文件>`。
