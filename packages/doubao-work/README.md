# 豆包工作 (Doubao Work)

Doubao Work runs its agent loop in ByteDance's cloud and has no API, so
there is no request to make on its behalf. This plugin uses the Doubao
desktop app the way a person does instead, and gives what it reads back as
an OpenAI chat completion:

1. It starts Doubao from a profile of its own (`~/Library/Application
   Support/magpie-doubao-work/profile`), with Chrome DevTools on a local
   port. Your everyday Doubao's profile is not touched; you sign in once
   in this second window.
2. Each request opens a new 工作任务, switches it from 本地电脑 to 云电脑
   (so Doubao's agent never reads or runs anything on your computer), picks
   the model, and writes the whole request (system prompt, tools, every
   turn) into the input as one message.
3. It reads the reply from the message Doubao renders, as it streams: the
   raw markdown, and the thinking as `reasoning_content`.
4. The client's tools are asked for as text, `<tool_call>{"name": …,
   "arguments": …}</tool_call>`, and given back as `tool_calls`.

Models: 自动 (`auto`), 豆包 2.1 Lite (`doubao-2.1-lite`) and 豆包 2.1 Pro
(`doubao-2.1-pro`, needs a paid Doubao plan).

## What it costs

- **Unofficial.** It uses Doubao the way its own window does, but ByteDance
  may not like it. Use an account you can afford to lose.
- **Doubao runs one copy at a time.** If you opened Doubao yourself,
  quit it (⌘Q) first: the plugin's copy can't start beside it, and yours
  can't be driven (Chromium allows debugging only off the default
  profile). While the plugin's copy runs, opening Doubao brings up its
  window, which you can use as well.
- **One request at a time.** There is one window.
- **Every request is a new task** in your Doubao history.
- **A request the client stops** stops being read, but Doubao finishes
  its task in the cloud anyway.
- **Slower** than an API: a task takes a few seconds to open, and the reply
  is read about seven times a second.
- **Text only.** Images and files in a request are left out.
- **Usage** is Doubao's own prompt count; the reply's tokens are estimated.
- **The DevTools port** is on 127.0.0.1 only, but any program on this
  computer can drive the signed-in Doubao window through it while it runs.
- macOS only for now.

## Settings

- `DOUBAO_WORK_APP`: the Doubao binary, if it is not at
  `/Applications/Doubao.app/Contents/MacOS/Doubao`.
- `DOUBAO_WORK_HOME`: where the profile and port live.

## Adding another cloud agent

`cdp.mjs` knows nothing about Doubao: it starts a Chromium-based desktop app
from its own profile and drives one page. `doubao.mjs` is everything that is
Doubao's: which buttons to press and where the reply is. `prompt.mjs` and
`openai.mjs` turn a chat request into one message and the reply back into a
completion. Another app built on Chromium or Electron needs only its own
`doubao.mjs`.
