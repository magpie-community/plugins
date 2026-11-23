# Gemini 网页版 (Gemini web app)

**This is not Google's Gemini API.** It is the Gemini web app,
gemini.google.com, on your Google account (or on none), used the way the
app's own page uses it. Text only; the client's tools are asked for as
text. Unofficial: Google can change or stop it at any time.

## How it works

1. **Sign in.** "在单独的浏览器窗口登录 Google 账号" opens Chrome (or Edge,
   Chromium, Brave) with a profile of the plugin's own, under
   `~/.config/magpie/gemini-web-browser/<id>` (`%LOCALAPPDATA%\magpie\gemini-web-browser`
   on Windows), at Google's sign-in page. You sign in there yourself; the
   plugin never sees your password. Once the profile holds Google's
   session cookies (`__Secure-1PSID`, `__Secure-1PSIDTS`), the plugin reads
   the google.com cookies through that browser's DevTools endpoint on
   127.0.0.1 and closes the window. Your everyday browser is not touched.

   "不登录使用" needs no account: Google then serves the model it gives
   visitors (3.5 Flash-Lite on 2026-11-19).
2. **Each request** is one POST to the app's own `StreamGenerate`
   endpoint, with the whole request (system prompt, tools, every turn)
   inline as one message, in a temporary chat, so nothing is kept in your
   Gemini history. The reply is read as it streams and given back as an
   OpenAI chat completion (SSE or whole). The page's tokens (`SNlM0e`,
   `cfb2h`, `FdrFJe`) are read from `/app` once and kept for 15 minutes,
   not fetched before every request.
3. **Tools** are asked for as `<tool_call>{"name": …, "arguments": …}</tool_call>`
   blocks and given back as `tool_calls`.
4. **Keeping the sign-in.** Cookies Google renews on its replies are saved
   back to the account. Every ten minutes the short-lived cookie is renewed
   the way the app's page does it (`RotateCookies`). When Google takes the
   cookies as signed out, the plugin renews them once more, and then opens
   the same profile again without a window, where Chrome renews them
   itself. Only when that fails too are you asked to sign in again.

## Models

Signed in, the list is your account's own model picker (the `otAQ7b` call
the page makes), named `gemini-` plus the picker's name: `gemini-auto`,
`gemini-3.6-flash`, `gemini-3.1-pro`, and whatever your plan shows. Before
it has been read the plugin offers Auto, 3.6 Flash and 3.1 Pro. A visitor
gets `gemini-auto` only.

Google decides what is served: on a free account Auto was served as
"4 Hydrogen" whichever model was asked for.

## Why it is faster than going through a local backend

There is no second process, no file upload and no retry sleep: one HTTPS
request per chat request, streamed straight back. Measured on 2026-11-19:
the first text came about 3.5 s after the request signed in (in the app's
own page), and 7 to 8 s as a visitor through this plugin (14 s for the
first request, which also reads the page). Most of that is Google's own
time to start answering.

## Limits

- Prompts over 600,000 characters are refused with HTTP 413 before they are
  sent. Measured: 315K characters were answered in full, 900K came back but
  ignored the request, and 1.8M was refused by Google (error 3).
- Google's refusal (error 3) also comes back when the model is not on your
  plan or requests come too fast; the message says so.
- Two requests at a time per account.
- Text only: images and files in a request are left out.

## Not tried

- A real Google sign-in through the plugin's window. The flow, the cookie
  read and the request are tested with Google's real replies; a sign-in
  itself was not made, and Google may refuse to sign in a browser that
  has a DevTools port open ("This browser or app may not be secure"). If
  it does, say so in an issue.
- Whether Chrome's device-bound sessions (DBSC) stop `RotateCookies`; the
  windowless renewal is there for that case.
- Thinking output and paid-plan models (4 Carbon, 4 Neon).

## Settings

- `GEMINI_WEB_BROWSER`: the browser to open, when it isn't found.
- `GEMINI_WEB_PROFILE`: where the plugin keeps its browser profiles.

---

## 中文

**这不是 Google 的 Gemini API**，而是 Gemini 网页版（gemini.google.com），按网页自己的方式调用。只支持文本，客户端的工具以文本方式调用。非官方，Google 随时可能改动。

- **登录**：在插件自己的 Chrome 配置（不影响你平时的浏览器）里，由你自己登录 Google 账号；插件不接触密码，登录后通过本机 127.0.0.1 的 DevTools 读取 google.com 的 Cookie 并关闭窗口。也可以不登录，以访客使用（目前是 3.5 Flash-Lite）。
- **请求**：每个请求是对网页版 `StreamGenerate` 的一次 POST，整段请求放进一条消息，用临时对话（不进 Gemini 历史），边生成边返回。页面令牌缓存 15 分钟，不会每次请求都去取。没有本地后端、没有文件上传、没有重试等待。
- **保持登录**：Google 回复里更新的 Cookie 会存回账号；每十分钟按网页的方式续期；失效时先续期，再无窗口地打开同一个配置让 Chrome 自己续期，都不行才请你重新登录。
- **模型**：登录后读取你账号自己的模型选择器（`otAQ7b`）。
- **限制**：超过 60 万字符的请求直接返回 413；每个账号同时两个请求；图片和文件不会发出。
- **没试过**：用插件的窗口真实登录 Google（Google 可能拒绝开着 DevTools 端口的浏览器登录，遇到请提 issue）；DBSC 是否会挡住续期；思考输出和付费模型。
