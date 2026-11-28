# 豆包工作 (Doubao Work)

**This is not a model API.** Doubao Work has no model interface for other
clients. An agent that picks a `doubao-work/*` model gets one run of
Doubao's cloud agent: the request is flattened into one message, Doubao
plans and uses its own tools, and the client's tool calls are read back
from text. One request at a time, text only.

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

   An app installed somewhere else (`D:\Apps\DoubaoWork`, an external disk)
   is found without setting anything: on Windows from its uninstall entry,
   its App Paths entry or a running copy; on macOS from Spotlight, a running
   copy, or one folder down in `/Applications`, `~/Applications` and
   `/Volumes/*`.
2. Each request opens a new 工作任务, switches it from 本地电脑 to 云电脑
   (so Doubao's agent never reads or runs anything on your computer), picks
   the model, and writes the whole request (system prompt, tools, every
   turn) into the input as one message.
3. It reads the reply from the message Doubao renders, as it streams: the
   raw markdown, and the thinking as `reasoning_content`.
4. The client's tools are asked for as text, `<tool_call>{"name": …,
   "arguments": …}</tool_call>`, and given back as `tool_calls`.

Models: the plugin reads the 工作任务 model list from Doubao itself (the
`brief_list` request the app's own page makes, through the app's page), so
whatever 工作任务 offers is what magpie lists. Before 0.1.10 it read the menu
of whatever page was open, and on 豆包's 对话 page that menu is 快速 and 专家,
which 工作任务 doesn't have. A list cached from that menu is read again. The
name becomes the id: 自动 (`auto`), 豆包 2.1 Lite (`doubao-2.1-lite`), 豆包 2.1
Pro (`doubao-2.1-pro`), DeepSeek V4.1 Flash (`deepseek-v4.1-flash`), GLM 5.3
(`glm-5.3`) and so on. A request may also name a model by Doubao's own key
(`person-deepseek-v4-1-flash-261017`) or by its name (`DeepSeek V4.1 Flash`).
When `brief_list` can't be read, the plugin opens a 工作任务 and reads its
model menu instead.

推理强度: each model's levels are offered as variants, and the client's
`reasoning_effort` (or `reasoning.effort`) picks one: `low` 低, `medium` 中,
`high` 高, `xhigh` 极高, `max` 最高. A level the model lacks goes to the
nearest one it has (a tie goes higher). With no effort asked, the model's own
default level is picked, not the one the last request left the app on.

The list is read when you sign in, and again on a request once the cached list
is more than six hours old, or at once when a request names a model the
cached list doesn't have (at most once a minute); it is kept in `models.json` under
`DOUBAO_WORK_HOME` (`~/Library/Application Support/magpie-doubao-work` on
macOS, `%LOCALAPPDATA%\magpie-doubao-work` on Windows) and read before
anything else. The three models the plugin was written with stay as the
fallback for when no list can be read.
A list never read (an account that signed in before the plugin read menus) is
read when magpie lists the models, once a minute at most, and only from a
window already open: listing models or reading usage never starts the app,
only a request does. A `models.json` from an older version keeps its models
until the list is read again. Rows whose names differ only in Chinese get
distinct ids: Kimi K3.1 Pro 高速 is `kimi-k3.1-pro-fast`.

Third-party models you added to 豆包工作 yourself (your own API key) are not
served here: the plugin lists only what the app's model menu offers from
Doubao's side, and a model that runs on your own key is a direct call to that
vendor, not a Doubao task. Add that API to magpie as its own provider instead.

## Plan allowance (额度)

The plugin reads the account's allowance from the app's own page
(`/alice/commerce/sale/subscription/quota/summary/`, the call its 订阅 view
makes), so the Usage card shows what Doubao itself shows.

Doubao splits an allowance into sections, and any of them can be the whole of
it: a paid plan's limits are in `window_limit_section`, an enterprise plan's in
`enterprise_window_limit_section`, and the gift quota of Doubao's campaigns
(活动赠送额度 — what a free account has) in `incentive_quota_section`. The
plugin reads every section with window limits, so a free account's allowance is
listed too; a window names its span when the reply gives one (5 小时 / 每周 /
本月) and is otherwise named as Doubao names the group (活动赠送额度). With the
app's query beside the call Doubao also answers the amounts, so a window shows
已用 / 总量 ("1,400 / 2,600 额度") and when it resets.

## Daily check-in (签到)

Doubao decides per account whether it offers a 签到, and it has moved between
two surfaces, so the plugin asks both:

1. The desktop app's own **每日签到** task (`daily_signin`) of its PC incentive
   campaign (`pc_incentive_task_mvp_v3`). One read of
   `/alice/ug/campaign/v3/detail/` says whether today is already in
   (`daily_checkin.checked_in_today`) and what the streak is; a press of
   `/alice/ug/campaign/landing/checkin` claims it.
2. The landing page of the growth campaign (豆包探索计划), for the accounts
   Doubao still shows it to: `/alice/ug/campaign/landing/get` says what to show,
   and a 签到 button there reports the press (`landing/report`) and checks in.
   That report is the landing page's own instrumentation, so it goes out only
   there; the campaign's 每日签到 is not a landing page and its press is the
   check-in alone.

A press is idempotent: a second one the same day answers `checked_in` with
`idempotent: true` and the day's reward, so a check-in magpie isn't sure it made
claims nothing twice, and magpie reports that answer as done rather than claimed.

- Turn it on in magpie: Settings → Usage → Plugins → 豆包工作 → Daily check-in
  (off by default). magpie then checks each account in once a Beijing day;
  *Check in now* on the account's Usage card does it at once.
- Answers: `claimed` with the streak (连续签到天数) and the reward Doubao says it
  granted, `done` when today's check-in is already in (with the streak and what
  it gave), `inactive` when Doubao offers this account no 签到 now, `failed`
  with Doubao's own words.
- Like usage, it runs only in a window already open: a check-in never starts
  the app. With the window closed it fails and magpie asks again later.
- Doubao has no make-up check-in (补签): its app has no such request, so
  there is nothing to press for a missed day.
- Every `/alice/` call carries the common query the app puts on its own calls
  (version_code, aid, device_id, runtime_version, fp…). The plugin sends the
  app's own query, read off a call the page made. A window that has only just
  opened has made none, and the page keeps no `runtime_version` anywhere, so
  there is nothing truthful to build it from: the plugin waits a moment for
  the app's first call, and a campaign detail read before that — Doubao
  answers a request without `runtime_version` with a reduced task list, not
  this account's — is reported as a failure to try again, never as `inactive`.
  An `/alice/` call with no query at all is answered `系统错误`（the app's own
  request-missing answer）.
- The press on a day not yet checked in has not been seen against a real
  account: the account this was written on was already checked in when it was
  fixed, so only the idempotent answer was seen live, and the shapes a press
  comes in are the tests'.

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
- **A spent allowance** is not an answer. Doubao says it as an ordinary
  reply (「本月额度已用完，下个月恢复为你服务。升级到标准套餐畅享更多额度。
  升级正式订阅」, or 本周 / 今日 for a shorter window); a reply that is that
  notice and nothing else is answered as a 429 with Doubao's words, so magpie
  rests the account and asks the next one. When it says when it is back
  (下个月, 下周, 明天), the 429 says that time too, on Beijing's clock, as
  `resets_at` and `Retry-After`. A stream holds back a reply that begins like
  the notice until it is either the notice or an answer.
- **The DevTools port** is on 127.0.0.1 only, but any program on this
  computer can drive the signed-in Doubao window through it while it runs.
- macOS and Windows. Neither app has a Linux build.

## Settings

- `DOUBAO_WORK_APP`: the app's binary, if it is not in one of the places
  above and the system does not know it. A path naming DoubaoWork is driven as 豆包工作, any other as 豆包.
- `DOUBAO_WORK_HOME`: where the profile and port live.

## Adding another cloud agent

`cdp.mjs` knows nothing about Doubao: it starts a Chromium-based desktop app
from its own profile and drives one page. `doubao.mjs` is everything that is
Doubao's: which buttons to press and where the reply is. `prompt.mjs` and
`openai.mjs` turn a chat request into one message and the reply back into a
completion. Another app built on Chromium or Electron needs only its own
`doubao.mjs`.
