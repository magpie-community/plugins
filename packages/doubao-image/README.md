# 豆包生图 (Doubao Images)

**This is not an image API.** Doubao has no image endpoint for other clients.
This plugin drives the 豆包 desktop app the way a person does — 对话 → 图像生成
on Seedream — and gives what comes back as an OpenAI image response.

It answers `/v1/images/generations` only. There is no chat here.

## How a picture is made

1. The plugin opens the app on its own profile (the same profile the
   `doubao-work` plugin uses, so one sign-in serves both).
2. It switches to 对话, opens a new conversation, presses 图像生成, and picks
   the drawing model (`Seedream 5.5`).
3. 比例 is left on 自动; the ratio a request asks for goes into the prompt
   (`画幅：9:16 竖版`), and Seedream follows it (`ratio: "9:16"` in its own
   parameters).
4. It reads `creation_block`'s `image_ori_raw` — the picture as drawn, with no
   watermark — and hands its URL back.

A request takes 20–30 seconds. The tool calls are cut off at 60 seconds by
magpie: a slow drawing runs on in the background, the call returns a job id,
and the next call (`image_result`) waits on the same drawing, so three calls
cover 180 seconds.

## Models

| id | what it draws with |
|---|---|
| `doubao-image` | Seedream 5.5 (豆包 2.1 Lite's image skill) |
| `doubao-image-pro` | the same skill; kept for clients that pick a second one |

Both answer `/v1/images/generations`; neither is a chat model.

## Using it

```bash
curl -X POST http://127.0.0.1:3425/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "doubao-image/doubao-image",
    "prompt": "雨后的江南小巷，青石板反光，暖色灯笼",
    "size": "1024x1792"
  }'
```

| field | meaning |
|---|---|
| `prompt` | what to draw |
| `prompts` | several pictures in one message: an array, each one a picture |
| `size` | becomes the ratio in the prompt; `1024x1792` is 9:16 |
| `n` | how many requests; each picture is one request |
| `response_format` | `url` (default) or `b64_json` |
| `user` | same value reuses one Doubao conversation, so a series keeps its style |
| `doubao_style` | extra style wording |

Anything else beats no key at all: `prompts` draws several pictures in one
message, which Doubao does in one reply.

## Tools

magpie offers these to every agent through its plugin tools MCP server:

| tool | what it does |
|---|---|
| `doubao-image_generate_image` | draws, waits up to 50 s, returns the URL (or a job id) |
| `doubao-image_image_result` | waits on a job id from the call above |

A chat model with no image output can therefore draw through them.

## Settings

| variable | default | meaning |
|---|---|---|
| `DOUBAO_IMAGE_MODE` | `chat` | `chat` draws in 对话 (its allowance); `work` uses a 工作任务 |
| `DOUBAO_IMAGES_FULL` | on | `0` skips the watermark-free copy and uses the watermarked one |
| `DOUBAO_WORK_APP` | found | the app's binary when it is somewhere unusual |
| `DOUBAO_WORK_HOME` | `~/Library/Application Support/magpie-doubao-work` | profile, port and the session map |

The conversation map is `image-sessions.json` in that folder: `user` values to
Doubao conversation ids.

## How this differs from `doubao-work`

Both plugins drive the same app, and magpie's market judges duplicates by
channel, so this is what makes this one a different channel:

| | `doubao-work` | this |
|---|---|---|
| What it serves | chat completions: text and tool calls | `/v1/images/generations`: pictures |
| Where it draws | a new 工作任务 per request, on 云电脑 | 对话 → 图像生成, on Seedream |
| Which allowance | the 工作任务 one | the 对话 one |
| Output | the reply's text | the picture's `image_ori_raw`, with no watermark |
| Same conversation across requests | no: every request is a new task | yes, when `user` names one |

A chat client that wants text should keep `doubao-work`; a script that wants
pictures should use this one.

## What it costs

- **Unofficial.** It uses Doubao the way its own window does, but ByteDance
  may not like it. Use an account you can afford to lose.
- **On macOS the app runs one copy at a time.** Quit your own 豆包 (⌘Q) before
  a request: the plugin's copy cannot start beside it. On Windows the plugin's
  copy runs beside yours.
- **One request at a time.** There is one window, and `doubao-work` shares it.
- **对话's free allowance** is what a picture draws from; the 工作任务
  allowance is not touched. When it runs out, Doubao says so and the error
  carries its words.
- **Slow** compared with an API: 20–30 seconds a picture, more for several.
- **The DevTools port** is on 127.0.0.1 only, but any program on this computer
  can drive the signed-in Doubao window through it while it runs.
- macOS and Windows. Neither app has a Linux build.

## Layout

`cdp.mjs` knows nothing about Doubao: it starts a Chromium-based desktop app
from its own profile and drives one page. `doubao.mjs` is everything that is
Doubao's: which buttons to press and where the picture is. `prompt.mjs` writes
the message, `index.mjs` answers in OpenAI's image shape.
