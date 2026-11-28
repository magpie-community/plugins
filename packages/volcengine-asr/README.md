# Volcengine ASR for magpie

[中文](README.zh-CN.md)

Speech-to-text with Volcengine Doubao ASR (火山引擎 豆包语音识别) on magpie's
OpenAI-compatible `POST /v1/audio/transcriptions`, signed in with your own
Volcengine Speech API key. Any OpenAI client or SDK that transcribes audio
works through magpie with it.

```sh
magpie plugin add @magpie-community/opencode-volcengine-asr-auth
magpie plugin login volcengine-asr      # paste your API key
```

The key is a Volcengine console **API Key** (豆包语音 › API Key) with the
resources you use enabled. magpie keeps it with its other sign-ins; the plugin
sends it only to `openspeech.bytedance.com`, and never puts it in an answer.
Needs magpie with `/v1/audio/transcriptions` (v0.1.1602 or later).

## Models

| Model | Volcengine resource | How it is called | Audio |
|---|---|---|---|
| `volcengine-asr/bigasr-flash` | `volc.bigasr.auc_turbo` (录音文件识别极速版) | a standard upload, one call | up to 2 h, 100 MB; WAV, MP3, OGG Opus |
| `volcengine-asr/seed-asr-2.0` | `volc.seedasr.auc` (录音文件识别模型 2.0) | a job by URL (below) | up to 5 h, 512 MB; WAV, MP3, OGG |
| `volcengine-asr/bigasr-1.0` | `volc.bigasr.auc` (录音文件识别模型 1.0) | a job by URL (below) | as above |

Each resource must be enabled for your key in the Volcengine console.

## Upload a file: `bigasr-flash`

A standard OpenAI request:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3425/v1", api_key="<magpie gateway key>")
result = client.audio.transcriptions.create(
    model="volcengine-asr/bigasr-flash",
    file=open("meeting.mp3", "rb"),
    response_format="verbose_json",   # json (default), text or verbose_json
    language="zh",                    # optional: ISO 639-1, or a locale such as zh-CN
)
print(result.text)
```

`verbose_json` gives `segments` with `start` and `end` in seconds and the
`speaker` Volcengine assigned. Instead of `file`, a form may send `audio_url`
(https) for Volcengine to download. Silent audio is an empty transcript.

## Long audio: `seed-asr-2.0` and `bigasr-1.0`

These editions take an audio URL and run as a job that can take minutes,
longer than magpie gives one call (three minutes). So each step is its own
call to `/v1/audio/transcriptions`, a multipart form naming it in
`volc_operation`:

| `volc_operation` | Other fields | Answer |
|---|---|---|
| `submit` | `volc_task_id` (a lowercase UUID you make), `audio_url` (https), `audio_format` (`raw`, `wav`, `mp3`, `ogg`), optional `language` | `{"object": "volcengine.asr.task", "task_id", "status": "submitted"}` |
| `query` | `volc_task_id` | `status` is `processing`, `queued`, `silent` or `completed`; a completed task carries Volcengine's own result as `payload` (text, utterances with speaker, language, emotion, gender, speech rate and volume) |
| `readiness` | none | `{"object": "volcengine.asr.readiness", "ready", "provider_status", "reason"}`: whether Volcengine accepts the key for this model's resource |

```sh
curl http://127.0.0.1:3425/v1/audio/transcriptions -H "Authorization: Bearer $KEY" \
  -F model=volcengine-asr/seed-asr-2.0 -F volc_operation=submit \
  -F volc_task_id=$(uuidgen | tr A-Z a-z) -F audio_url=https://example.com/meeting.mp3 -F audio_format=mp3
# then, every second or so, the same task id with -F volc_operation=query
```

Volcengine downloads the audio itself, so it never passes through magpie. An
upload sent to these models is answered 400 with how to call them.

## Errors

A malformed request is 400 before Volcengine is asked. Volcengine's refusal
is 502 with its status code and message in the error (for example
`status=45000006` when it could not download the audio); Volcengine out of
reach is 502 `transport_error`. Requests to anything but
`/audio/transcriptions` are 404.

## Test

```sh
node --test test.mjs
```
