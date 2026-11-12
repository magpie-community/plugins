# 豆包工作 (Doubao Work)

Doubao Work runs its agent loop in ByteDance's cloud and has no API, so
there is no request to make on its behalf. This plugin uses its desktop
app, 豆包工作 (DoubaoWork), the way a person does instead, and gives what it
reads back as an OpenAI chat completion. 豆包 (Doubao), whose 工作任务 are the
same, works too:

1. It starts the app from a profile of its own (under
   `~/Library/Application Support/magpie-doubao-work` on macOS,
   `%LOCALAPPDATA%\magpie-doubao-work` on Windows; 豆包工作's in
   `doubaowork` there), with Chrome DevTools on a local port. Your everyday
   profile is not touched; you sign in once in this second window.

   The app is 豆包工作 when it is installed (`/Applications/DoubaoWork.app` or
   `~/Applications/DoubaoWork.app` on macOS,
   `%LOCALAPPDATA%\DoubaoWork\Application\app\DoubaoWork.exe` on Windows),
   else 豆包 (`Doubao.app`, `%LOCALAPPDATA%\Doubao\Application\app\Doubao.exe`).
   If you signed in to 豆包 through the plugin before 0.1.5, it stays on 豆包
   while 豆包 is installed.
2. Each request opens a new 工作任务, switches it from 本地电脑 to 云电脑
   (so Doubao's agent never reads or runs anything on your computer), picks
   the model, and writes the whole request (system prompt, tools, every
   turn) into the input as one message.
3. It reads the reply from the message Doubao renders, as it streams: the
   raw markdown, and the thinking as `reasoning_content`.
4. The client's tools are asked for as text, `<tool_call>{"name": …,
   "arguments": …}</tool_call>`, and given back as `tool_calls`.

Models: the plugin reads Doubao's own model menu, so whatever the app offers
is what magpie lists. The menu row text becomes the id: 自动 (`auto`), 豆包 2.1
Lite (`doubao-2.1-lite`), 豆包 2.1 Pro (`doubao-2.1-pro`, needs a paid Doubao
plan), DeepSeek V4.1 Flash (`deepseek-v4.1-flash`), GLM 5.3 (`glm-5.3`) and so
on. Rows that open a submenu (推理强度) are not models and are skipped.

The list is read when you sign in, and again on a request once the cached list
is more than six hours old, or at once when a request names a model the
cached list doesn't have (at most once a minute); it is kept in `models.json` under
`DOUBAO_WORK_HOME` (`~/Library/Application Support/magpie-doubao-work` on
macOS, `%LOCALAPPDATA%\magpie-doubao-work` on Windows) and read before
anything else. The three models the plugin was written with stay as the
fallback for when the menu cannot be read.

## What it costs

- **Unofficial.** It uses Doubao the way its own window does, but ByteDance
  may not like it. Use an account you can afford to lose.
- **On macOS, the app runs one copy at a time.** If you opened it
  yourself, quit it (⌘Q) first: the plugin's copy can't start beside it,
  and yours can't be driven (Chromium allows debugging only off the
  default profile). While the plugin's copy runs, opening Doubao brings up
  its window, which you can use as well. On Windows the plugin's copy runs
  beside yours, in a second window.
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
- macOS and Windows. Neither app has a Linux build.

## Settings

- `DOUBAO_WORK_APP`: the app's binary, if it is not in one of the places
  above. A path naming DoubaoWork is driven as 豆包工作, any other as 豆包.
- `DOUBAO_WORK_HOME`: where the profile and port live.

## Adding another cloud agent

`cdp.mjs` knows nothing about Doubao: it starts a Chromium-based desktop app
from its own profile and drives one page. `doubao.mjs` is everything that is
Doubao's: which buttons to press and where the reply is. `prompt.mjs` and
`openai.mjs` turn a chat request into one message and the reply back into a
completion. Another app built on Chromium or Electron needs only its own
`doubao.mjs`.
